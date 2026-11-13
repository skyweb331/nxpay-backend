#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0c9c0c45253063d6ba2660276ba9cf78336b41c9a2e313a24b0c58f960a39aa4/contract';
import endContract from '../../snapshots/0c9c0c45253063d6ba2660276ba9cf78336b41c9a2e313a24b0c58f960a39aa4/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/9b78fc8c6ebbd767deaa3016b4f16180787694bc1ace2d0f5442ffc8a993652d/contract';
import startContract from '../../snapshots/9b78fc8c6ebbd767deaa3016b4f16180787694bc1ace2d0f5442ffc8a993652d/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit, rawSql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'microdeposits',
        column: col('estimatedArrivalDate', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'microdeposits',
        column: col('status', 'text', {
          notNull: true,
          default: lit('funds_received'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'microdeposits',
        column: col('traceNumber', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'microdeposits',
        index: 'microdeposits_virtualAccountId_traceNumber_idx_76869d05',
        columns: ['virtualAccountId', 'traceNumber'],
      }),
      rawSql({
        id: 'data.microdeposits.traceNumber.backfill',
        label: 'Fill status and trace number on existing microdeposits',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'copy the trace number from the original activity',
            sql: `UPDATE "public"."microdeposits" m
              SET "status" = 'microdeposit',
                "traceNumber" = w."payload"->'event_object'->'source'->>'trace_number'
              FROM "public"."webhook_events" w
              WHERE w."category" = 'virtual_account.activity'
                AND w."payload"->'event_object'->>'id' = m."bridgeActivityId"`,
          },
        ],
        postcheck: [],
      }),
      rawSql({
        id: 'data.webhook_events.acctverify.requeue',
        label: 'Reprocess ignored account-verification deposits',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description: 'mark ignored ACCTVERIFY activity as pending so the sweeper records it',
            sql: `UPDATE "public"."webhook_events"
              SET "status" = 'Pending', "error" = NULL
              WHERE "category" = 'virtual_account.activity'
                AND "status" = 'Ignored'
                AND "payload"->'event_object'->'source'->>'description' ~* '\\mACCTVERIFY\\M'
                AND "payload"->'event_object'->>'amount' ~ '^0*\\.[0-9]+$'`,
          },
        ],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
