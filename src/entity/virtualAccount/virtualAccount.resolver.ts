import { Service } from 'typedi';
import {
  Arg,
  Args,
  Authorized,
  Ctx,
  FieldResolver,
  ID,
  Info,
  Mutation,
  Query,
  Resolver,
  Root,
  UseMiddleware,
} from 'type-graphql';
import graphqlFields from 'graphql-fields';
import type { GraphQLResolveInfo } from 'graphql';

import { type Context } from '#src/context.js';
import { UserRole } from '#src/graphql/enum.js';
import { CustomerScope, StaffOnlyField, assertOwnership } from '#src/graphql/middleware/index.js';
import { Customer } from '#src/entity/customer/customer.entity.js';

import { DepositInstructions, VirtualAccount } from './virtualAccount.entity.js';
import { Microdeposit } from './microdeposit.entity.js';
import { VirtualAccountQueryArgs, VirtualAccountsResponse } from './virtualAccount.type.js';
import { VirtualAccountService } from './virtualAccount.service.js';

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

@Service()
@Resolver(() => VirtualAccount)
export class VirtualAccountResolver {
  constructor(private readonly service: VirtualAccountService) {}

  @Authorized()
  @UseMiddleware(CustomerScope)
  @Query(() => VirtualAccountsResponse)
  async virtualAccounts(
    @Args() query: VirtualAccountQueryArgs,
    @Info() info: GraphQLResolveInfo
  ): Promise<VirtualAccountsResponse> {
    const fields = graphqlFields(info);
    const [total, virtualAccounts] = await Promise.all([
      'total' in fields ? this.service.count(query) : undefined,
      'virtualAccounts' in fields ? this.service.list(query) : undefined,
    ]);
    return { total, virtualAccounts };
  }

  @Authorized()
  @Query(() => VirtualAccount, { nullable: true })
  async virtualAccount(@Arg('id', () => ID) id: string, @Ctx() ctx: Context) {
    const va = await this.service.getById(id);
    assertOwnership(ctx, va);
    return va;
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => VirtualAccount)
  async deactivateVirtualAccount(@Arg('id', () => ID) id: string, @Ctx() ctx: Context) {
    return this.service.deactivate(id, ctx);
  }

  @FieldResolver(() => DepositInstructions)
  depositInstructions(@Root() va: VirtualAccount): DepositInstructions {
    const raw = (va.depositInstructions ?? {}) as Record<string, unknown>;
    const rails = Array.isArray(raw['payment_rails'])
      ? (raw['payment_rails'] as string[])
      : str(raw['payment_rail'])
        ? [raw['payment_rail'] as string]
        : [];
    return {
      currency: str(raw['currency']) ?? String(va.sourceCurrency),
      paymentRails: rails,
      bankName: str(raw['bank_name']),
      bankAddress: str(raw['bank_address']),
      routingNumber: str(raw['bank_routing_number']),
      accountNumber: str(raw['bank_account_number']),
      beneficiaryName: str(raw['bank_beneficiary_name']),
      beneficiaryAddress: str(raw['bank_beneficiary_address']),
      iban: str(raw['iban']),
      bic: str(raw['bic']),
      accountHolderName: str(raw['account_holder_name']),
    };
  }

  @UseMiddleware(StaffOnlyField)
  @FieldResolver(() => String, {
    nullable: true,
    description: 'Bridge virtual account id (staff only)',
  })
  bridgeVirtualAccountId(@Root() va: VirtualAccount) {
    return va.bridgeVirtualAccountId;
  }

  @FieldResolver(() => Customer, { nullable: true })
  async customer(@Root() va: VirtualAccount, @Ctx() ctx: Context) {
    return ctx.dataLoader.get('customerLoader').load(va.customerId);
  }

  /** Newest first. Bank-verification deposits; not transactions. */
  @FieldResolver(() => [Microdeposit])
  async microdeposits(@Root() va: VirtualAccount, @Ctx() ctx: Context) {
    return ctx.dataLoader.get('microdepositsForVirtualAccountLoader').load(va.id);
  }
}
