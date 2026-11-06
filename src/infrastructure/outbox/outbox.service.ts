import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { OutboxMessageEntity } from '../database/entities/outbox-message.entity';
import { IntegrationEvent } from '../../domain/events/integration-event';
import { SqsMessagingService } from '../messaging/sqs-messaging.service';
import { BusinessMetricsService } from '../observability/business-metrics.service';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsMessagingService,
    private readonly metrics: BusinessMetricsService,
  ) {}

  enqueue<T>(event: IntegrationEvent<T>): OutboxMessageEntity {
    const payload = event.toJSON();
    const entity = this.em.create(OutboxMessageEntity, {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      occurredAt: event.occurredAt,
      attempts: 0,
    });
    this.em.persist(entity);
    return entity;
  }

  async publishPending(limit = 50): Promise<number> {
    if (!this.sqs.isEnabled()) return 0;

    return this.em.transactional(async (transactionalEm) => {
      const now = new Date();
      const pending = await transactionalEm.find(
        OutboxMessageEntity,
        {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        {
          limit,
          orderBy: { occurredAt: 'ASC', id: 'ASC' },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );
      this.metrics.setOutboxLag(
        pending.length === 0 ? 0 : (now.getTime() - pending[0].occurredAt.getTime()) / 1_000,
      );

      let published = 0;
      for (const message of pending) {
        try {
          await this.sqs.publishEvent(message.payload, message.aggregateId);
          message.publishedAt = new Date();
          message.nextAttemptAt = undefined;
          published += 1;
          this.logger.log(JSON.stringify({
            level: 'info',
            event: 'outbox_published',
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            ...this.eventContext(message.payload),
          }));
        } catch (error) {
          message.attempts += 1;
          this.metrics.retry('outbox');
          const backoffMs = Math.min(1_000 * 2 ** Math.min(message.attempts - 1, 10), 30 * 60 * 1_000);
          message.nextAttemptAt = new Date(Date.now() + backoffMs);
          this.logger.error(JSON.stringify({
            level: 'error',
            event: 'outbox_publish_failed',
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            ...this.eventContext(message.payload),
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      await transactionalEm.flush();
      return published;
    });
  }

  private eventContext(payload: Record<string, unknown>): Record<string, string> {
    const data = payload.data && typeof payload.data === 'object'
      ? payload.data as Record<string, unknown>
      : {};
    const context: Record<string, string> = {};
    for (const key of ['correlationId', 'transactionId', 'walletId', 'providerId', 'externalTransactionId'] as const) {
      const value = key === 'correlationId' ? payload[key] : data[key];
      if (typeof value === 'string') context[key] = value;
    }
    return context;
  }
}
