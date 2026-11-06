import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'string' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'string' })
  eventType!: string;

  @Property({ type: 'json', fieldName: 'payload' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', type: 'datetime' })
  occurredAt: Date = new Date();

  @Property({ fieldName: 'attempts', type: 'number', default: 0 })
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', type: 'datetime', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'published_at', type: 'datetime', nullable: true })
  publishedAt?: Date;
}