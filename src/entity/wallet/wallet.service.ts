import { Service } from 'typedi';
import { and } from '@prisma/orm-postgres/orm-client';

import { config } from '#src/config.js';
import {
  PrismaService,
  type CustomerRow,
  type UserRow,
  type WalletRow,
} from '#src/service/prisma.js';
import { MailerService } from '#src/service/mailer.js';
import { RateLimiterService } from '#src/service/rateLimiter.js';
import { Chain, OtpPurpose, WalletKeyStatus, WalletStatus, WalletType } from '#src/graphql/enum.js';
import { AuditLogService } from '#src/entity/auditLog/auditLog.service.js';
import { AuthService } from '#src/entity/user/auth.service.js';
import { OneTimeCodeService, expiresIn } from '#src/entity/oneTimeCode/oneTimeCode.service.js';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  isSqlError,
} from '#src/utils/errors.js';
import { normalizeAddress, shortAddress } from '#src/utils/walletAddress.js';
import type { Context } from '#src/context.js';

import { generateWalletKey } from './wallet.keygen.js';
import { WalletKeyService } from './walletKey.service.js';
import type { AddExternalWalletInput, ExportedWalletKey } from './wallet.type.js';

export const GENERATED_CHAINS: Chain[] = [Chain.base, Chain.solana];

const CHAIN_NAME: Record<string, string> = { base: 'Base', solana: 'Solana' };
const HOUR = 60 * 60 * 1000;

@Service()
export class WalletService {
  private lastExportAlertAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletKeys: WalletKeyService,
    private readonly codes: OneTimeCodeService,
    private readonly auth: AuthService,
    private readonly mailer: MailerService,
    private readonly audit: AuditLogService,
    private readonly limiter: RateLimiterService
  ) {}

  async getById(id: string) {
    return this.prisma.orm.Wallet.where({ id }).first();
  }

  async listForCustomer(customerId: string, includeArchived = false): Promise<WalletRow[]> {
    await this.archiveOrphanedKeyless(customerId);
    return this.prisma.orm.Wallet.where((w) =>
      includeArchived
        ? w.customerId.eq(customerId)
        : and(w.customerId.eq(customerId), w.status.eq(WalletStatus.Active))
    )
      .orderBy([(w) => w.type.desc(), (w) => w.createdAt.asc()])
      .all();
  }

  /**
   * Generated wallets whose key was already removed stay Active in older data.
   * Archive them (unless still selected for payouts) so they leave the main list.
   */
  private async archiveOrphanedKeyless(customerId: string) {
    const customer = await this.prisma.orm.Customer.where({ id: customerId }).first();
    if (!customer) return;
    const orphaned = await this.prisma.orm.Wallet.where((w) =>
      and(
        w.customerId.eq(customerId),
        w.type.eq(WalletType.Generated),
        w.status.eq(WalletStatus.Active),
        w.keyRemovedAt.isNotNull()
      )
    ).all();
    for (const wallet of orphaned) {
      if (customer.payoutWalletId === wallet.id) continue;
      await this.prisma.orm.Wallet.where({ id: wallet.id }).update({
        status: WalletStatus.Archived,
      });
    }
  }

  async getGenerated(customerId: string, chain: Chain) {
    return this.prisma.orm.Wallet.where({ customerId, chain, type: WalletType.Generated }).first();
  }

  keyStatus(wallet: WalletRow, hasKey: boolean): WalletKeyStatus {
    if (wallet.type !== WalletType.Generated) return WalletKeyStatus.None;
    if (!hasKey) return WalletKeyStatus.Removed;
    return wallet.keyExportedAt ? WalletKeyStatus.Exported : WalletKeyStatus.Stored;
  }

  // Generation (onboarding)

  /** One generated wallet per chain; the key is sealed in the same transaction. Idempotent. */
  async ensureGeneratedWallet(customerId: string, chain: Chain): Promise<WalletRow> {
    const existing = await this.getGenerated(customerId, chain);
    if (existing) return existing;

    const generated = generateWalletKey(chain);
    try {
      return await this.prisma.transaction(async () => {
        const wallet = await this.prisma.orm.Wallet.create({
          customerId,
          chain,
          address: generated.address,
          label: `NxPay ${CHAIN_NAME[chain]} wallet`,
          type: WalletType.Generated,
          status: WalletStatus.Active,
        });
        await this.walletKeys.store(wallet, generated);
        return wallet;
      });
    } catch (error) {
      if (!isSqlError(error, '23505')) throw error;
      const winner = await this.getGenerated(customerId, chain);
      if (!winner) throw error;
      return winner;
    } finally {
      generated.secret.fill(0);
    }
  }

  /** Generates Base + Solana wallets and defaults the payout wallet (Base unless configured). */
  async ensureGeneratedWallets(customer: CustomerRow) {
    const wallets: WalletRow[] = [];
    for (const chain of GENERATED_CHAINS)
      wallets.push(await this.ensureGeneratedWallet(customer.id, chain));

    if (!customer.payoutWalletId) {
      const payout = wallets.find((w) => w.chain === config.DEFAULT_PAYOUT_CHAIN) ?? wallets[0]!;
      await this.prisma.orm.Customer.where((c) =>
        and(c.id.eq(customer.id), c.payoutWalletId.isNull())
      ).update({
        payoutWalletId: payout.id,
      });
    }
    return wallets;
  }

  // Customer changes (password + emailed OTP)

  async requestChangeCode(user: UserRow) {
    this.limiter.consume(`wallet-otp:${user.id}`, 5, HOUR);
    const code = await this.codes.issueCode(user.id, OtpPurpose.WalletChange);
    await this.mailer.send({
      to: user.email,
      subject: 'Your NxPay confirmation code',
      template: 'otp',
      locals: {
        name: user.name,
        code,
        action: 'change your payout wallets',
        expiresIn: expiresIn(OtpPurpose.WalletChange),
      },
    });
  }

  private async reauth(
    user: UserRow,
    password: string,
    otp: string,
    purpose: OtpPurpose,
    meta = {}
  ) {
    await this.auth.assertPassword(user, password);
    await this.codes.consumeCode(user.id, purpose, otp, meta);
  }

  private async ownedWallet(customer: CustomerRow, walletId: string) {
    const wallet = await this.getById(walletId);
    if (!wallet || wallet.customerId !== customer.id) throw new NotFoundError('Wallet');
    return wallet;
  }

  async addExternal(
    user: UserRow,
    customer: CustomerRow,
    data: AddExternalWalletInput,
    ctx: Context
  ) {
    const address = normalizeAddress(data.chain, data.address);
    if (!address) {
      throw new AppError(`Enter a valid ${CHAIN_NAME[data.chain]} address`, { field: 'address' });
    }
    await this.reauth(user, data.password, data.otp, OtpPurpose.WalletChange);

    const existing = await this.prisma.orm.Wallet.where({
      customerId: customer.id,
      chain: data.chain,
      address,
    }).first();
    let wallet: WalletRow;
    if (existing) {
      if (existing.status === WalletStatus.Active)
        throw new AppError('This wallet is already added', { field: 'address' });
      wallet = (await this.prisma.orm.Wallet.where({ id: existing.id }).update({
        status: WalletStatus.Active,
        label: data.label?.trim() || existing.label,
      }))!;
    } else {
      wallet = await this.prisma.orm.Wallet.create({
        customerId: customer.id,
        chain: data.chain,
        address,
        label: data.label?.trim() || null,
        type: WalletType.External,
        status: WalletStatus.Active,
      });
    }

    await this.audit.log(ctx, {
      action: 'wallet.addExternal',
      entity: 'Wallet',
      entityId: wallet.id,
      after: { chain: wallet.chain, address: wallet.address },
    });
    this.alert(user, [
      ['Change', 'External wallet added'],
      ['Network', CHAIN_NAME[wallet.chain] ?? wallet.chain],
      ['Address', wallet.address],
    ]);

    if (data.makePayout) await this.applyPayout(user, customer, wallet, ctx);
    return wallet;
  }

  async setPayout(
    user: UserRow,
    customer: CustomerRow,
    walletId: string,
    password: string,
    otp: string,
    ctx: Context
  ) {
    const wallet = await this.ownedWallet(customer, walletId);
    await this.assertPayoutEligible(wallet);
    if (customer.payoutWalletId === wallet.id) return wallet;
    await this.reauth(user, password, otp, OtpPurpose.WalletChange);
    await this.applyPayout(user, customer, wallet, ctx);
    return wallet;
  }

  /** Active only; generated wallets need a key still held by NxPay. */
  private async assertPayoutEligible(wallet: WalletRow) {
    if (wallet.status !== WalletStatus.Active) throw new AppError('This wallet is archived');
    if (
      wallet.type === WalletType.Generated &&
      !(await this.walletKeys.hasKey(wallet.id))
    ) {
      throw new AppError(
        "This wallet's key was removed from NxPay, so it can't be used for payouts. Choose another wallet."
      );
    }
  }

  private async applyPayout(user: UserRow, customer: CustomerRow, wallet: WalletRow, ctx: Context) {
    const previous = customer.payoutWalletId;
    await this.prisma.orm.Customer.where({ id: customer.id }).update({ payoutWalletId: wallet.id });
    await this.audit.log(ctx, {
      action: 'wallet.setPayout',
      entity: 'Customer',
      entityId: customer.id,
      before: { payoutWalletId: previous },
      after: { payoutWalletId: wallet.id, chain: wallet.chain, address: wallet.address },
    });
    this.alert(user, [
      ['Change', 'Payout wallet changed'],
      ['Network', CHAIN_NAME[wallet.chain] ?? wallet.chain],
      ['Address', wallet.address],
      ['Applies to', 'Payouts created from now on'],
    ]);
  }

  async archiveExternal(
    user: UserRow,
    customer: CustomerRow,
    walletId: string,
    password: string,
    otp: string,
    ctx: Context
  ) {
    const wallet = await this.ownedWallet(customer, walletId);
    if (wallet.type !== WalletType.External)
      throw new AppError('Generated wallets cannot be archived');
    if (customer.payoutWalletId === wallet.id) {
      throw new AppError('Choose another payout wallet before archiving this one');
    }
    if (wallet.status === WalletStatus.Archived) return wallet;
    await this.reauth(user, password, otp, OtpPurpose.WalletChange);
    const updated = (await this.prisma.orm.Wallet.where({ id: wallet.id }).update({
      status: WalletStatus.Archived,
    }))!;
    await this.audit.log(ctx, { action: 'wallet.archive', entity: 'Wallet', entityId: wallet.id });
    this.alert(user, [
      ['Change', 'External wallet archived'],
      ['Address', wallet.address],
    ]);
    return updated;
  }

  async updateLabel(customer: CustomerRow, walletId: string, label: string) {
    const wallet = await this.ownedWallet(customer, walletId);
    return (await this.prisma.orm.Wallet.where({ id: wallet.id }).update({ label: label.trim() }))!;
  }

  // Key export / removal

  async requestKeyExport(user: UserRow, customer: CustomerRow, walletId: string) {
    const wallet = await this.ownedWallet(customer, walletId);
    if (wallet.type !== WalletType.Generated)
      throw new AppError('Only NxPay-generated wallets have a stored key');
    if (!(await this.walletKeys.hasKey(wallet.id)))
      throw new AppError('The key for this wallet was removed from NxPay');
    this.limiter.consume(`wallet-export-otp:${user.id}`, 5, HOUR);
    const code = await this.codes.issueCode(user.id, OtpPurpose.WalletKeyExport, {
      walletId: wallet.id,
    });
    await this.mailer.send({
      to: user.email,
      subject: 'Confirm your wallet key export',
      template: 'otp',
      locals: {
        name: user.name,
        code,
        action: `export the private key of ${shortAddress(wallet.address)}`,
        expiresIn: expiresIn(OtpPurpose.WalletKeyExport),
      },
    });
  }

  /** Decrypts once for the customer. Audited, emailed, limited per day, alerted per hour. */
  async exportKey(
    user: UserRow,
    customer: CustomerRow,
    walletId: string,
    password: string,
    otp: string,
    ctx: Context
  ): Promise<ExportedWalletKey> {
    const wallet = await this.ownedWallet(customer, walletId);
    if (wallet.type !== WalletType.Generated)
      throw new ForbiddenError('Only NxPay-generated wallets have a stored key');

    const since = new Date(Date.now() - 24 * HOUR);
    const { exportsToday } = await this.prisma.orm.AuditLog.where((a) =>
      and(a.actorId.eq(user.id), a.action.eq('wallet.keyExport'), a.createdAt.gt(since))
    ).aggregate((a) => ({ exportsToday: a.count() }));
    if (Number(exportsToday) >= config.WALLET_EXPORT_LIMIT_PER_DAY) {
      throw new RateLimitError(
        `You can export up to ${config.WALLET_EXPORT_LIMIT_PER_DAY} keys per day`
      );
    }

    await this.reauth(user, password, otp, OtpPurpose.WalletKeyExport, { walletId: wallet.id });

    const privateKey = await this.walletKeys.exportKey(wallet);
    if (!privateKey) throw new AppError('The key for this wallet was removed from NxPay');

    const now = new Date();
    if (!wallet.keyExportedAt)
      await this.prisma.orm.Wallet.where({ id: wallet.id }).update({ keyExportedAt: now });
    await this.audit.log(ctx, {
      action: 'wallet.keyExport',
      entity: 'Wallet',
      entityId: wallet.id,
      after: { chain: wallet.chain, address: wallet.address },
    });

    this.mailer.sendSafe({
      to: user.email,
      subject: 'Your wallet private key was exported',
      template: 'wallet-key-exported',
      locals: {
        name: user.name,
        chainName: CHAIN_NAME[wallet.chain] ?? wallet.chain,
        address: wallet.address,
        time: now.toISOString().replace('T', ' ').slice(0, 19),
        ip: ctx.ip,
      },
    });
    void this.checkExportVolume();

    return {
      walletId: wallet.id,
      chain: wallet.chain,
      address: wallet.address,
      privateKey,
      format: wallet.chain === Chain.base ? 'evm-hex' : 'solana-base58-64',
    };
  }

  private async checkExportVolume() {
    try {
      const since = new Date(Date.now() - HOUR);
      const { count } = await this.prisma.orm.AuditLog.where((a) =>
        and(a.action.eq('wallet.keyExport'), a.createdAt.gt(since))
      ).aggregate((a) => ({ count: a.count() }));
      if (Number(count) < config.WALLET_EXPORT_ALERT_PER_HOUR) return;
      if (Date.now() - this.lastExportAlertAt < HOUR) return;
      this.lastExportAlertAt = Date.now();
      this.mailer.opsAlert('Unusual wallet key export volume', [
        `${count} wallet keys were exported in the last hour (threshold ${config.WALLET_EXPORT_ALERT_PER_HOUR}).`,
        'Review the audit log for action wallet.keyExport.',
      ]);
    } catch (error) {
      console.error('[wallet] export volume check failed', error);
    }
  }

  /**
   * After an export, the customer can delete NxPay's copy. Irreversible: we archive the wallet
   * and block payouts to it, since NxPay can never reveal the key again.
   */
  async removeKey(
    user: UserRow,
    customer: CustomerRow,
    walletId: string,
    password: string,
    ctx: Context
  ) {
    const wallet = await this.ownedWallet(customer, walletId);
    if (wallet.type !== WalletType.Generated)
      throw new AppError('Only NxPay-generated wallets have a stored key');
    if (!wallet.keyExportedAt)
      throw new AppError('Export and back up the key before removing it from NxPay');
    if (customer.payoutWalletId === wallet.id) {
      throw new AppError('Choose another payout wallet before removing the key from NxPay');
    }

    const alreadyGone = !(await this.walletKeys.hasKey(wallet.id));
    if (alreadyGone && wallet.status === WalletStatus.Archived) return wallet;

    await this.auth.assertPassword(user, password);
    const updated = await this.prisma.transaction(async () => {
      if (!alreadyGone) await this.walletKeys.remove(wallet.id);
      return (await this.prisma.orm.Wallet.where({ id: wallet.id }).update({
        keyRemovedAt: wallet.keyRemovedAt ?? new Date(),
        status: WalletStatus.Archived,
      }))!;
    });
    await this.audit.log(ctx, {
      action: 'wallet.keyRemove',
      entity: 'Wallet',
      entityId: wallet.id,
      after: { chain: wallet.chain, address: wallet.address, status: WalletStatus.Archived },
    });
    this.alert(user, [
      ['Change', 'Private key removed from NxPay'],
      ['Address', wallet.address],
      ['Note', "NxPay can never export this key again. The wallet was archived and can't receive payouts."],
    ]);
    return updated;
  }

  private alert(user: UserRow, rows: [string, string][]) {
    this.mailer.sendSafe({
      to: user.email,
      subject: 'Your NxPay wallets changed',
      template: 'wallet-alert',
      locals: { name: user.name, rows },
    });
  }
}
