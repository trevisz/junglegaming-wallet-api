import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxService } from '../outbox/outbox.service';
import { SqsMessagingService } from './sqs-messaging.service';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private publishPromise?: Promise<void>;

  constructor(
    private readonly outbox: OutboxService,
    private readonly sqs: SqsMessagingService,
  ) {}

  onModuleInit(): void {
    if (!this.sqs.isEnabled()) return;
    this.running = true;
    this.publishPromise = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.publishPromise;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.outbox.publishPending();
      } catch (error) {
        this.logger.error(JSON.stringify({
          level: 'error',
          event: 'outbox_poll_failed',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
