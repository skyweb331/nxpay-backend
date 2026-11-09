import './env.js';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  DB_LOG_QUERIES: bool,
  SKIP_EMAIL_VERIFICATION: bool,

  CORS_ORIGINS: list,
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_URL: z.string().url().default('http://localhost:3001'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  TOTP_ISSUER: z.string().default('NxPay Admin'),

  BRIDGE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  BRIDGE_API_URL: z.string().url().default('https://api.sandbox.bridge.xyz'),
  BRIDGE_API_KEY: z.string().default(''),
  BRIDGE_WEBHOOK_PUBLIC_KEY: z.string().default(''),
  CUSTODIAL_CHAIN: z.enum(['base', 'solana']).default('base'),
  DEFAULT_PAYOUT_CHAIN: z.enum(['base', 'solana']).default('base'),
  BRIDGE_POLL_INTERVAL_MINUTES: z.coerce.number().int().positive().default(2),
  BRIDGE_MIN_TRANSFER_IN_CENTS: z.coerce.bigint().default(100n),
  BRIDGE_LOG_BODIES: bool,
  /** Deposit account currencies to open. EUR needs Bridge to enable SEPA on the developer account. */
  ENABLED_CURRENCIES: z
    .string()
    .default('usd,eur')
    .transform((v) => [
      ...new Set(
        v
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean)
      ),
    ])
    .pipe(z.array(z.enum(['usd', 'eur'])).min(1)),

  JOBS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  WALLET_MASTER_KEYS_FILE: z.string().default(''),
  WALLET_MASTER_KEYS: z.string().default(''),
  WALLET_MASTER_KEY_CURRENT: z.string().default('v1'),
  WALLET_EXPORT_ALERT_PER_HOUR: z.coerce.number().int().positive().default(10),
  WALLET_EXPORT_LIMIT_PER_DAY: z.coerce.number().int().positive().default(3),

  MAIL_TRANSPORT: z.enum(['mailgun', 'log']).default('log'),
  MAIL_FROM: z.string().default('NxPay <no-reply@nxpay.local>'),
  OPS_ALERT_EMAIL: z.string().default('ops@nxpay.local'),
  MAILGUN_API_KEY: z.string().default(''),
  MAILGUN_DOMAIN: z.string().default(''),
  /** US: https://api.mailgun.net · EU: https://api.eu.mailgun.net */
  MAILGUN_API_URL: z.string().default('https://api.mailgun.net'),

  BLOCKED_COUNTRIES: list,
  BLOCKED_US_STATES: list,
  SENTRY_DSN: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export const isProduction = config.NODE_ENV === 'production';
export const skipEmailVerification = !isProduction && config.SKIP_EMAIL_VERIFICATION;
export const isBridgeSandbox = config.BRIDGE_ENV === 'sandbox';
