import { IsEmail, IsIn, IsOptional, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { ObjectType, InputType, Field, ArgsType, ID } from 'type-graphql';

import { PaginatedResponse } from '#src/graphql/response/index.js';
import { QueryArgsBase } from '#src/graphql/queryArgs.js';
import { UserRole } from '#src/graphql/enum.js';

import { User } from './user.entity.js';

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MESSAGE = 'Password must contain at least one letter and one number';

// User Query Args
@ArgsType()
export class UserQueryArgs extends QueryArgsBase {}

// User list response with pagination ( total )
@ObjectType()
export class UsersResponse extends PaginatedResponse {
  @Field(() => [User], { nullable: true })
  users?: User[];
}

// Login Input and Response
@InputType()
export class LoginInput {
  @Field(() => String)
  email: string;

  @Field(() => String)
  password: string;

  @Field(() => Boolean, { nullable: true })
  isAdmin?: boolean = false;
}

@ObjectType()
export class LoginResponse {
  @Field(() => String, { nullable: true })
  accessToken?: string;

  /** Enter the authenticator code: staff with `verifyAdminTotp`, customers with `verifyLoginCode` */
  @Field(() => Boolean)
  mfaRequired: boolean = false;

  /** Staff without 2FA: run `beginTotpSetup` / `confirmTotpSetup` */
  @Field(() => Boolean)
  totpSetupRequired: boolean = false;

  /** Legacy pending accounts: no token until staff approve */
  @Field(() => Boolean, { nullable: true })
  approvalRequired?: boolean;

  /** Short-lived token for the TOTP step */
  @Field(() => String, { nullable: true })
  mfaToken?: string;
}

@InputType()
export class TotpInput {
  @Field(() => String)
  mfaToken: string;

  @Field(() => String)
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code: string;
}

@ObjectType()
export class TotpSetup {
  @Field(() => String)
  secret: string;

  @Field(() => String)
  otpauthUrl: string;
}

@InputType()
export class LoginCodeInput {
  @Field(() => String)
  mfaToken: string;

  /** 6-digit authenticator code or a backup code (`XXXXX-XXXXX`) */
  @Field(() => String)
  @Length(6, 20, { message: 'Enter the 6-digit code or a backup code' })
  code: string;
}

@InputType()
export class BeginTwoFactorSetupInput {
  @Field(() => String)
  @MinLength(1, { message: 'Enter your password' })
  password: string;
}

@InputType()
export class TwoFactorCodeInput {
  @Field(() => String)
  @Length(6, 20, { message: 'Enter the 6-digit code or a backup code' })
  code: string;
}

@InputType()
export class DisableTwoFactorInput {
  @Field(() => String)
  @MinLength(1, { message: 'Enter your password' })
  password: string;

  @Field(() => String)
  @Length(6, 20, { message: 'Enter the 6-digit code or a backup code' })
  code: string;
}

@ObjectType()
export class BackupCodes {
  /** Shown once; only hashes are stored. */
  @Field(() => [String])
  codes: string[];
}

@InputType()
export class VerifyEmailInput {
  @Field(() => String)
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code: string;
}

@InputType()
export class RequestPasswordResetInput {
  @Field(() => String)
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @Field(() => Boolean, { nullable: true })
  isAdmin?: boolean = false;
}

@InputType()
export class ResetPasswordInput {
  @Field(() => String)
  token: string;

  @Field(() => String)
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;
}

@InputType()
export class UpdatePasswordInput {
  @Field(() => String)
  oldPassword: string;

  @Field(() => String)
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

@InputType()
export class UpdateProfileInput {
  @Field(() => String)
  @Length(1, 120)
  name: string;
}

const STAFF_ROLES = [UserRole.Admin, UserRole.Support];

@InputType()
export class CreateStaffUserInput {
  @Field(() => String)
  @Length(1, 120)
  name: string;

  @Field(() => String)
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @Field(() => UserRole)
  @IsIn(STAFF_ROLES, { message: 'Role must be Admin or Support' })
  role: UserRole;
}

@InputType()
export class UpdateStaffUserInput {
  @Field(() => ID)
  id: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Length(1, 120)
  name?: string;

  @Field(() => UserRole, { nullable: true })
  @IsOptional()
  @IsIn(STAFF_ROLES, { message: 'Role must be Admin or Support' })
  role?: UserRole;

  /** Disable (soft delete) or re-enable the account */
  @Field(() => Boolean, { nullable: true })
  disabled?: boolean;
}
