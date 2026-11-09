import { Service } from 'typedi';
import { or } from '@prisma/orm-postgres/orm-client';

import { PrismaService, type CustomerRow } from '#src/service/prisma.js';
import { config } from '#src/config.js';
import { CustomerStatus, OtpPurpose, UserRole } from '#src/graphql/enum.js';
import { MailerService } from '#src/service/mailer.js';
import { AuditLogService } from '#src/entity/auditLog/auditLog.service.js';
import { OneTimeCodeService, expiresIn } from '#src/entity/oneTimeCode/oneTimeCode.service.js';
import { AppError, NotFoundError } from '#src/utils/errors.js';
import { isUuid } from '#src/utils/id.js';
import type { Context } from '#src/context.js';
import { normalizeEmail } from '#src/entity/user/user.service.js';

import type { BulkCustomerResult, CustomerQueryArgs } from './customer.type.js';

export type CustomerUpdate = Partial<
  Omit<CustomerRow, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
>;

const CUSTOMER_LIST = {
  model: 'Customer',
  filterable: [
    'id',
    'userId',
    'type',
    'status',
    'country',
    'region',
    'kycStatus',
    'tosStatus',
    'onboardedAt',
    'createdAt',
  ],
  sortable: ['id', 'createdAt', 'onboardedAt', 'status', 'kycStatus', 'country'],
  defaultSort: 'createdAt',
} as const;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Bridge custodial wallets aren't available everywhere (e.g. NY, TX), so signup
 * enforces the configured geography rules.
 */
export function assertSupportedGeography(country: string, region?: string | null) {
  const c = country.toUpperCase();
  if (config.BLOCKED_COUNTRIES.map((x) => x.toUpperCase()).includes(c)) {
    throw new AppError('NxPay is not available in your country yet', { field: 'country' });
  }
  if (c === 'US') {
    if (!region) throw new AppError('Select your state', { field: 'region' });
    if (config.BLOCKED_US_STATES.map((x) => x.toUpperCase()).includes(region.toUpperCase())) {
      throw new AppError('NxPay is not available in your state yet', { field: 'region' });
    }
  }
}

@Service()
export class CustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly mailer: MailerService,
    private readonly codes: OneTimeCodeService
  ) {}

  private async searchCollection(query: CustomerQueryArgs) {
    let collection = this.prisma.orm.Customer;
    if (query.awaitingApproval) {
      const pending = await this.prisma.orm.User.where({
        role: UserRole.Customer,
        approvedAt: null,
        deletedAt: null,
      })
        .select('id')
        .limit(500)
        .all();
      const ids = pending.map((u) => u.id);
      collection = collection.where((c) =>
        ids.length ? c.userId.in(ids) : c.id.isNull()
      ) as typeof collection;
    }
    const term = query.search?.trim();
    if (isUuid(term)) {
      collection = collection.where((c) => c.id.eq(term)) as typeof collection;
    } else if (term) {
      const pattern = `%${escapeLike(term)}%`;
      const users = await this.prisma.orm.User.where((u) =>
        or(u.email.ilike(pattern), u.name.ilike(pattern))
      )
        .select('id')
        .limit(500)
        .all();
      const ids = users.map((u) => u.id);
      collection = collection.where((c) =>
        ids.length ? c.userId.in(ids) : c.id.isNull()
      ) as typeof collection;
    }
    return collection;
  }

  async list(query: CustomerQueryArgs): Promise<CustomerRow[]> {
    return query.applyTo(await this.searchCollection(query), CUSTOMER_LIST).all();
  }

  async count(query: CustomerQueryArgs): Promise<number> {
    const { total } = await query
      .applyFilter(await this.searchCollection(query), CUSTOMER_LIST)
      .aggregate((a) => ({ total: a.count() }));
    return Number(total);
  }

  async getById(id: string) {
    return this.prisma.orm.Customer.where({ id }).first();
  }

  async getByUserId(userId: string) {
    return this.prisma.orm.Customer.where({ userId }).first();
  }

  async getByBridgeCustomerId(bridgeCustomerId: string) {
    return this.prisma.orm.Customer.where({ bridgeCustomerId }).first();
  }

  async getByKycLinkId(kycLinkId: string) {
    return this.prisma.orm.Customer.where({ kycLinkId }).first();
  }

  async create(data: { userId: string; country: string; region?: string | null }) {
    return this.prisma.orm.Customer.create({
      userId: data.userId,
      country: data.country.toUpperCase(),
      region: data.region ? data.region.toUpperCase() : null,
    });
  }

  async update(id: string, data: CustomerUpdate) {
    const row = await this.prisma.orm.Customer.where({ id }).update(data as any);
    if (!row) throw new Error(`Customer ${id} not found`);
    return row as CustomerRow;
  }

  /** Blocks the customer app and new payouts; deposits already at Bridge still settle. */
  async suspend(id: string, reason: string, ctx: Context) {
    const customer = await this.getById(id);
    if (!customer) throw new NotFoundError('Customer');
    if (customer.status === CustomerStatus.Suspended) return customer;
    const updated = await this.update(id, {
      status: CustomerStatus.Suspended,
      suspendedAt: new Date(),
    });
    await this.audit.log(ctx, {
      action: 'customer.suspend',
      entity: 'Customer',
      entityId: id,
      before: { status: customer.status },
      after: { status: updated.status, reason },
    });
    return updated;
  }

  async reactivate(id: string, ctx: Context) {
    const customer = await this.getById(id);
    if (!customer) throw new NotFoundError('Customer');
    if (customer.status !== CustomerStatus.Suspended) return customer;
    const status = customer.onboardedAt ? CustomerStatus.Active : CustomerStatus.Onboarding;
    const updated = await this.update(id, { status, suspendedAt: null });
    await this.audit.log(ctx, {
      action: 'customer.reactivate',
      entity: 'Customer',
      entityId: id,
      before: { status: customer.status },
      after: { status },
    });
    return updated;
  }

  private async loadForBulk(ids: string[]) {
    const unique = [...new Set(ids)];
    const customers = await this.prisma.orm.Customer.where((c) => c.id.in(unique)).all();
    const users = await this.prisma.orm.User.where((u) =>
      u.id.in(customers.map((c) => c.userId))
    ).all();
    const userById = new Map(users.map((u) => [u.id, u]));
    const byId = new Map(customers.map((c) => [c.id, c]));
    return unique.map((id) => {
      const customer = byId.get(id) ?? null;
      return { id, customer, user: customer ? (userById.get(customer.userId) ?? null) : null };
    });
  }

  async bulkSuspend(ids: string[], reason: string, ctx: Context): Promise<BulkCustomerResult> {
    const result: BulkCustomerResult = { succeeded: [], skipped: [] };
    for (const { id, customer, user } of await this.loadForBulk(ids)) {
      const name = user?.name ?? null;
      if (!customer) result.skipped.push({ id, name, reason: 'Not found' });
      else if (customer.status === CustomerStatus.Suspended) {
        result.skipped.push({ id, name, reason: 'Already suspended' });
      } else {
        await this.suspend(id, reason, ctx);
        result.succeeded.push(id);
      }
    }
    return result;
  }

  /** Why a customer can't be deleted: anything at Bridge, money movement, or a wallet key we hold. */
  private async deleteBlocker(customer: CustomerRow): Promise<string | null> {
    const { orm } = this.prisma;
    const customerId = customer.id;
    if (customer.bridgeCustomerId || customer.kycLinkId) return 'Has a Bridge customer record';
    if (await orm.CustodialWallet.where({ customerId }).first()) return 'Has a Bridge wallet';
    if (await orm.VirtualAccount.where({ customerId }).first()) return 'Has deposit accounts';
    if (await orm.Transaction.where({ customerId }).first()) return 'Has transactions';
    const wallets = await orm.Wallet.where({ customerId }).select('id').all();
    if (
      wallets.length &&
      (await orm.WalletKey.where((k) => k.walletId.in(wallets.map((w) => w.id))).first())
    ) {
      return 'Holds a wallet private key';
    }
    return null;
  }

  /** Permanently removes sign-ups that never reached Bridge (e.g. spam); everyone else is skipped. */
  async deleteMany(ids: string[], ctx: Context): Promise<BulkCustomerResult> {
    const result: BulkCustomerResult = { succeeded: [], skipped: [] };
    for (const { id, customer, user } of await this.loadForBulk(ids)) {
      const name = user?.name ?? null;
      if (!customer || !user) {
        result.skipped.push({ id, name, reason: 'Not found' });
        continue;
      }
      const blocker = await this.prisma.transaction(async () => {
        const reason = await this.deleteBlocker(customer);
        if (reason) return reason;
        // Support messages restrict deleting their author, so tickets go first
        await this.prisma.orm.SupportTicket.where({ customerId: id }).deleteAll();
        await this.prisma.orm.User.where({ id: user.id }).delete();
        return null;
      });
      if (blocker) {
        result.skipped.push({ id, name, reason: blocker });
        continue;
      }
      await this.audit.log(ctx, {
        action: 'customer.delete',
        entity: 'Customer',
        entityId: id,
        before: { email: user.email, name: user.name, country: customer.country },
      });
      result.succeeded.push(id);
    }
    return result;
  }

  /**
   * Admin sets a new email immediately. The address is unverified until the customer
   * confirms the code we send there. The previous address gets a security notice.
   */
  async changeEmail(id: string, email: string, ctx: Context) {
    const customer = await this.getById(id);
    if (!customer) throw new NotFoundError('Customer');
    const user = await this.prisma.orm.User.where({ id: customer.userId }).first();
    if (!user) throw new NotFoundError('Customer');

    const next = normalizeEmail(email);
    if (next === user.email) return customer;

    const taken = await this.prisma.orm.User.where({ email: next }).first();
    if (taken) throw new AppError('Email already exists', { field: 'email' });

    const previous = user.email;
    await this.prisma.orm.User.where({ id: user.id }).update({
      email: next,
      isEmailVerified: false,
    });
    await this.audit.log(ctx, {
      action: 'customer.email_change',
      entity: 'Customer',
      entityId: id,
      before: { email: previous },
      after: { email: next },
    });

    const code = await this.codes.issueCode(user.id, OtpPurpose.EmailVerify);
    this.mailer.sendSafe({
      to: next,
      subject: 'Verify your email',
      template: 'verify-email',
      locals: { name: user.name, code, expiresIn: expiresIn(OtpPurpose.EmailVerify) },
    });
    this.mailer.sendSafe({
      to: previous,
      subject: 'Your NxPay email address changed',
      template: 'security-alert',
      locals: {
        name: user.name,
        change: `Your sign-in email was changed from ${previous} to ${next} by NxPay support.`,
      },
    });
    return customer;
  }

  /** Lets a new sign-up sign in and emails them the sign-in link. */
  async approve(id: string, ctx: Context) {
    const customer = await this.getById(id);
    if (!customer) throw new NotFoundError('Customer');
    const user = await this.prisma.orm.User.where({ id: customer.userId }).first();
    if (!user || user.approvedAt) return customer;

    await this.prisma.orm.User.where({ id: user.id }).update({ approvedAt: new Date() });
    this.mailer.sendSafe({
      to: user.email,
      subject: 'Your NxPay account is approved',
      template: 'customer-approved',
      locals: { name: user.name, link: `${config.FRONTEND_URL}/auth/sign-in` },
    });
    await this.audit.log(ctx, { action: 'customer.approve', entity: 'Customer', entityId: id });
    return customer;
  }
}
