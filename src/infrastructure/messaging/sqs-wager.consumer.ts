import { BadRequestException, HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager, RequestContext } from '@mikro-orm/core';
import { Message } from '@aws-sdk/client-sqs';
import { ProcessWageringTransactionCommand, ProcessWageringTransactionUseCase } from '../../application/use-cases/process-wagering-transaction.use-case';
import { SqsMessagingService } from './sqs-messaging.service';
import { BusinessMetricsService } from '../observability/business-metrics.service';

interface WagerTransactionRequested {
  messageId?: string;
  type: 'WagerTransactionRequested';
  occurredAt?: string;
  data: ProcessWageringTransactionCommand & { idempotencyKey: string };
}

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private pollPromise?: Promise<void>;

  constructor(
    private readonly sqs: SqsMessagingService,
    private readonly processWageringTransaction: ProcessWageringTransactionUseCase,
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly metrics: BusinessMetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.sqs.isEnabled()) return;
    this.running = true;
    this.pollPromise = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.pollPromise;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.sqs.receiveWagerMessages();
        for (const message of messages) {
          await this.handleMessage(message);
        }
      } catch (error) {
        this.logger.error(JSON.stringify({
          level: 'error',
          event: 'sqs_receive_failed',
          error: error instanceof Error ? error.message : String(error),
        }));
        await this.delay(1_000);
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !message.Body) return;
    const messageId = message.MessageId ?? 'unknown-message-id';

    let envelope: WagerTransactionRequested;
    try {
      envelope = JSON.parse(message.Body) as WagerTransactionRequested;
      this.validateEnvelope(envelope);
    } catch (error) {
      try {
        await this.sqs.moveToDeadLetter(
          message.Body,
          messageId,
          error instanceof Error ? error.message : 'Invalid SQS message',
        );
        this.metrics.deadLetter('invalid_message');
        await this.sqs.acknowledgeWagerMessage(message.ReceiptHandle);
        this.logger.warn(JSON.stringify({
          level: 'warn',
          event: 'sqs_message_moved_to_dlq',
          messageId,
          reason: error instanceof Error ? error.message : 'Invalid SQS message',
        }));
      } catch (deadLetterError) {
        this.logger.error(JSON.stringify({
          level: 'error',
          event: 'sqs_dlq_publish_failed',
          messageId,
          error: deadLetterError instanceof Error ? deadLetterError.message : String(deadLetterError),
        }));
      }
      return;
    }

    try {
      const command: ProcessWageringTransactionCommand = {
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        idempotencyKey: envelope.data.idempotencyKey,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        money: envelope.data.money,
        referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
      };
      const result = await RequestContext.create(this.em, () =>
        this.processWageringTransaction.execute(command, {
          consumerName: 'wager-transactions',
          messageId: envelope.messageId ?? messageId,
        }),
      );
      if (result.status === 'REJECTED' || ('duplicateMessage' in result && result.duplicateMessage)) {
        await this.sqs.acknowledgeWagerMessage(message.ReceiptHandle);
        return;
      }
      await this.sqs.acknowledgeWagerMessage(message.ReceiptHandle);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        this.logger.warn(JSON.stringify({
          level: 'warn',
          event: 'sqs_business_rejection',
          messageId,
          providerId: envelope.data.providerId,
          externalTransactionId: envelope.data.externalTransactionId,
          walletId: envelope.data.walletId,
          correlationId: envelope.data.idempotencyKey,
          statusCode: error.getStatus(),
          error: error.message,
        }));
        await this.sqs.acknowledgeWagerMessage(message.ReceiptHandle);
        return;
      }

      this.logger.error(JSON.stringify({
        level: 'error',
        event: 'sqs_wager_processing_failed',
        messageId,
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        walletId: envelope.data.walletId,
        correlationId: envelope.data.idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      }));
      this.metrics.retry('sqs');
    }
  }

  private validateEnvelope(envelope: WagerTransactionRequested): void {
    if (!envelope || envelope.type !== 'WagerTransactionRequested' || !envelope.data) {
      throw new BadRequestException('Expected a WagerTransactionRequested envelope');
    }
    const data = envelope.data;
    if (
      !data.providerId ||
      !data.externalTransactionId ||
      !data.idempotencyKey ||
      !data.playerId ||
      !data.walletId ||
      !data.roundId ||
      !data.gameId ||
      !data.kind ||
      !data.money?.amount ||
      !data.money?.currency
    ) {
      throw new BadRequestException('Wager transaction message is missing required business fields');
    }
    const kind = data.kind.toUpperCase();
    if (!['BET', 'WAGER', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) {
      throw new BadRequestException('Unsupported wagering transaction kind');
    }
    if (
      typeof data.money.amount !== 'string' ||
      !/^\d+(\.\d{1,2})?$/.test(data.money.amount) ||
      typeof data.money.currency !== 'string' ||
      !/^[A-Za-z]{3}$/.test(data.money.currency)
    ) {
      throw new BadRequestException('Wager transaction message contains invalid money data');
    }
    if ((kind === 'REFUND' || kind === 'ROLLBACK') && !data.referenceExternalTransactionId) {
      throw new BadRequestException(`${kind} requires referenceExternalTransactionId`);
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
