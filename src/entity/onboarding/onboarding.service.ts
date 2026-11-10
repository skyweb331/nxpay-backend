import { createHash } from 'node:crypto';
import { Service } from 'typedi';
import { and, not, or } from '@prisma/orm-postgres/orm-client';

import { config, isBridgeSandbox } from '#src/config.js';
import { PrismaService, toJson, type CustomerRow, type UserRow } from '#src/service/prisma.js';
import {
  BridgeApiError,
  BridgeService,
  type BridgeCustomer,
  type BridgeKycLink,
  type BridgeRejectionReason,
  type BridgeWebhookEvent,
} from '#src/service/bridge/index.js';
import { MailerService } from '#src/service/mailer.js';
import { QueueService } from '#src/service/queue.js';
import {
  CustomerStatus,
  CustomerType,
  FiatCurrency,
  KycStatus,
  normalizeKycStatus,
  normalizeTosStatus,
  OnboardingStep,
  TosStatus,
} from '#src/graphql/enum.js';
import { AuditLogService } from '#src/entity/auditLog/auditLog.service.js';
import { CustomerService } from '#src/entity/customer/customer.service.js';
import { WalletService } from '#src/entity/wallet/wallet.service.js';
import { CustodialWalletService } from '#src/entity/custodialWallet/custodialWallet.service.js';
import {
  VirtualAccountService,
  type EnsureResult,
} from '#src/entity/virtualAccount/virtualAccount.service.js';
import type { WebhookOutcome } from '#src/webhook/dispatcher.js';
import { AppError } from '#src/utils/errors.js';
import { toAlpha2, toSubdivision } from '#src/utils/country.js';
import type { Context } from '#src/context.js';

import type { OnboardingStatus } from './onboarding.type.js';

export const COMPLETE_ONBOARDING = 'complete-onboarding';

/** `base` covers USD (ACH/wire); `sepa` covers EUR. */
const ENDORSEMENTS = ['base', 'sepa'];
const CURRENCIES = config.ENABLED_CURRENCIES as FiatCurrency[];
const ENDORSEMENT_FOR: Record<FiatCurrency, string> = {
  [FiatCurrency.usd]: 'base',
  [FiatCurrency.eur]: 'sepa',
};

const KYC_IN_PROGRESS = new Set<string>([
  KycStatus.not_started,
  KycStatus.incomplete,
  KycStatus.awaiting_questionnaire,
  KycStatus.awaiting_ubo,
]);
const KYC_REVIEW = new Set<string>([KycStatus.under_review, KycStatus.paused]);
const KYC_REJECTED = new Set<string>([KycStatus.rejected, KycStatus.offboarded]);

/** Only the customer-facing reason is kept; `developer_reason` stays with Bridge. */
const customerReasons = (reasons?: BridgeRejectionReason[] | null) =>
  (reasons ?? [])
    .map((r) => r.reason)
    .filter((r): r is string => typeof r === 'string' && r.length > 0);

const redirectUri = () => `${config.FRONTEND_URL}/onboarding`;

/**
 * Name and residence from the Bridge customer, kept only once KYC is approved. Fields Bridge
 * omits keep their stored value; `verifiedAt` moves only when something actually changes.
 */
function verifiedIdentity(customer: CustomerRow, remote: BridgeCustomer): Partial<CustomerRow> {
  if (normalizeKycStatus(remote.status ?? remote.kyc_status) !== KycStatus.approved) return {};
  const address = remote.residential_address ?? remote.address;
  const next = {
    verifiedFirstName: remote.first_name?.trim() || customer.verifiedFirstName,
    verifiedLastName: remote.last_name?.trim() || customer.verifiedLastName,
    verifiedCountry: toAlpha2(address?.country) ?? customer.verifiedCountry,
    verifiedRegion:
      toSubdivision(address?.subdivision ?? address?.state) ?? customer.verifiedRegion,
  };
  const changed = (Object.keys(next) as (keyof typeof next)[]).some(
    (k) => (next[k] ?? null) !== (customer[k] ?? null)
  );
  return changed ? { ...next, verifiedAt: new Date() } : {};
}

@Service()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: BridgeService,
    private readonly customers: CustomerService,
    private readonly wallets: WalletService,
    private readonly custodial: CustodialWalletService,
    private readonly virtualAccounts: VirtualAccountService,
    private readonly mailer: MailerService,
    private readonly queue: QueueService,
    private readonly audit: AuditLogService
  ) {}

  // Status

  async status(customer: CustomerRow): Promise<OnboardingStatus> {
    const vas = await this.prisma.orm.VirtualAccount.where((v) =>
      and(v.customerId.eq(customer.id), v.deactivatedAt.isNull())
    )
      .select('sourceCurrency')
      .all();
    const reasons = Array.isArray(customer.rejectionReasons)
      ? (customer.rejectionReasons as string[])
      : [];
    return {
      step: this.step(customer),
      status: customer.status,
      type: customer.type,
      kycStatus: customer.kycStatus,
      tosStatus: customer.tosStatus,
      rejectionReasons: reasons.filter((r) => typeof r === 'string'),
      tosLink: customer.tosStatus === TosStatus.approved ? null : customer.tosLink,
      kycLink: KYC_IN_PROGRESS.has(customer.kycStatus) ? customer.kycLink : null,
      currencies: [...new Set(vas.map((v) => v.sourceCurrency as FiatCurrency))],
      sandbox: isBridgeSandbox,
    };
  }

  step(customer: CustomerRow): OnboardingStep {
    if (customer.status === CustomerStatus.Active) return OnboardingStep.Done;
    if (!customer.type || (!customer.kycLinkId && !customer.bridgeCustomerId))
      return OnboardingStep.ChooseType;
    if (KYC_REJECTED.has(customer.kycStatus)) return OnboardingStep.Rejected;
    if (customer.kycStatus === KycStatus.approved) return OnboardingStep.Finalize;
    if (customer.tosStatus !== TosStatus.approved) return OnboardingStep.AcceptTos;
    if (KYC_REVIEW.has(customer.kycStatus)) return OnboardingStep.UnderReview;
    return OnboardingStep.CompleteKyc;
  }

  // Customer actions

  async start(user: UserRow, customer: CustomerRow, type: CustomerType, ctx: Context) {
    if (customer.status === CustomerStatus.Active)
      throw new AppError('Onboarding is already complete');
    if (customer.status === CustomerStatus.Suspended)
      throw new AppError('Your account is suspended');
    if (!user.isEmailVerified)
      throw new AppError('Verify your email address first', { code: 'EMAIL_NOT_VERIFIED' });
    this.assertBridge();

    const started = !!(customer.kycLinkId || customer.bridgeCustomerId);
    if (started && customer.type === type) return this.refresh(customer);
    if (started && customer.kycStatus !== KycStatus.not_started) {
      throw new AppError(
        'Verification is already in progress and the account type can no longer change'
      );
    }

    const updated = await this.startHosted(user, customer, type);

    await this.audit.log(ctx, {
      action: 'onboarding.start',
      entity: 'Customer',
      entityId: customer.id,
      after: { type, sandbox: isBridgeSandbox },
    });
    return updated;
  }

  /** Bridge-hosted ToS + KYC/KYB. Only name, email, type and endorsements are sent. */
  private async startHosted(user: UserRow, customer: CustomerRow, type: CustomerType) {
    let link: BridgeKycLink;
    try {
      link = await this.bridge.kycLinks.create({
        fullName: user.name,
        email: user.email,
        type,
        endorsements: ENDORSEMENTS,
        redirectUri: redirectUri(),
        idempotencyKey: `kyc-link-${customer.id}-${type}-${createHash('sha256')
          .update(`${user.name}\n${user.email}`)
          .digest('hex')
          .slice(0, 16)}`,
      });
    } catch (error) {
      const existing = this.existingKycLink(error);
      if (!existing) throw this.userFacing(error);
      link = existing;
    }
    await this.customers.update(customer.id, { type });
    return this.applyKycLink({ ...customer, type }, link);
  }

  /** Bridge answers a duplicate email with the existing link in the error body. */
  private existingKycLink(error: unknown): BridgeKycLink | null {
    if (!(error instanceof BridgeApiError) || error.status !== 400) return null;
    const body = error.body as { existing_kyc_link?: BridgeKycLink } | undefined;
    return body?.existing_kyc_link?.id ? body.existing_kyc_link : null;
  }

  /**
   * Sandbox only: approves the identity without filling in Bridge's hosted form.
   * The terms must be accepted first so account creation behaves like production.
   */
  async simulateApproval(customer: CustomerRow) {
    if (!isBridgeSandbox) throw new AppError('Test approval is only available in sandbox');
    this.assertBridge();
    if (customer.status !== CustomerStatus.Onboarding)
      throw new AppError('Identity verification is already complete');
    if (customer.tosStatus !== TosStatus.approved)
      throw new AppError('Accept the terms of service first');
    if (!customer.bridgeCustomerId) throw new AppError('Start verification first');
    try {
      await this.bridge.customers.simulateKycApproval(customer.bridgeCustomerId);
    } catch (error) {
      throw this.userFacing(error);
    }
    return this.refresh(customer);
  }

  /** Re-reads status from Bridge (button on the onboarding page; also the poller). */
  async refresh(customer: CustomerRow) {
    this.assertBridge();
    try {
      if (customer.kycLinkId) {
        const link = await this.bridge.kycLinks.get(customer.kycLinkId);
        customer = await this.applyKycLink(customer, link);
      }
      if (customer.bridgeCustomerId) {
        const remote = await this.bridge.customers.get(customer.bridgeCustomerId);
        customer = await this.applyBridgeCustomer(customer, remote);
      }
    } catch (error) {
      throw this.userFacing(error);
    }
    return customer;
  }

  /** Fresh hosted link when the old one expired or Bridge requests more information. */
  async regenerateKycLink(customer: CustomerRow) {
    this.assertBridge();
    try {
      if (customer.bridgeCustomerId) {
        const { url } = await this.bridge.customers.kycLink(customer.bridgeCustomerId, {
          redirectUri: redirectUri(),
        });
        return this.customers.update(customer.id, { kycLink: url });
      }
      if (customer.kycLinkId) {
        return this.applyKycLink(customer, await this.bridge.kycLinks.get(customer.kycLinkId));
      }
    } catch (error) {
      throw this.userFacing(error);
    }
    throw new AppError('Start onboarding first');
  }

  /**
   * After approval: generated wallets (payout defaults to Base), custodial wallet,
   * virtual accounts. Every step is idempotent, so the mutation and the job can race.
   */
  async complete(customerId: string): Promise<CustomerRow> {
    let customer = await this.customers.getById(customerId);
    if (!customer) throw new AppError('Customer not found');
    if (customer.status === CustomerStatus.Suspended)
      throw new AppError('Your account is suspended');
    if (customer.kycStatus !== KycStatus.approved || !customer.bridgeCustomerId) {
      throw new AppError('Identity verification is not approved yet');
    }
    this.assertBridge();

    await this.wallets.ensureGeneratedWallets(customer);
    customer = (await this.customers.getById(customerId))!;

    // Once active, only fill currencies that never had an account so staff deactivations stick
    const currencies =
      customer.status === CustomerStatus.Active
        ? await this.unopenedCurrencies(customer.id)
        : undefined;
    let results;
    try {
      const custodial = await this.custodial.ensure(customer);
      results = await this.virtualAccounts.ensureForCustomer(customer, custodial, currencies);
    } catch (error) {
      throw this.userFacing(error);
    }
    const ready = results.filter((r) => r.virtualAccount);
    if (results.length > 0 && ready.length === 0) {
      throw new AppError('We could not open your deposit accounts yet. Please try again shortly.');
    }

    if (customer.status !== CustomerStatus.Active) {
      const activated = await this.prisma.orm.Customer.where((c) =>
        and(c.id.eq(customerId), c.status.eq(CustomerStatus.Onboarding))
      ).update({ status: CustomerStatus.Active, onboardedAt: new Date() });
      if (activated) {
        customer = activated;
        await this.audit.log(null, {
          action: 'onboarding.complete',
          entity: 'Customer',
          entityId: customerId,
          after: { currencies: ready.map((r) => r.currency) },
        });
        const user = await this.prisma.orm.User.where({ id: customer.userId }).first();
        if (user) {
          this.mailer.sendSafe({
            to: user.email,
            subject: 'Your NxPay deposit accounts are ready',
            template: 'kyc-approved',
            locals: { name: user.name },
          });
        }
      } else {
        customer = (await this.customers.getById(customerId))!;
      }
    }
    return customer;
  }

  // Bridge state -> customer row

  async applyKycLink(customer: CustomerRow, link: BridgeKycLink) {
    const next = {
      kycLinkId: link.id,
      kycLink: link.kyc_link,
      tosLink: link.tos_link,
      tosStatus: link.tos_status ? normalizeTosStatus(link.tos_status) : customer.tosStatus,
      kycStatus: normalizeKycStatus(link.kyc_status),
      rejectionReasons: toJson(customerReasons(link.rejection_reasons)),
      ...(link.customer_id && !customer.bridgeCustomerId && { bridgeCustomerId: link.customer_id }),
    };
    return this.transition(customer, next);
  }

  async applyBridgeCustomer(customer: CustomerRow, remote: BridgeCustomer) {
    const next = {
      bridgeCustomerId: remote.id,
      kycStatus: normalizeKycStatus(remote.status ?? remote.kyc_status),
      ...(remote.has_accepted_terms_of_service !== undefined && {
        tosStatus: remote.has_accepted_terms_of_service ? TosStatus.approved : customer.tosStatus,
      }),
      endorsements: toJson(
        (remote.endorsements ?? []).map((e) => ({ name: e.name, status: e.status }))
      ),
      rejectionReasons: toJson(customerReasons(remote.rejection_reasons)),
      ...verifiedIdentity(customer, remote),
    };
    const updated = await this.transition(customer, next);
    // New endorsements (e.g. `sepa`) can unlock a currency that failed during onboarding
    if (
      updated.status === CustomerStatus.Active &&
      (await this.missingCurrencies(updated)).length > 0
    ) {
      await this.queue.sendSafe(
        COMPLETE_ONBOARDING,
        { customerId: updated.id },
        { singletonKey: `onboard-${updated.id}` }
      );
    }
    return updated;
  }

  private async transition(customer: CustomerRow, next: Partial<CustomerRow>) {
    const before = customer.kycStatus;
    const updated = await this.customers.update(customer.id, next);
    const after = updated.kycStatus;
    if (before === after) return updated;

    await this.audit.log(null, {
      action: 'onboarding.kycStatus',
      entity: 'Customer',
      entityId: customer.id,
      before: { kycStatus: before },
      after: { kycStatus: after },
    });

    if (after === KycStatus.approved && updated.status === CustomerStatus.Onboarding) {
      await this.queue.sendSafe(
        COMPLETE_ONBOARDING,
        { customerId: updated.id },
        { singletonKey: `onboard-${updated.id}` }
      );
    }
    if (KYC_REJECTED.has(after) && !KYC_REJECTED.has(before)) {
      const user = await this.prisma.orm.User.where({ id: updated.userId }).first();
      if (user) {
        this.mailer.sendSafe({
          to: user.email,
          subject: 'We could not verify your identity',
          template: 'kyc-rejected',
          locals: { name: user.name, reasons: updated.rejectionReasons ?? [] },
        });
      }
    }
    return updated;
  }

  // Webhooks + poller

  async handleKycLinkEvent(event: BridgeWebhookEvent<BridgeKycLink>): Promise<WebhookOutcome> {
    const link = event.event_object;
    const customer = link?.id ? await this.customers.getByKycLinkId(link.id) : null;
    if (!customer) return 'ignored';
    await this.applyKycLink(customer, link);
    return 'processed';
  }

  async handleCustomerEvent(event: BridgeWebhookEvent<BridgeCustomer>): Promise<WebhookOutcome> {
    const remote = event.event_object;
    const customer = remote?.id ? await this.customers.getByBridgeCustomerId(remote.id) : null;
    if (!customer) return 'ignored';
    await this.applyBridgeCustomer(customer, remote);
    return 'processed';
  }

  /** Fallback for missed webhooks: customers mid-verification, and approved ones not yet finalized. */
  async syncPending() {
    if (!this.bridge.configured) return { refreshed: 0, finalized: 0 };
    const staleBefore = new Date(Date.now() - 60 * 1000);
    const pending = await this.prisma.orm.Customer.where((c) =>
      and(
        c.status.eq(CustomerStatus.Onboarding),
        or(c.kycLinkId.isNotNull(), c.bridgeCustomerId.isNotNull()),
        not(c.kycStatus.in([...KYC_REJECTED])),
        c.updatedAt.lt(staleBefore)
      )
    )
      .orderBy((c) => c.updatedAt.asc())
      .limit(100)
      .all();

    let refreshed = 0;
    let finalized = 0;
    for (const customer of pending) {
      try {
        if (customer.kycStatus === KycStatus.approved) {
          await this.queue.sendSafe(
            COMPLETE_ONBOARDING,
            { customerId: customer.id },
            { singletonKey: `onboard-${customer.id}` }
          );
          finalized++;
        } else {
          await this.refresh(customer);
          refreshed++;
        }
      } catch (error) {
        console.warn(`[onboarding] sync customer ${customer.id}: ${(error as Error).message}`);
      }
    }
    return { refreshed, finalized };
  }

  /**
   * Active customers without an account in every currency. Re-reading them from Bridge
   * picks up endorsements approved after onboarding even if the webhook was missed or its
   * job was dropped while onboarding was still running.
   */
  async syncDepositAccounts() {
    if (!this.bridge.configured) return 0;
    const opened = await this.prisma.orm.VirtualAccount.select(
      'customerId',
      'sourceCurrency'
    ).all();
    const counts = new Map<string, number>();
    for (const row of opened) counts.set(row.customerId, (counts.get(row.customerId) ?? 0) + 1);
    const complete = new Set(
      [...counts].filter(([, n]) => n >= CURRENCIES.length).map(([id]) => id)
    );

    const active = await this.prisma.orm.Customer.where((c) =>
      and(c.status.eq(CustomerStatus.Active), c.bridgeCustomerId.isNotNull())
    )
      .orderBy((c) => c.updatedAt.asc())
      .all();

    let checked = 0;
    for (const customer of active) {
      if (complete.has(customer.id)) continue;
      if (checked >= 100) break;
      checked++;
      try {
        const remote = await this.bridge.customers.get(customer.bridgeCustomerId!);
        await this.applyBridgeCustomer(customer, remote);
      } catch (error) {
        console.warn(`[onboarding] deposit sync ${customer.id}: ${(error as Error).message}`);
      }
    }
    return checked;
  }

  /** Backfills the verified identity for approved customers synced before it was stored. */
  async syncVerifiedIdentities() {
    if (!this.bridge.configured) return 0;
    const missing = await this.prisma.orm.Customer.where((c) =>
      and(c.kycStatus.eq(KycStatus.approved), c.bridgeCustomerId.isNotNull(), c.verifiedAt.isNull())
    )
      .orderBy((c) => c.updatedAt.asc())
      .limit(50)
      .all();
    for (const customer of missing) {
      try {
        const remote = await this.bridge.customers.get(customer.bridgeCustomerId!);
        await this.applyBridgeCustomer(customer, remote);
      } catch (error) {
        console.warn(`[onboarding] identity sync ${customer.id}: ${(error as Error).message}`);
      }
    }
    return missing.length;
  }

  /** Staff retry: re-reads Bridge, then tries every currency that never had an account. */
  async retryDepositAccounts(customer: CustomerRow): Promise<EnsureResult[]> {
    this.assertBridge();
    if (customer.status !== CustomerStatus.Active || !customer.bridgeCustomerId)
      throw new AppError('Deposit accounts are opened after onboarding completes');
    try {
      const remote = await this.bridge.customers.get(customer.bridgeCustomerId);
      customer = await this.applyBridgeCustomer(customer, remote);
      const currencies = await this.unopenedCurrencies(customer.id);
      if (currencies.length === 0) return [];
      const custodial = await this.custodial.ensure(customer);
      return await this.virtualAccounts.ensureForCustomer(customer, custodial, currencies);
    } catch (error) {
      throw this.userFacing(error);
    }
  }

  // Helpers

  private async unopenedCurrencies(customerId: string) {
    const opened = await this.virtualAccounts.openedCurrencies(customerId);
    return CURRENCIES.filter((c) => !opened.has(c));
  }

  /** Never-opened currencies whose Bridge endorsement is approved. */
  private async missingCurrencies(customer: CustomerRow) {
    const endorsements = Array.isArray(customer.endorsements)
      ? (customer.endorsements as { name?: string; status?: string }[])
      : [];
    const approved = new Set(
      endorsements.filter((e) => e.status === 'approved').map((e) => e.name)
    );
    const unopened = await this.unopenedCurrencies(customer.id);
    return unopened.filter((c) => approved.has(ENDORSEMENT_FOR[c]));
  }

  private assertBridge() {
    if (!this.bridge.configured) {
      throw new AppError('Verification is temporarily unavailable. Please try again later.', {
        code: 'BRIDGE_UNAVAILABLE',
      });
    }
  }

  private userFacing(error: unknown) {
    if (error instanceof AppError) return error;
    if (error instanceof BridgeApiError) {
      console.error(
        `[onboarding] Bridge ${error.status} ${error.code ?? ''} ${error.path}: ${error.message}`
      );
      return new AppError(
        error.retryable
          ? 'Our verification partner is temporarily unavailable. Please try again shortly.'
          : 'We could not start verification. Please contact support.',
        { code: 'BRIDGE_ERROR' }
      );
    }
    return error;
  }
}
