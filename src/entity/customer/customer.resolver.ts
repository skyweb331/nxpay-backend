import { Service } from 'typedi';
import {
  Arg,
  Args,
  Authorized,
  Ctx,
  FieldResolver,
  Info,
  ID,
  Mutation,
  Query,
  Resolver,
  Root,
} from 'type-graphql';
import graphqlFields from 'graphql-fields';
import type { GraphQLResolveInfo } from 'graphql';

import { type Context } from '#src/context.js';
import { OnboardingStep, UserRole } from '#src/graphql/enum.js';
import { assertOwnership } from '#src/graphql/middleware/index.js';
import { User } from '#src/entity/user/user.entity.js';
import { Wallet } from '#src/entity/wallet/wallet.entity.js';
import { VirtualAccount } from '#src/entity/virtualAccount/virtualAccount.entity.js';
import { OnboardingService } from '#src/entity/onboarding/onboarding.service.js';
import { AuditLogService } from '#src/entity/auditLog/auditLog.service.js';
import { AppError, NotFoundError } from '#src/utils/errors.js';

import { Customer } from './customer.entity.js';
import {
  BULK_LIMIT,
  BulkCustomerResult,
  BulkSuspendCustomersInput,
  CustomerQueryArgs,
  CustomersResponse,
  DepositAccountResult,
  SuspendCustomerInput,
  UpdateCustomerEmailInput,
} from './customer.type.js';
import { CustomerService } from './customer.service.js';

@Service()
@Resolver(() => Customer)
export class CustomerResolver {
  constructor(
    private readonly service: CustomerService,
    private readonly onboarding: OnboardingService,
    private readonly audit: AuditLogService
  ) {}

  @Authorized([UserRole.Support])
  @Query(() => CustomersResponse)
  async customers(
    @Args() query: CustomerQueryArgs,
    @Info() info: GraphQLResolveInfo
  ): Promise<CustomersResponse> {
    const fields = graphqlFields(info);
    const [total, customers] = await Promise.all([
      'total' in fields ? this.service.count(query) : undefined,
      'customers' in fields ? this.service.list(query) : undefined,
    ]);
    return { total, customers };
  }

  @Authorized()
  @Query(() => Customer, { nullable: true })
  async customer(@Arg('id', () => ID) id: string, @Ctx() ctx: Context) {
    const customer = await this.service.getById(id);
    assertOwnership(ctx, customer ? { customerId: customer.id } : null);
    return customer;
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => Customer)
  async suspendCustomer(@Arg('data') data: SuspendCustomerInput, @Ctx() ctx: Context) {
    return this.service.suspend(data.id, data.reason.trim(), ctx);
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => BulkCustomerResult)
  async bulkSuspendCustomers(
    @Arg('data') data: BulkSuspendCustomersInput,
    @Ctx() ctx: Context
  ): Promise<BulkCustomerResult> {
    return this.service.bulkSuspend(data.ids, data.reason.trim(), ctx);
  }

  /** Permanent; only for customers with nothing at Bridge, no transactions and no stored wallet key. */
  @Authorized([UserRole.Admin])
  @Mutation(() => BulkCustomerResult)
  async deleteCustomers(
    @Arg('ids', () => [ID]) ids: string[],
    @Ctx() ctx: Context
  ): Promise<BulkCustomerResult> {
    if (ids.length === 0 || ids.length > BULK_LIMIT) {
      throw new AppError(`Select between 1 and ${BULK_LIMIT} customers`);
    }
    return this.service.deleteMany(ids, ctx);
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => Customer)
  async reactivateCustomer(@Arg('id', () => ID) id: string, @Ctx() ctx: Context) {
    return this.service.reactivate(id, ctx);
  }

  @Authorized([UserRole.Support])
  @Mutation(() => Customer)
  async approveCustomer(@Arg('id', () => ID) id: string, @Ctx() ctx: Context) {
    return this.service.approve(id, ctx);
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => Customer)
  async updateCustomerEmail(@Arg('data') data: UpdateCustomerEmailInput, @Ctx() ctx: Context) {
    return this.service.changeEmail(data.id, data.email, ctx);
  }

  /** New hosted Bridge KYC link for support to send when the old one expired. */
  @Authorized([UserRole.Support])
  @Mutation(() => Customer)
  async regenerateCustomerKycLink(@Arg('id', () => ID) id: string, @Ctx() ctx: Context) {
    const customer = await this.service.getById(id);
    if (!customer) throw new NotFoundError('Customer');
    const updated = await this.onboarding.regenerateKycLink(customer);
    await this.audit.log(ctx, {
      action: 'customer.kyc_link_regenerate',
      entity: 'Customer',
      entityId: id,
    });
    return updated;
  }

  /** Opens deposit accounts in currencies the customer never had (e.g. EUR after `sepa` approval). */
  @Authorized([UserRole.Admin])
  @Mutation(() => [DepositAccountResult])
  async openMissingDepositAccounts(
    @Arg('id', () => ID) id: string,
    @Ctx() ctx: Context
  ): Promise<DepositAccountResult[]> {
    const customer = await this.service.getById(id);
    if (!customer) throw new NotFoundError('Customer');
    const results = await this.onboarding.retryDepositAccounts(customer);
    await this.audit.log(ctx, {
      action: 'customer.deposit_accounts_retry',
      entity: 'Customer',
      entityId: id,
      after: {
        results: results.map((r) => ({
          currency: r.currency,
          opened: !!r.virtualAccount,
          error: r.error,
        })),
      },
    });
    return results.map((r) => ({
      currency: r.currency,
      opened: !!r.virtualAccount,
      error: r.error ?? null,
    }));
  }

  @FieldResolver(() => User, { nullable: true })
  async user(@Root() customer: Customer, @Ctx() ctx: Context) {
    return ctx.dataLoader.get('userLoader').load(customer.userId);
  }

  @FieldResolver(() => Wallet, { nullable: true })
  async payoutWallet(@Root() customer: Customer, @Ctx() ctx: Context) {
    if (!customer.payoutWalletId) return null;
    return ctx.dataLoader.get('walletLoader').load(customer.payoutWalletId);
  }

  @FieldResolver(() => [Wallet])
  async wallets(@Root() customer: Customer, @Ctx() ctx: Context) {
    return ctx.dataLoader.get('walletsForCustomerLoader').load(customer.id);
  }

  @FieldResolver(() => [VirtualAccount])
  async virtualAccounts(@Root() customer: Customer, @Ctx() ctx: Context) {
    return ctx.dataLoader.get('virtualAccountsForCustomerLoader').load(customer.id);
  }

  @FieldResolver(() => OnboardingStep)
  onboardingStep(@Root() customer: Customer) {
    return this.onboarding.step(customer as any);
  }
}
