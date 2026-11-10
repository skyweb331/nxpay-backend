import { ObjectType, Field, ID, UseMiddleware } from 'type-graphql';
import { GraphQLJSON } from 'graphql-type-json';

import { Entity } from '#src/graphql/interface.js';
import { CustomerStatus, CustomerType, KycStatus, TosStatus } from '#src/graphql/enum.js';
import { StaffOnlyField } from '#src/graphql/middleware/customer.permission.js';

@ObjectType({ implements: Entity })
export class Customer extends Entity {
  @Field(() => ID)
  userId: string;

  @Field(() => CustomerType, { nullable: true })
  type?: CustomerType | string | null;

  @Field(() => CustomerStatus)
  status: CustomerStatus | string;

  @Field(() => String, { nullable: true })
  country?: string | null;

  @Field(() => String, { nullable: true })
  region?: string | null;

  @UseMiddleware(StaffOnlyField)
  @Field(() => String, { nullable: true, description: 'Bridge customer id (staff only)' })
  bridgeCustomerId?: string | null;

  kycLinkId?: string | null;

  @Field(() => KycStatus)
  kycStatus: KycStatus | string;

  @Field(() => TosStatus)
  tosStatus: TosStatus | string;

  @UseMiddleware(StaffOnlyField)
  @Field(() => String, { nullable: true, description: 'Hosted Bridge KYC link (staff only)' })
  kycLink?: string | null;

  tosLink?: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  endorsements?: unknown;

  @Field(() => GraphQLJSON, { nullable: true })
  rejectionReasons?: unknown;

  @UseMiddleware(StaffOnlyField)
  @Field(() => String, {
    nullable: true,
    description: 'First name verified by Bridge KYC (staff only)',
  })
  verifiedFirstName?: string | null;

  @UseMiddleware(StaffOnlyField)
  @Field(() => String, {
    nullable: true,
    description: 'Last name verified by Bridge KYC (staff only)',
  })
  verifiedLastName?: string | null;

  @UseMiddleware(StaffOnlyField)
  @Field(() => String, {
    nullable: true,
    description: 'Residence country verified by Bridge KYC, ISO alpha-2 (staff only)',
  })
  verifiedCountry?: string | null;

  @UseMiddleware(StaffOnlyField)
  @Field(() => String, {
    nullable: true,
    description: 'Residence state/subdivision verified by Bridge KYC (staff only)',
  })
  verifiedRegion?: string | null;

  @UseMiddleware(StaffOnlyField)
  @Field(() => Date, {
    nullable: true,
    description: 'When the verified identity last changed (staff only)',
  })
  verifiedAt?: Date | null;

  @Field(() => ID, { nullable: true })
  payoutWalletId?: string | null;

  @Field(() => Date, { nullable: true })
  onboardedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  suspendedAt?: Date | null;
}
