import { Service } from 'typedi';
import { generateSecret, generateURI } from 'otplib';

import { config } from '#src/config.js';
import type { Context } from '#src/context.js';
import { isStaff } from '#src/authChecker.js';
import { PrismaService, type UserRow } from '#src/service/prisma.js';
import { MailerService } from '#src/service/mailer.js';
import { RateLimiterService } from '#src/service/rateLimiter.js';
import { OtpPurpose, UserRole } from '#src/graphql/enum.js';
import {
  createAccessToken,
  createMfaChallengeToken,
  generateToken,
  hashPassword,
  passwordVersion,
  verifyMfaChallengeToken,
  verifyPassword,
} from '#src/utils/auth.js';
import { AppError, UnauthenticatedError } from '#src/utils/errors.js';
import { isUuid } from '#src/utils/id.js';

import { AuditLogService } from '#src/entity/auditLog/auditLog.service.js';
import { OneTimeCodeService, expiresIn } from '#src/entity/oneTimeCode/oneTimeCode.service.js';
import {
  CustomerService,
  assertSupportedGeography,
} from '#src/entity/customer/customer.service.js';

import { TwoFactorService } from './twoFactor.service.js';
import { normalizeEmail, UserService } from './user.service.js';
import type { CreateCustomerInput } from '#src/entity/customer/customer.type.js';
import type {
  CreateStaffUserInput,
  LoginInput,
  LoginResponse,
  TotpSetup,
  UpdateStaffUserInput,
} from './user.type.js';

const MINUTE = 60_000;
// Compared against when the email is unknown, so response time doesn't reveal accounts
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(generateToken(16)));

@Service()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly customers: CustomerService,
    private readonly codes: OneTimeCodeService,
    private readonly mailer: MailerService,
    private readonly limiter: RateLimiterService,
    private readonly audit: AuditLogService,
    private readonly twoFactor: TwoFactorService
  ) {}

  issueAccessToken(user: UserRow, mfa = false) {
    return createAccessToken({
      id: user.id,
      pv: passwordVersion(user.password),
      ...(mfa && { mfa }),
    });
  }

  /**
   * Admin creates a customer account and emails a set-password link. Public sign-up is closed.
   * The account is approved immediately so they can sign in after choosing a password.
   */
  async createCustomer(input: CreateCustomerInput, ctx: Context) {
    assertSupportedGeography(input.country, input.region);

    const user = await this.prisma.transaction(async () => {
      const user = await this.users.createUser({
        email: input.email,
        name: input.name.trim(),
        role: UserRole.Customer,
        // Unusable until the invite link sets a real password
        password: await hashPassword(generateToken(32)),
        approvedAt: new Date(),
      });
      await this.customers.create({
        userId: user.id,
        country: input.country,
        region: input.country.toUpperCase() === 'US' ? input.region : (input.region ?? null),
      });
      return user;
    });

    const token = await this.codes.issueToken(user.id, OtpPurpose.PasswordReset, { invite: true });
    this.mailer.sendSafe({
      to: user.email,
      subject: 'You have been invited to NxPay',
      template: 'customer-invite',
      locals: {
        name: user.name,
        link: `${config.FRONTEND_URL}/auth/reset-password?token=${encodeURIComponent(token)}`,
        expiresIn: expiresIn(OtpPurpose.PasswordReset),
      },
    });
    const customer = await this.customers.getByUserId(user.id);
    await this.audit.log(ctx, {
      action: 'customer.create',
      entity: 'Customer',
      entityId: customer!.id,
      after: { email: user.email, name: user.name, country: input.country, region: input.region },
    });
    return customer!;
  }

  private assertApproved(user: UserRow) {
    if (!isStaff(user.role) && !user.approvedAt) {
      throw new AppError(
        "Your account is waiting for approval. We'll email you as soon as it's ready.",
        { code: 'APPROVAL_PENDING' }
      );
    }
  }

  private async customerSignedIn(user: UserRow) {
    await this.users.updateUser(user.id, { lastLoginAt: new Date() });
    if (!user.isEmailVerified) {
      try {
        await this.resendVerification(user);
      } catch {
        // Rate limited: the verify page can resend later
      }
    }
    return {
      accessToken: this.issueAccessToken(user),
      mfaRequired: false,
      totpSetupRequired: false,
    };
  }

  async login({ email, password, isAdmin }: LoginInput, ctx: Context): Promise<LoginResponse> {
    const normalized = normalizeEmail(email);
    this.limiter.consume(`login:ip:${ctx.ip}`, 30, 15 * MINUTE);
    this.limiter.consume(`login:email:${normalized}`, 10, 15 * MINUTE);

    const user = await this.users.getUserByEmail(normalized);
    const valid = await verifyPassword(password, user?.password ?? (await getDummyHash()));
    const invalid = new AppError('Invalid email or password', { field: 'password' });
    if (!user || !valid || user.deletedAt) throw invalid;

    if (isAdmin && !isStaff(user.role)) throw invalid;
    if (!isAdmin && isStaff(user.role)) {
      throw new AppError('Staff accounts sign in through the admin console', { field: 'email' });
    }

    this.limiter.reset(`login:email:${normalized}`);
    this.assertApproved(user);

    if (isStaff(user.role)) {
      return {
        mfaRequired: user.totpEnabled,
        totpSetupRequired: !user.totpEnabled,
        mfaToken: createMfaChallengeToken(user.id),
      };
    }

    if (user.totpEnabled) {
      return {
        mfaRequired: true,
        totpSetupRequired: false,
        mfaToken: createMfaChallengeToken(user.id),
      };
    }

    return this.customerSignedIn(user);
  }

  private async userFromMfaToken(mfaToken: string, staff = true) {
    let userId: string | number;
    try {
      userId = verifyMfaChallengeToken(mfaToken);
    } catch {
      throw new UnauthenticatedError('Your sign-in session expired. Please sign in again.');
    }
    if (!isUuid(userId)) throw new UnauthenticatedError();
    const user = await this.users.getUserById(userId);
    if (!user || user.deletedAt || isStaff(user.role) !== staff) throw new UnauthenticatedError();
    return user;
  }

  private checkTotp(secret: string | null, code: string) {
    return this.twoFactor.checkTotp(secret, code);
  }

  /** Customer second step: an authenticator code or a backup code. */
  async verifyLoginCode(mfaToken: string, code: string, ctx: Context): Promise<LoginResponse> {
    const user = await this.userFromMfaToken(mfaToken, false);
    this.limiter.consume(`totp:${user.id}`, 6, 5 * MINUTE);
    if (!user.totpEnabled) throw new UnauthenticatedError();
    this.assertApproved(user);

    const factor = await this.twoFactor.verify(user, code);
    if (!factor) throw new AppError('Invalid authentication code', { field: 'code' });

    this.limiter.reset(`totp:${user.id}`);
    if (factor === 'backup') {
      await this.audit.log(
        { user, ip: ctx.ip },
        { action: 'user.loginWithBackupCode', entity: 'User', entityId: user.id }
      );
    }
    return this.customerSignedIn(user);
  }

  async verifyAdminTotp(mfaToken: string, code: string, ctx: Context): Promise<LoginResponse> {
    const user = await this.userFromMfaToken(mfaToken);
    this.limiter.consume(`totp:${user.id}`, 6, 5 * MINUTE);
    if (!user.totpEnabled) throw new AppError('Two-factor authentication is not set up');

    const result = await this.checkTotp(user.totpSecret, code);
    if (!result) throw new AppError('Invalid authentication code', { field: 'code' });

    this.limiter.reset(`totp:${user.id}`);
    await this.users.updateUser(user.id, { lastLoginAt: new Date() });
    await this.audit.log(
      { user, ip: ctx.ip },
      { action: 'staff.login', entity: 'User', entityId: user.id }
    );
    return {
      accessToken: this.issueAccessToken(user, true),
      mfaRequired: false,
      totpSetupRequired: false,
    };
  }

  async beginTotpSetup(mfaToken: string): Promise<TotpSetup> {
    const user = await this.userFromMfaToken(mfaToken);
    if (user.totpEnabled) throw new AppError('Two-factor authentication is already set up');
    const secret = generateSecret();
    await this.users.updateUser(user.id, { totpSecret: secret });
    return {
      secret,
      otpauthUrl: generateURI({ issuer: config.TOTP_ISSUER, label: user.email, secret }),
    };
  }

  async confirmTotpSetup(mfaToken: string, code: string, ctx: Context): Promise<LoginResponse> {
    const user = await this.userFromMfaToken(mfaToken);
    this.limiter.consume(`totp:${user.id}`, 6, 5 * MINUTE);
    if (user.totpEnabled) throw new AppError('Two-factor authentication is already set up');

    const result = await this.checkTotp(user.totpSecret, code);
    if (!result) throw new AppError('Invalid authentication code', { field: 'code' });

    const updated = await this.users.updateUser(user.id, {
      totpEnabled: true,
      lastLoginAt: new Date(),
    });
    await this.audit.log(
      { user, ip: ctx.ip },
      { action: 'staff.totpEnabled', entity: 'User', entityId: user.id }
    );
    return {
      accessToken: this.issueAccessToken(updated, true),
      mfaRequired: false,
      totpSetupRequired: false,
    };
  }

  async sendVerificationEmail(user: UserRow) {
    const code = await this.codes.issueCode(user.id, OtpPurpose.EmailVerify);
    this.mailer.sendSafe({
      to: user.email,
      subject: 'Verify your email',
      template: 'verify-email',
      locals: { name: user.name, code, expiresIn: expiresIn(OtpPurpose.EmailVerify) },
    });
  }

  async resendVerification(user: UserRow) {
    if (user.isEmailVerified) return;
    this.limiter.consume(`verify:${user.id}`, 5, 60 * MINUTE);
    await this.sendVerificationEmail(user);
  }

  async verifyEmail(user: UserRow, code: string) {
    if (user.isEmailVerified) return user;
    this.limiter.consume(`verify-check:${user.id}`, 10, 15 * MINUTE);
    await this.codes.consumeCode(user.id, OtpPurpose.EmailVerify, code);
    return this.users.updateUser(user.id, { isEmailVerified: true });
  }

  async requestPasswordReset(email: string, isAdmin: boolean, ctx: Context) {
    const normalized = normalizeEmail(email);
    this.limiter.consume(`reset:ip:${ctx.ip}`, 10, 60 * MINUTE);
    this.limiter.consume(`reset:email:${normalized}`, 3, 60 * MINUTE);

    const user = await this.users.getUserByEmail(normalized);
    // Same response whether or not the account exists
    if (!user || user.deletedAt || isStaff(user.role) !== isAdmin) return;

    const token = await this.codes.issueToken(user.id, OtpPurpose.PasswordReset);
    const base = isAdmin ? config.ADMIN_URL : config.FRONTEND_URL;
    this.mailer.sendSafe({
      to: user.email,
      subject: 'Reset your password',
      template: 'password-reset',
      locals: {
        name: user.name,
        link: `${base}/auth/reset-password?token=${encodeURIComponent(token)}`,
        expiresIn: expiresIn(OtpPurpose.PasswordReset),
      },
    });
  }

  async resetPassword(token: string, password: string, ctx: Context) {
    this.limiter.consume(`reset-confirm:${ctx.ip}`, 20, 60 * MINUTE);
    const { userId } = await this.codes.consumeToken(OtpPurpose.PasswordReset, token);
    const user = await this.users.getUserById(userId);
    if (!user || user.deletedAt)
      throw new AppError('This link is invalid or has expired', { field: 'token' });

    // Following the emailed link also proves ownership of the address
    await this.users.updateUser(user.id, {
      password: await hashPassword(password),
      isEmailVerified: true,
    });
    await this.audit.log(
      { user, ip: ctx.ip },
      { action: 'user.resetPassword', entity: 'User', entityId: user.id }
    );
  }

  async updatePassword(user: UserRow, oldPassword: string, newPassword: string, ctx: Context) {
    this.limiter.consume(`update-password:${user.id}`, 10, 60 * MINUTE);
    const valid = await verifyPassword(oldPassword, user.password);
    if (!valid) throw new AppError('Current password is incorrect', { field: 'oldPassword' });

    const updated = await this.users.updateUser(user.id, {
      password: await hashPassword(newPassword),
    });
    await this.audit.log(
      { user, ip: ctx.ip },
      { action: 'user.updatePassword', entity: 'User', entityId: user.id }
    );
    return {
      accessToken: this.issueAccessToken(updated, ctx.mfa),
      mfaRequired: false,
      totpSetupRequired: false,
    };
  }

  /** Password re-authentication for sensitive actions (wallet changes, key export). */
  async assertPassword(user: UserRow, password: string) {
    this.limiter.consume(`reauth:${user.id}`, 10, 60 * MINUTE);
    const valid = await verifyPassword(password, user.password);
    if (!valid) throw new AppError('Password is incorrect', { field: 'password' });
  }

  // Staff management (Admin only)

  async createStaffUser(input: CreateStaffUserInput, ctx: Context) {
    const user = await this.users.createUser({
      email: input.email,
      name: input.name.trim(),
      role: input.role,
      // Unusable until the invite link sets a real password
      password: await hashPassword(generateToken(32)),
    });
    const token = await this.codes.issueToken(user.id, OtpPurpose.PasswordReset, { invite: true });
    this.mailer.sendSafe({
      to: user.email,
      subject: 'You have been invited to NxPay Admin',
      template: 'staff-invite',
      locals: {
        name: user.name,
        role: user.role,
        link: `${config.ADMIN_URL}/auth/reset-password?token=${encodeURIComponent(token)}`,
        expiresIn: expiresIn(OtpPurpose.PasswordReset),
      },
    });
    await this.audit.log(ctx, {
      action: 'staff.create',
      entity: 'User',
      entityId: user.id,
      after: { email: user.email, name: user.name, role: user.role },
    });
    return user;
  }

  async updateStaffUser(input: UpdateStaffUserInput, ctx: Context) {
    const before = await this.users.getUserById(input.id);
    if (!before || !isStaff(before.role)) throw new AppError('Staff user not found');
    if (
      before.id === ctx.user?.id &&
      (input.disabled || (input.role && input.role !== before.role))
    ) {
      throw new AppError('You can not change your own role or disable your own account');
    }

    const updated = await this.users.updateUser(before.id, {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.disabled !== undefined && { deletedAt: input.disabled ? new Date() : null }),
    });
    await this.audit.log(ctx, {
      action: 'staff.update',
      entity: 'User',
      entityId: before.id,
      before: { name: before.name, role: before.role, disabled: !!before.deletedAt },
      after: { name: updated.name, role: updated.role, disabled: !!updated.deletedAt },
    });
    return updated;
  }

  async resetStaffTotp(id: string, ctx: Context) {
    const before = await this.users.getUserById(id);
    if (!before || !isStaff(before.role)) throw new AppError('Staff user not found');
    const updated = await this.users.updateUser(id, { totpEnabled: false, totpSecret: null });
    await this.audit.log(ctx, { action: 'staff.resetTotp', entity: 'User', entityId: id });
    return updated;
  }
}
