import { ArrayMaxSize, ArrayNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ArgsType, Field, ID, InputType, ObjectType } from 'type-graphql';

import { PaginatedResponse } from '#src/graphql/response/index.js';
import { QueryArgsBase } from '#src/graphql/queryArgs.js';
import { FiatCurrency } from '#src/graphql/enum.js';

import { Customer } from './customer.entity.js';

@ArgsType()
export class CustomerQueryArgs extends QueryArgsBase {
  @Field(() => String, { nullable: true, description: 'Matches the user email or name' })
  @IsOptional()
  @MaxLength(120)
  search?: string;

  @Field(() => Boolean, { nullable: true, description: 'Only sign-ups staff have not approved' })
  @IsOptional()
  awaitingApproval?: boolean;
}

@ObjectType()
export class CustomersResponse extends PaginatedResponse {
  @Field(() => [Customer], { nullable: true })
  customers?: Customer[];
}

@InputType()
export class SuspendCustomerInput {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  @MaxLength(500)
  reason: string;
}

export const BULK_LIMIT = 100;

@InputType()
export class BulkSuspendCustomersInput {
  @Field(() => [ID])
  @ArrayNotEmpty()
  @ArrayMaxSize(BULK_LIMIT, { message: `Select at most ${BULK_LIMIT} customers` })
  ids: string[];

  @Field(() => String)
  @MaxLength(500)
  reason: string;
}

@ObjectType()
export class BulkCustomerSkip {
  @Field(() => ID)
  id: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String)
  reason: string;
}

@ObjectType({ description: 'Customers a bulk action applied to, and the ones it skipped with why' })
export class BulkCustomerResult {
  @Field(() => [ID])
  succeeded: string[];

  @Field(() => [BulkCustomerSkip])
  skipped: BulkCustomerSkip[];
}

@ObjectType({ description: 'Outcome of opening one missing deposit account' })
export class DepositAccountResult {
  @Field(() => FiatCurrency)
  currency: FiatCurrency;

  @Field(() => Boolean)
  opened: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Bridge error when the account could not be opened',
  })
  error?: string | null;
}
