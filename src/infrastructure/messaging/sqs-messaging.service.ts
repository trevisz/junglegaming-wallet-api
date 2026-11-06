import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';

export interface SqsQueueUrls {
  wagering: string;
  deadLetter: string;
  events: string;
}

@Injectable()
export class SqsMessagingService implements OnModuleDestroy {
  private readonly enabled = process.env.SQS_ENABLED === 'true';
  private readonly endpoint = process.env.SQS_ENDPOINT;
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: this.endpoint,
    credentials: this.endpoint
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        }
      : undefined,
  });
  private queueUrlsPromise?: Promise<SqsQueueUrls>;

  isEnabled(): boolean {
    return this.enabled;
  }

  async queueUrls(): Promise<SqsQueueUrls> {
    if (!this.enabled) {
      throw new Error('SQS is disabled. Set SQS_ENABLED=true to enable messaging.');
    }

    this.queueUrlsPromise ??= this.resolveQueueUrls().catch((error: unknown) => {
      this.queueUrlsPromise = undefined;
      throw error;
    });
    return this.queueUrlsPromise;
  }

  async checkReady(): Promise<void> {
    const urls = await this.queueUrls();
    await Promise.all(
      [urls.wagering, urls.deadLetter, urls.events].map((QueueUrl) =>
        this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    );
  }

  async publishEvent(event: Record<string, unknown>, aggregateId: string): Promise<void> {
    const { events } = await this.queueUrls();
    const eventId = String(event.eventId);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: events,
        MessageBody: JSON.stringify(event),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async receiveWagerMessages(): Promise<Message[]> {
    const { wagering } = await this.queueUrls();
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: wagering,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS) || 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    return response.Messages ?? [];
  }

  async acknowledgeWagerMessage(receiptHandle: string): Promise<void> {
    const { wagering } = await this.queueUrls();
    await this.client.send(new DeleteMessageCommand({ QueueUrl: wagering, ReceiptHandle: receiptHandle }));
  }

  async moveToDeadLetter(body: string, sourceMessageId: string, reason: string): Promise<void> {
    const { deadLetter } = await this.queueUrls();
    const messageHash = createHash('sha256').update(`${sourceMessageId}:${body}`).digest('hex');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: deadLetter,
        MessageBody: JSON.stringify({
          sourceMessageId,
          reason,
          failedAt: new Date().toISOString(),
          originalBody: body,
        }),
        MessageGroupId: 'invalid-wager-messages',
        MessageDeduplicationId: messageHash,
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.client.destroy();
  }

  private async resolveQueueUrls(): Promise<SqsQueueUrls> {
    if (this.endpoint) {
      const deadLetter = await this.resolveQueueUrl(
        process.env.SQS_DLQ_QUEUE_URL,
        process.env.SQS_DLQ_QUEUE_NAME ?? 'wager-transactions-dlq.fifo',
        { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      );
      const dlqAttributes = await this.client.send(
        new GetQueueAttributesCommand({ QueueUrl: deadLetter, AttributeNames: ['QueueArn'] }),
      );
      const deadLetterArn = dlqAttributes.Attributes?.QueueArn;
      if (!deadLetterArn) {
        throw new Error('SQS emulator did not return the dead-letter queue ARN');
      }

      const wagering = await this.resolveQueueUrl(
        process.env.SQS_WAGER_QUEUE_URL,
        process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
        {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '60',
          ReceiveMessageWaitTimeSeconds: '10',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: deadLetterArn,
            maxReceiveCount: String(Number(process.env.SQS_MAX_RECEIVE_COUNT) || 5),
          }),
        },
      );
      const events = await this.resolveQueueUrl(
        process.env.SQS_EVENT_QUEUE_URL,
        process.env.SQS_EVENT_QUEUE_NAME ?? 'wager-events.fifo',
        { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      );

      return { wagering, deadLetter, events };
    }

    const [wagering, deadLetter, events] = await Promise.all([
      this.requireQueueUrl(process.env.SQS_WAGER_QUEUE_URL, 'SQS_WAGER_QUEUE_URL'),
      this.requireQueueUrl(process.env.SQS_DLQ_QUEUE_URL, 'SQS_DLQ_QUEUE_URL'),
      this.requireQueueUrl(process.env.SQS_EVENT_QUEUE_URL, 'SQS_EVENT_QUEUE_URL'),
    ]);
    return { wagering, deadLetter, events };
  }

  private async resolveQueueUrl(
    configuredUrl: string | undefined,
    queueName: string,
    Attributes: Record<string, string>,
  ): Promise<string> {
    if (configuredUrl) return configuredUrl;
    try {
      const result = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (result.QueueUrl) return result.QueueUrl;
    } catch {
      // Create the queues in the local SQS emulator when the app starts.
    }
    const result = await this.client.send(new CreateQueueCommand({ QueueName: queueName, Attributes }));
    if (!result.QueueUrl) throw new Error(`Could not create SQS queue ${queueName}`);
    return result.QueueUrl;
  }

  private async requireQueueUrl(value: string | undefined, name: string): Promise<string> {
    if (!value) throw new Error(`${name} must be configured when SQS is enabled`);
    return value;
  }
}

