import { ObjectType, Field, Int } from 'type-graphql';
import { GraphQLJSON } from 'graphql-type-json';

import { Entity } from '#src/graphql/interface.js';
import { WebhookEventStatus } from '#src/graphql/enum.js';

@ObjectType({ implements: Entity })
export class WebhookEvent extends Entity {
  @Field(() => String)
  bridgeEventId: string;

  @Field(() => String)
  category: string;

  @Field(() => String)
  type: string;

  @Field(() => String, {
    nullable: true,
    description: 'Virtual account activity type (e.g. microdeposit), else the object status',
  })
  activityType?: string | null;

  @Field(() => String, { nullable: true })
  objectId?: string | null;

  @Field(() => GraphQLJSON)
  payload: unknown;

  @Field(() => WebhookEventStatus)
  status: WebhookEventStatus | string;

  @Field(() => String, { nullable: true })
  error?: string | null;

  @Field(() => Int)
  attempts: number;

  @Field(() => Date)
  receivedAt: Date;

  @Field(() => Date, { nullable: true })
  processedAt?: Date | null;
}
