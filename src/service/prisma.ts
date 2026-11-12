import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Service } from 'typedi';
import postgres from '@prisma/orm-postgres/runtime';
import type { SqlMiddleware } from '@prisma/orm-postgres/family-runtime';
import type { ResultType } from '@prisma/orm-postgres/components/runtime';

import type { Contract } from '../../prisma/contract.d.ts';
import contractJson from '../../prisma/contract.json' with { type: 'json' };

import { config, isProduction } from '#src/config.js';

const queryLogger: SqlMiddleware = {
  name: 'query-logger',
  familyId: 'sql',
  async afterQuery(plan, result) {
    console.log(`[db] ${result.latencyMs}ms rows=${result.rowCount} ${plan.sql}`);
  },
};

const slowQueryWarning: SqlMiddleware = {
  name: 'slow-query-warning',
  familyId: 'sql',
  async afterQuery(plan, result) {
    if (result.latencyMs > 500) {
      console.warn(`[db] slow query ${result.latencyMs}ms: ${plan.sql}`);
    }
  },
};

const createClient = () =>
  postgres<Contract>({
    contractJson,
    url: config.DATABASE_URL,
    middleware: [
      slowQueryWarning,
      ...(config.DB_LOG_QUERIES && !isProduction ? [queryLogger] : []),
    ],
  });

export type DbClient = ReturnType<typeof createClient>;
export type Orm = DbClient['orm']['public'];

// Row types (scalars only) re-exported for the rest of the app
export type UserRow = ResultType<Orm['User']>;
export type CustomerRow = ResultType<Orm['Customer']>;
export type OneTimeCodeRow = ResultType<Orm['OneTimeCode']>;
export type WalletRow = ResultType<Orm['Wallet']>;
export type WalletKeyRow = ResultType<Orm['WalletKey']>;
export type KeyVaultCanaryRow = ResultType<Orm['KeyVaultCanary']>;
export type CustodialWalletRow = ResultType<Orm['CustodialWallet']>;
export type VirtualAccountRow = ResultType<Orm['VirtualAccount']>;
export type MicrodepositRow = ResultType<Orm['Microdeposit']>;
export type TransactionRow = ResultType<Orm['Transaction']>;
export type TransactionEventRow = ResultType<Orm['TransactionEvent']>;
export type MonthlyVolumeRow = ResultType<Orm['MonthlyVolume']>;
export type FeeScheduleRow = ResultType<Orm['FeeSchedule']>;
export type FeeTierRow = ResultType<Orm['FeeTier']>;
export type SupportTicketRow = ResultType<Orm['SupportTicket']>;
export type SupportMessageRow = ResultType<Orm['SupportMessage']>;
export type AuditLogRow = ResultType<Orm['AuditLog']>;
export type WebhookEventRow = ResultType<Orm['WebhookEvent']>;
export type AppSettingRow = ResultType<Orm['AppSetting']>;

export const contract = contractJson;

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Normalizes any value for a Jsonb column (bigint becomes string, undefined is dropped). */
export const toJson = (value: unknown): JsonValue =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);

/** Stable signed 64-bit advisory lock key for a string such as `fee:42`. */
export const lockKey = (name: string): bigint =>
  createHash('sha256').update(name).digest().readBigInt64BE(0);

/**
 * Database access for services and loaders.
 *
 * `db` returns the transaction bound to the current async context (see `transaction`)
 * or the shared client, so services written against `this.prisma.db` join an
 * enclosing `@Transaction()` automatically.
 */
@Service()
export class PrismaService {
  readonly client: DbClient = createClient();
  private readonly als = new AsyncLocalStorage<any>();

  get db(): DbClient {
    return (this.als.getStore() as DbClient | undefined) ?? this.client;
  }

  get orm(): Orm {
    return this.db.orm.public;
  }

  get inTransaction(): boolean {
    return this.als.getStore() !== undefined;
  }

  /**
   * Runs `fn` in a database transaction. Nested calls join the outer transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn();
    }
    return this.client.transaction((tx) => this.als.run(tx, fn));
  }

  /** Runs a built SQL plan (raw lane or SQL builder) on the current transaction or client. */
  async query<Row>(plan: unknown): Promise<Row[]> {
    const store = this.als.getStore();
    if (store) {
      return (await store.query(plan)) as Row[];
    }
    return (await this.client.runtime().query(plan as any)) as Row[];
  }

  /** Transaction-scoped advisory lock (released on commit/rollback). Must run inside `transaction`. */
  async advisoryXactLock(key: bigint): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('advisoryXactLock must run inside a transaction');
    }
    const plan = this.client.raw.sql`SELECT pg_advisory_xact_lock(${key}::bigint) IS NULL AS ok`
      .returnsRow({ ok: 'pg/bool@1' } as any)
      .build();
    await this.query(plan);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
