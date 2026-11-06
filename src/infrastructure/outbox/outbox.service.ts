import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { OutboxMessageEntity } from '../database/entities/outbox-message.entity';
import { IntegrationEvent } from '../../domain/events/integration-event';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly em: EntityManager) {}

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
    const pending = await this.em.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
      },
      {
        limit,
        orderBy: { occurredAt: 'ASC' },
      },
    );

    const now = new Date();
    for (const message of pending) {
      message.publishedAt = now;
      this.logger.log(JSON.stringify({
        level: 'info',
        message: 'Outbox event published',
        eventId: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
      }));
    }

    if (pending.length > 0) {
      await this.em.flush();
    }

    return pending.length;
  }
}
