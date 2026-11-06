import { ConflictException, Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { EntityManager as SqlEntityManager } from '@mikro-orm/postgresql';
import { InboxMessageEntity } from '../database/entities/inbox-message.entity';

@Injectable()
export class InboxService {
  constructor(@Inject(EntityManager) private readonly em: SqlEntityManager) {}

  async markProcessed(consumerName: string, messageId: string, payloadHash: string): Promise<boolean> {
    const now = new Date();
    const inserted = await this.em.execute<Array<{ message_id: string }>>(
      `INSERT INTO "inbox_messages"
        ("consumer_name", "message_id", "payload_hash", "received_at", "processed_at")
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT ("consumer_name", "message_id") DO NOTHING
       RETURNING "message_id"`,
      [consumerName, messageId, payloadHash, now, now],
    );

    if (inserted.length > 0) return true;

    const previous = await this.em.findOne(InboxMessageEntity, { consumerName, messageId });
    if (!previous || previous.payloadHash !== payloadHash) {
      throw new ConflictException('SQS message id was previously received with a different payload');
    }
    return false;
  }
}
