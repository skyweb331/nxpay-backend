import { Service } from 'typedi';
import { and } from '@prisma/orm-postgres/orm-client';

import {
  PrismaService,
  lockKey,
  toJson,
  type TransactionRow,
  type VirtualAccountRow,
} from '#src/service/prisma.js';
import type { BridgeVirtualAccountEvent, BridgeWebhookEvent } from '#src/service/bridge/index.js';
import { MailerService } from '#src/service/mailer.js';
import { QueueService } from '#src/service/queue.js';
import { FiatCurrency, TransactionEventSource, TransactionState } from '#src/graphql/enum.js';
import { VirtualAccountService } from '#src/entity/virtualAccount/virtualAccount.service.js';
import { MonthlyVolumeService } from '#src/entity/monthlyVolume/monthlyVolume.service.js';
import { FxRateService } from '#src/entity/fee/fxRate.service.js';
import { stateForVirtualAccountEvent } from '#src/state/transaction.stateMachine.js';
import type { WebhookOutcome } from '#src/webhook/dispatcher.js';
import { isSqlError } from '#src/utils/errors.js';
import { generateReference } from '#src/utils/reference.js';
import { decimalToCents, formatMoney, multiplyByDecimal } from '#src/utils/money.js';
import { periodKeyOf } from '#src/utils/period.js';

import { TransactionService, type TransactionPatch } from './transaction.service.js';

export const PROCESS_DEPOSIT = 'process-deposit';

const ACCOUNT_EVENTS = new Set(['account_update', 'deactivation', 'activation']);
const RAIL_LABEL: Record<string, string> = {
  ach_push: 'ACH',
  ach: 'ACH',
  wire: 'Wire',
  sepa: 'SEPA',
};

const cents = (value?: string | null, round: boolean | 'floor' = true) =>
  value === undefined || value === null || value === '' ? null : decimalToCents(value, { round });

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/**
 * Bridge labels some as `microdeposit`; others arrive as ordinary funds_* activity
 * carrying the NACHA `ACCTVERIFY` entry description, always under $1.
 */
const isMicrodeposit = (activity: BridgeVirtualAccountEvent) => {
  const amount = cents(activity.amount);
  if (amount === null) return false;
  if (activity.type === 'microdeposit') return true;
  const description = text(activity.source?.['description']) ?? '';
  return amount < 100n && /\bACCTVERIFY\b/i.test(description);
};

/** Later stages win, so out-of-order delivery can't move a deposit back to scheduled. */
const statusRank = (type: string) =>
  ({ funds_scheduled: 0, in_review: 1, funds_received: 2, microdeposit: 2 })[type] ?? 3;

type AfterCommit = () => Promise<unknown> | unknown;

/**
 * Bridge virtual account activity -> Transaction. Events arrive from webhooks, the
 * history poller and the sandbox tool, possibly twice and out of order, so each one
 * is applied once per (deposit, type) under a per-deposit advisory lock.
 */
@Service()
export class DepositService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly virtualAccounts: VirtualAccountService,
    private readonly volumes: MonthlyVolumeService,
    private readonly fx: FxRateService,
    private readonly mailer: MailerService,
    private readonly queue: QueueService
  ) {}

  /**
   * One row per deposit: the scheduled and received activities have different ids
   * but share the ACH trace number, so later activities update the status.
   */
  private async recordMicrodeposit(
    va: VirtualAccountRow,
    activity: BridgeVirtualAccountEvent
  ): Promise<WebhookOutcome> {
    const amount = cents(activity.amount)!;
    const source = activity.source ?? {};
    const traceNumber = text(source['trace_number']);
    const arrival = text(source['estimated_arrival_date']);

    return this.prisma.transaction(async () => {
      await this.prisma.advisoryXactLock(
        lockKey(`microdeposit:${va.id}:${traceNumber ?? activity.id}`)
      );
      const existing = await this.prisma.orm.Microdeposit.where((m) =>
        traceNumber
          ? and(m.virtualAccountId.eq(va.id), m.traceNumber.eq(traceNumber))
          : m.bridgeActivityId.eq(activity.id)
      ).first();

      if (existing) {
        if (statusRank(activity.type) < statusRank(existing.status)) return 'ignored';
        await this.prisma.orm.Microdeposit.where({ id: existing.id }).update({
          status: activity.type,
          estimatedArrivalDate: activity.type === 'funds_scheduled' ? arrival : null,
        });
        return 'processed';
      }

      await this.prisma.orm.Microdeposit.create({
        bridgeActivityId: activity.id,
        virtualAccountId: va.id,
        customerId: va.customerId,
        amountInCents: amount,
        currency: (activity.currency ?? String(va.sourceCurrency)).toLowerCase(),
        paymentRail: text(source.payment_rail),
        senderName: text(source['sender_name']),
        description: text(source['description']),
        traceNumber,
        status: activity.type,
        estimatedArrivalDate: activity.type === 'funds_scheduled' ? arrival : null,
        occurredAt: activity.created_at ? new Date(activity.created_at) : new Date(),
      });
      return 'processed';
    });
  }

  handleWebhook(event: BridgeWebhookEvent<BridgeVirtualAccountEvent>): Promise<WebhookOutcome> {
    return this.handleActivity(event.event_object);
  }

  async handleActivity(activity: BridgeVirtualAccountEvent): Promise<WebhookOutcome> {
    const va = activity?.virtual_account_id
      ? await this.virtualAccounts.getByBridgeId(activity.virtual_account_id)
      : null;
    if (!va) {
      console.warn(
        `[deposit] activity ${activity?.id} for unknown virtual account ${activity?.virtual_account_id}`
      );
      return 'ignored';
    }

    if (ACCOUNT_EVENTS.has(activity.type)) {
      const customer = await this.prisma.orm.Customer.where({ id: va.customerId }).first();
      if (customer?.bridgeCustomerId)
        await this.virtualAccounts.refresh(va, customer.bridgeCustomerId);
      return 'processed';
    }
    // Bank account verification deposits are recorded but never become transactions
    if (isMicrodeposit(activity)) return this.recordMicrodeposit(va, activity);
    if (!activity.deposit_id) return 'ignored';

    // EUR volume is converted at funds_received time; fetch outside the DB transaction
    const fxRate =
      va.sourceCurrency === FiatCurrency.eur &&
      (activity.type === 'funds_received' || activity.type === 'payment_processed')
        ? await this.fx.eurToUsd()
        : null;

    const after: AfterCommit[] = [];
    const outcome = await this.prisma.transaction(async () => {
      await this.prisma.advisoryXactLock(lockKey(`deposit:${activity.deposit_id}`));
      const tx = await this.findOrCreate(va, activity);
      if (await this.transactions.hasEvent(tx.id, TransactionEventSource.bridge_va, activity.type))
        return 'ignored';
      await this.transactions.recordEvent(
        tx.id,
        TransactionEventSource.bridge_va,
        activity.type,
        activity
      );
      await this.apply(tx, activity, fxRate, after);
      return 'processed' as const;
    });
    for (const fn of after) await fn();
    return outcome;
  }

  private async findOrCreate(
    va: VirtualAccountRow,
    activity: BridgeVirtualAccountEvent
  ): Promise<TransactionRow> {
    const existing = await this.transactions.getByDepositId(activity.deposit_id!);
    if (existing) return existing;
    const gross = cents(activity.amount) ?? cents(activity.receipt?.initial_amount) ?? 0n;
    try {
      return await this.prisma.orm.Transaction.create({
        reference: generateReference('NXP'),
        customerId: va.customerId,
        virtualAccountId: va.id,
        bridgeDepositId: activity.deposit_id!,
        rail: activity.source?.payment_rail ?? null,
        currency: va.sourceCurrency,
        grossAmountInCents: gross,
        state: TransactionState.Received,
        sourceDetails: activity.source ? toJson(activity.source) : null,
      });
    } catch (error) {
      if (!isSqlError(error, '23505')) throw error;
      return (await this.transactions.getByDepositId(activity.deposit_id!))!;
    }
  }

  private fundsReceivedPatch(
    tx: TransactionRow,
    activity: BridgeVirtualAccountEvent,
    fxRate: string | null
  ) {
    if (tx.fundsReceivedAt) return {};
    const at = activity.created_at ? new Date(activity.created_at) : new Date();
    const gross =
      tx.grossAmountInCents > 0n ? tx.grossAmountInCents : (cents(activity.amount) ?? 0n);
    const usd =
      tx.currency === FiatCurrency.eur && fxRate
        ? { usdEquivalentInCents: multiplyByDecimal(gross, fxRate), fxRate }
        : { usdEquivalentInCents: gross, fxRate: null };
    return { fundsReceivedAt: at, periodKey: periodKeyOf(at), grossAmountInCents: gross, ...usd };
  }

  private async apply(
    tx: TransactionRow,
    activity: BridgeVirtualAccountEvent,
    fxRate: string | null,
    after: AfterCommit[]
  ) {
    const target = stateForVirtualAccountEvent(activity.type);
    let patch: TransactionPatch = {};

    switch (activity.type) {
      case 'funds_scheduled':
        patch = { rail: tx.rail ?? activity.source?.payment_rail ?? null };
        break;
      case 'funds_received':
        patch = {
          ...this.fundsReceivedPatch(tx, activity, fxRate),
          rail: activity.source?.payment_rail ?? tx.rail,
          ...(activity.source && { sourceDetails: toJson(activity.source) }),
        };
        after.push(() => this.notifyReceived(tx.id, activity.receipt?.url));
        break;
      case 'payment_submitted':
        break;
      case 'payment_processed': {
        const receipt = activity.receipt ?? {};
        const credited =
          cents(receipt.final_amount, 'floor') ??
          cents(activity.subtotal_amount, 'floor') ??
          cents(activity.amount, 'floor');
        patch = {
          ...this.fundsReceivedPatch(tx, activity, fxRate),
          creditedAmountInCents: credited,
          exchangeFeeInCents: cents(receipt.exchange_fee) ?? cents(activity.exchange_fee_amount),
          creditedAt: activity.created_at ? new Date(activity.created_at) : new Date(),
        };
        after.push(() =>
          this.queue.sendSafe(
            PROCESS_DEPOSIT,
            { transactionId: tx.id },
            { singletonKey: `deposit-${tx.id}`, group: { id: `customer-${tx.customerId}` } }
          )
        );
        break;
      }
      case 'in_review':
        patch = { failureReason: 'Under compliance review' };
        break;
      case 'refund_in_flight':
        patch = {
          failureReason: `Refund in progress${activity.refund?.reason ? `: ${activity.refund.reason}` : ''}`,
        };
        break;
      case 'refund_failed':
        patch = {
          failureReason: `Refund failed${activity.refund?.reason ? `: ${activity.refund.reason}` : ''}`,
        };
        after.push(() =>
          this.mailer.opsAlert('Bridge refund failed', [
            `Transaction ${tx.reference} (deposit ${tx.bridgeDepositId}) refund failed.`,
            activity.refund?.reason ?? '',
          ])
        );
        break;
      case 'refunded':
        patch = { failureReason: activity.refund?.reason ?? 'Refunded to sender' };
        // A counted fee is only possible if the refund raced fee calculation
        if (tx.feeInCents !== null && tx.periodKey && tx.usdEquivalentInCents) {
          const counted = tx.feeBreakdown as { feeUsdInCents?: string } | null;
          await this.volumes.apply(
            tx.customerId,
            tx.periodKey,
            -tx.usdEquivalentInCents,
            -BigInt(counted?.feeUsdInCents ?? '0'),
            -1
          );
        }
        break;
      default:
        break;
    }
    if (target) patch.state = target;

    const updated = await this.transactions.update(tx, patch);
    if (!updated) throw new Error(`Transaction ${tx.id} changed concurrently`);
  }

  private async notifyReceived(transactionId: string, receiptUrl?: string) {
    const tx = await this.transactions.getById(transactionId);
    if (!tx) return;
    const customer = await this.prisma.orm.Customer.where({ id: tx.customerId }).first();
    const user = customer
      ? await this.prisma.orm.User.where({ id: customer.userId }).first()
      : null;
    if (!user) return;
    this.mailer.sendSafe({
      to: user.email,
      subject: `Deposit received: ${formatMoney(tx.grossAmountInCents, tx.currency)}`,
      template: 'deposit-received',
      locals: {
        name: user.name,
        currencyLabel: tx.currency === FiatCurrency.eur ? 'EUR' : 'USD',
        reference: tx.reference,
        receiptUrl: receiptUrl?.startsWith('https://') ? receiptUrl : null,
        rows: [
          ['Amount', formatMoney(tx.grossAmountInCents, tx.currency)],
          ['Method', RAIL_LABEL[tx.rail ?? ''] ?? tx.rail ?? 'Bank transfer'],
          ['Reference', tx.reference],
        ],
      },
    });
  }
}
