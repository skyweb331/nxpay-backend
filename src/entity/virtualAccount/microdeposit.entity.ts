import { ObjectType, Field, ID } from 'type-graphql';

import { Entity } from '#src/graphql/interface.js';
import { GraphQLBigInt } from '#src/graphql/scalar/index.js';

/** Small bank-verification deposit on a virtual account. Never converted or paid out. */
@ObjectType({ implements: Entity })
export class Microdeposit extends Entity {
  @Field(() => ID)
  virtualAccountId: string;

  @Field(() => ID)
  customerId: string;

  @Field(() => GraphQLBigInt)
  amountInCents: bigint;

  /** Lowercase ISO code as Bridge reports it, e.g. `usd` */
  @Field(() => String)
  currency: string;

  @Field(() => String, { nullable: true })
  paymentRail?: string | null;

  @Field(() => String, { nullable: true })
  senderName?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  /** Latest Bridge activity type: funds_scheduled, funds_received, microdeposit, ... */
  @Field(() => String)
  status: string;

  /** YYYY-MM-DD, set while the deposit is still scheduled */
  @Field(() => String, { nullable: true })
  estimatedArrivalDate?: string | null;

  @Field(() => Date)
  occurredAt: Date;
}
