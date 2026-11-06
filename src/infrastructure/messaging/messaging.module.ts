import { Module } from '@nestjs/common';
import { SqsMessagingService } from './sqs-messaging.service';
import { SqsWagerConsumer } from './sqs-wager.consumer';
import { InboxService } from './inbox.service';
import { PendingReferenceWorker } from './pending-reference.worker';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { OutboxService } from '../outbox/outbox.service';
import { ProcessWageringTransactionUseCase } from '../../application/use-cases/process-wagering-transaction.use-case';
import { DatabaseModule } from '../database/database.module';
import { BusinessMetricsService } from '../observability/business-metrics.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    SqsMessagingService,
    SqsWagerConsumer,
    InboxService,
    PendingReferenceWorker,
    OutboxService,
    OutboxPublisherWorker,
    ProcessWageringTransactionUseCase,
    BusinessMetricsService,
  ],
  exports: [SqsMessagingService, InboxService, OutboxService, ProcessWageringTransactionUseCase, BusinessMetricsService],
})
export class MessagingModule {}
