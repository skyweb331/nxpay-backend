import { Service } from 'typedi';
import { and, or } from '@prisma/orm-postgres/orm-client';

import { PrismaService, toJson, type WebhookEventRow } from '#src/service/prisma.js';
import { QueueService } from '#src/service/queue.js';
import type { BridgeWebhookEvent } from '#src/service/bridge/index.js';
import { WebhookDispatcher } from '#src/webhook/dispatcher.js';
import { WebhookEventStatus } from '#src/graphql/enum.js';
import { AuditLogService } from '#src/entity/auditLog/auditLog.service.js';
import { NotFoundError, isSqlError } from '#src/utils/errors.js';
import type { Context } from '#src/context.js';

import type { WebhookEventQueryArgs } from './webhookEvent.type.js';

export const PROCESS_WEBHOOK_EVENT = 'process-webhook-event';
const MAX_SWEEP_ATTEMPTS = 8;

const WEBHOOK_LIST = {
  model: 'WebhookEvent',
  filterable: [
    'id',
    'bridgeEventId',
    'category',
    'type',
    'activityType',
    'objectId',
    'status',
    'receivedAt',
    'processedAt',
  ],
  sortable: ['id', 'receivedAt', 'processedAt', 'attempts', 'category', 'type', 'activityType'],
  defaultSort: 'receivedAt',
} as const;

/** Same rule as the 20261112 migration backfill. */
const activityTypeOf = (event: BridgeWebhookEvent<any>): string | null => {
  const value =
    event.event_category === 'virtual_account.activity'
      ? event.event_object?.type
      : event.event_object_status;
  return typeof value === 'string' && value ? value : null;
};

@Service()
export class WebhookEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly dispatcher: WebhookDispatcher,
    private readonly audit: AuditLogService
  ) {}

  async list(query: WebhookEventQueryArgs): Promise<WebhookEventRow[]> {
    return query.applyTo(this.prisma.orm.WebhookEvent, WEBHOOK_LIST).all();
  }

  async count(query: WebhookEventQueryArgs): Promise<number> {
    const { total } = await query
      .applyFilter(this.prisma.orm.WebhookEvent, WEBHOOK_LIST)
      .aggregate((a) => ({ total: a.count() }));
    return Number(total);
  }

  /** Stores a verified delivery once per Bridge event id. */
  async ingest(
    event: BridgeWebhookEvent<any>
  ): Promise<{ record: WebhookEventRow; created: boolean }> {
    try {
      const record = await this.prisma.orm.WebhookEvent.create({
        bridgeEventId: event.event_id,
        category: event.event_category,
        type: event.event_type,
        activityType: activityTypeOf(event),
        objectId: event.event_object_id ?? null,
        payload: toJson(event),
      });
      return { record, created: true };
    } catch (error) {
      if (!isSqlError(error, '23505')) throw error;
      const record = await this.prisma.orm.WebhookEvent.where({
        bridgeEventId: event.event_id,
      }).first();
      if (!record) throw error;
      return { record, created: false };
    }
  }

  enqueue(id: string) {
    return this.queue.sendSafe(PROCESS_WEBHOOK_EVENT, { id }, { singletonKey: `webhook-${id}` });
  }

  /** Runs the owning module's handler; throws on failure so pg-boss retries. */
  async process(id: string) {
    const record = await this.prisma.orm.WebhookEvent.where({ id }).first();
    if (!record) return;
    if (
      record.status === WebhookEventStatus.Processed ||
      record.status === WebhookEventStatus.Ignored
    )
      return;

    try {
      const outcome = await this.dispatcher.dispatch(
        record.payload as unknown as BridgeWebhookEvent<any>
      );
      await this.prisma.orm.WebhookEvent.where({ id }).update({
        status: outcome === 'ignored' ? WebhookEventStatus.Ignored : WebhookEventStatus.Processed,
        error: null,
        attempts: record.attempts + 1,
        processedAt: new Date(),
      });
    } catch (error) {
      await this.prisma.orm.WebhookEvent.where({ id }).update({
        status: WebhookEventStatus.Failed,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        attempts: record.attempts + 1,
      });
      throw error;
    }
  }

  /** Re-enqueues deliveries that were stored but never processed, and failures under the cap. */
  async sweep() {
    const pendingBefore = new Date(Date.now() - 2 * 60 * 1000);
    const failedBefore = new Date(Date.now() - 15 * 60 * 1000);
    const rows = await this.prisma.orm.WebhookEvent.where((w) =>
      or(
        and(w.status.eq(WebhookEventStatus.Pending), w.receivedAt.lt(pendingBefore)),
        and(
          w.status.eq(WebhookEventStatus.Failed),
          w.attempts.lt(MAX_SWEEP_ATTEMPTS),
          w.updatedAt.lt(failedBefore)
        )
      )
    )
      .orderBy((w) => w.id.asc())
      .limit(200)
      .select('id')
      .all();
    for (const row of rows) await this.enqueue(row.id);
    return rows.length;
  }

  async replay(id: string, ctx: Context) {
    const record = await this.prisma.orm.WebhookEvent.where({ id }).first();
    if (!record) throw new NotFoundError('Webhook event');
    const updated = await this.prisma.orm.WebhookEvent.where({ id }).update({
      status: WebhookEventStatus.Pending,
      error: null,
      processedAt: null,
    });
    await this.audit.log(ctx, {
      action: 'webhookEvent.replay',
      entity: 'WebhookEvent',
      entityId: id,
      before: { status: record.status, error: record.error },
    });
    await this.enqueue(id);
    return updated!;
  }
}
