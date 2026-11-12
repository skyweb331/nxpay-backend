#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/02009c53c6af9a35fcffcfdb3072c301f05869af8b197c895045eac4c44b0228/contract';
import startContract from '../../snapshots/02009c53c6af9a35fcffcfdb3072c301f05869af8b197c895045eac4c44b0228/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/9b78fc8c6ebbd767deaa3016b4f16180787694bc1ace2d0f5442ffc8a993652d/contract';
import endContract from '../../snapshots/9b78fc8c6ebbd767deaa3016b4f16180787694bc1ace2d0f5442ffc8a993652d/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

const MICRODEPOSIT_EVENTS = `
  FROM "public"."webhook_events" w
  JOIN "public"."virtual_accounts" va
    ON va."bridgeVirtualAccountId" = w."payload"->'event_object'->>'virtual_account_id'
  WHERE w."category" = 'virtual_account.activity'
    AND w."payload"->'event_object'->>'type' = 'microdeposit'
    AND w."payload"->'event_object'->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$'`;

/** Microdeposits already received were only kept in the webhook log; copy them over. */
export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'microdeposits',
        columns: [
          col('amountInCents', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('bridgeActivityId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz(3)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 3 } },
          }),
          col('currency', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('customerId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('occurredAt', 'timestamptz(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 3 } },
          }),
          col('paymentRail', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('senderName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('virtualAccountId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'webhook_events',
        column: col('activityType', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'microdeposits',
        constraint: 'microdeposits_bridgeActivityId_key',
        columns: ['bridgeActivityId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'microdeposits',
        index: 'microdeposits_customerId_idx_b2a8a46c',
        columns: ['customerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'microdeposits',
        index: 'microdeposits_virtualAccountId_idx_e02ad156',
        columns: ['virtualAccountId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'microdeposits',
        foreignKey: {
          name: 'microdeposits_virtualAccountId_fkey',
          columns: ['virtualAccountId'],
          references: { schema: 'public', table: 'virtual_accounts', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      rawSql({
        id: 'data.webhook_events.activityType.backfill',
        label: 'Backfill webhook event activity types',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'copy the activity type or object status out of the payload',
            sql: `UPDATE "public"."webhook_events"
              SET "activityType" = CASE
                WHEN "category" = 'virtual_account.activity' THEN "payload"->'event_object'->>'type'
                ELSE "payload"->>'event_object_status'
              END
              WHERE "activityType" IS NULL`,
          },
        ],
        postcheck: [],
      }),
      rawSql({
        id: 'data.microdeposits.backfill',
        label: 'Copy received microdeposits from the webhook log',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'insert one row per Bridge microdeposit activity',
            sql: `INSERT INTO "public"."microdeposits"
                ("id", "bridgeActivityId", "virtualAccountId", "customerId", "amountInCents",
                 "currency", "paymentRail", "senderName", "description", "occurredAt")
              SELECT DISTINCT ON (w."payload"->'event_object'->>'id')
                gen_random_uuid(),
                w."payload"->'event_object'->>'id',
                va."id",
                va."customerId",
                round((w."payload"->'event_object'->>'amount')::numeric * 100)::int8,
                lower(coalesce(w."payload"->'event_object'->>'currency', va."sourceCurrency"::text)),
                w."payload"->'event_object'->'source'->>'payment_rail',
                w."payload"->'event_object'->'source'->>'sender_name',
                w."payload"->'event_object'->'source'->>'description',
                coalesce((w."payload"->'event_object'->>'created_at')::timestamptz, w."receivedAt")
              ${MICRODEPOSIT_EVENTS}
              ORDER BY w."payload"->'event_object'->>'id', w."receivedAt"
              ON CONFLICT ("bridgeActivityId") DO NOTHING`,
          },
        ],
        postcheck: [
          {
            description: 'every known microdeposit event has a row',
            sql: `SELECT NOT EXISTS (
                SELECT 1 ${MICRODEPOSIT_EVENTS}
                  AND NOT EXISTS (
                    SELECT 1 FROM "public"."microdeposits" m
                    WHERE m."bridgeActivityId" = w."payload"->'event_object'->>'id'
                  )
              ) AS "result"`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
