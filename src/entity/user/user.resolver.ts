import { Service } from 'typedi';
import {
  Arg,
  Args,
  Resolver,
  Query,
  Mutation,
  Authorized,
  FieldResolver,
  Ctx,
  Root,
  Info,
  ID,
  Int,
} from 'type-graphql';
import graphqlFields from 'graphql-fields';
import type { GraphQLResolveInfo } from 'graphql';

import { type Context } from '#src/context.js';
import { KycStatus, UserRole } from '#src/graphql/enum.js';
import { SuccessResponse } from '#src/graphql/response/index.js';
import { AppError, UnauthenticatedError } from '#src/utils/errors.js';

import { Customer } from '#src/entity/customer/customer.entity.js';
import { CustomerService } from '#src/entity/customer/customer.service.js';

import { User } from './user.entity.js';
import {
  UsersResponse,
  UserQueryArgs,
  LoginInput,
  LoginResponse,
  TotpInput,
  TotpSetup,
  LoginCodeInput,
  BeginTwoFactorSetupInput,
  TwoFactorCodeInput,
  DisableTwoFactorInput,
  BackupCodes,
  VerifyEmailInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  UpdatePasswordInput,
  UpdateProfileInput,
  CreateStaffUserInput,
  UpdateStaffUserInput,
} from './user.type.js';
import { UserService } from './user.service.js';
import { AuthService } from './auth.service.js';
import { TwoFactorService } from './twoFactor.service.js';

@Service()
@Resolver(() => User)
export class UserResolver {
  constructor(
    private readonly service: UserService,
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly customers: CustomerService
  ) {}

  // Auth

  @Mutation(() => LoginResponse)
  async login(@Arg('data') data: LoginInput, @Ctx() ctx: Context): Promise<LoginResponse> {
    return this.auth.login(data, ctx);
  }

  @Mutation(() => LoginResponse)
  async verifyAdminTotp(@Arg('data') data: TotpInput, @Ctx() ctx: Context): Promise<LoginResponse> {
    return this.auth.verifyAdminTotp(data.mfaToken, data.code, ctx);
  }

  @Mutation(() => TotpSetup)
  async beginTotpSetup(@Arg('mfaToken', () => String) mfaToken: string): Promise<TotpSetup> {
    return this.auth.beginTotpSetup(mfaToken);
  }

  @Mutation(() => LoginResponse)
  async confirmTotpSetup(
    @Arg('data') data: TotpInput,
    @Ctx() ctx: Context
  ): Promise<LoginResponse> {
    return this.auth.confirmTotpSetup(data.mfaToken, data.code, ctx);
  }

  @Mutation(() => LoginResponse)
  async verifyLoginCode(
    @Arg('data') data: LoginCodeInput,
    @Ctx() ctx: Context
  ): Promise<LoginResponse> {
    return this.auth.verifyLoginCode(data.mfaToken, data.code, ctx);
  }

  // Customer two-factor settings

  @Authorized()
  @Mutation(() => TotpSetup)
  async beginTwoFactorSetup(
    @Arg('data') data: BeginTwoFactorSetupInput,
    @Ctx() ctx: Context
  ): Promise<TotpSetup> {
    return this.twoFactor.beginSetup(ctx.user!, data.password);
  }

  @Authorized()
  @Mutation(() => BackupCodes)
  async enableTwoFactor(
    @Arg('data') data: TwoFactorCodeInput,
    @Ctx() ctx: Context
  ): Promise<BackupCodes> {
    return { codes: await this.twoFactor.enable(ctx.user!, data.code, ctx) };
  }

  @Authorized()
  @Mutation(() => BackupCodes)
  async regenerateBackupCodes(
    @Arg('data') data: TwoFactorCodeInput,
    @Ctx() ctx: Context
  ): Promise<BackupCodes> {
    return { codes: await this.twoFactor.regenerateBackupCodes(ctx.user!, data.code, ctx) };
  }

  @Authorized()
  @Mutation(() => User)
  async disableTwoFactor(
    @Arg('data') data: DisableTwoFactorInput,
    @Ctx() ctx: Context
  ): Promise<User> {
    return this.twoFactor.disable(ctx.user!, data.password, data.code, ctx);
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => User)
  async resetCustomerTwoFactor(
    @Arg('customerId', () => ID) customerId: string,
    @Ctx() ctx: Context
  ): Promise<User> {
    const customer = await this.customers.getById(customerId);
    const user = customer && (await this.service.getUserById(customer.userId));
    if (!user) throw new AppError('Customer not found');
    return this.twoFactor.adminReset(user, ctx);
  }

  @Authorized()
  @Mutation(() => User)
  async verifyEmail(@Arg('data') data: VerifyEmailInput, @Ctx() ctx: Context): Promise<User> {
    return this.auth.verifyEmail(ctx.user!, data.code);
  }

  @Authorized()
  @Mutation(() => SuccessResponse)
  async resendVerification(@Ctx() ctx: Context): Promise<SuccessResponse> {
    await this.auth.resendVerification(ctx.user!);
    return { success: true };
  }

  @Mutation(() => SuccessResponse)
  async requestPasswordReset(
    @Arg('data') data: RequestPasswordResetInput,
    @Ctx() ctx: Context
  ): Promise<SuccessResponse> {
    await this.auth.requestPasswordReset(data.email, !!data.isAdmin, ctx);
    return { success: true };
  }

  @Mutation(() => SuccessResponse)
  async resetPassword(
    @Arg('data') data: ResetPasswordInput,
    @Ctx() ctx: Context
  ): Promise<SuccessResponse> {
    await this.auth.resetPassword(data.token, data.password, ctx);
    return { success: true };
  }

  @Authorized()
  @Mutation(() => LoginResponse)
  async updatePassword(
    @Arg('data') data: UpdatePasswordInput,
    @Ctx() ctx: Context
  ): Promise<LoginResponse> {
    return this.auth.updatePassword(ctx.user!, data.oldPassword, data.newPassword, ctx);
  }

  @Authorized()
  @Mutation(() => User)
  async updateProfile(@Arg('data') data: UpdateProfileInput, @Ctx() ctx: Context): Promise<User> {
    const name = data.name.trim();
    const customer = ctx.customer ?? (await this.customers.getByUserId(ctx.user!.id));
    if (name !== ctx.user!.name && customer && customer.kycStatus !== KycStatus.not_started) {
      throw new AppError(
        'Your name is locked after identity verification starts. Contact support to change it.',
        { field: 'name' }
      );
    }
    return this.service.updateUser(ctx.user!.id, { name });
  }

  @Authorized()
  @Query(() => User)
  async me(@Ctx() ctx: Context): Promise<User> {
    if (!ctx.user) throw new UnauthenticatedError();
    return ctx.user;
  }

  @FieldResolver(() => Int, {
    nullable: true,
    description: 'Unused backup codes; only for the signed-in user',
  })
  backupCodesRemaining(@Root() user: User, @Ctx() ctx: Context) {
    if (ctx.user?.id !== user.id || !ctx.user.totpEnabled) return null;
    return this.twoFactor.backupCodesRemaining(ctx.user);
  }

  @FieldResolver(() => Customer, { nullable: true })
  async customer(@Root() user: User, @Ctx() ctx: Context) {
    if (ctx.user?.id === user.id && ctx.customer !== undefined) return ctx.customer;
    return ctx.dataLoader.get('customerByUserLoader').load(user.id);
  }

  // Staff management

  @Authorized([UserRole.Admin])
  @Query(() => UsersResponse)
  async staffUsers(
    @Args() query: UserQueryArgs,
    @Info() info: GraphQLResolveInfo
  ): Promise<UsersResponse> {
    const fields = graphqlFields(info);

    const [total, users] = await Promise.all([
      'total' in fields ? this.service.getStaffUsersCount(query) : undefined,
      'users' in fields ? this.service.getStaffUsers(query) : undefined,
    ]);

    return { total, users };
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => User)
  async createStaffUser(
    @Arg('data') data: CreateStaffUserInput,
    @Ctx() ctx: Context
  ): Promise<User> {
    return this.auth.createStaffUser(data, ctx);
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => User)
  async updateStaffUser(
    @Arg('data') data: UpdateStaffUserInput,
    @Ctx() ctx: Context
  ): Promise<User> {
    return this.auth.updateStaffUser(data, ctx);
  }

  @Authorized([UserRole.Admin])
  @Mutation(() => User)
  async resetStaffTotp(@Arg('id', () => ID) id: string, @Ctx() ctx: Context): Promise<User> {
    return this.auth.resetStaffTotp(id, ctx);
  }
}
