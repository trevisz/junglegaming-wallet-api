import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager, RequestContext } from '@mikro-orm/core';
import { TransactionStatus } from '../../domain/enums/transaction-status.enum';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { ProcessWageringTransactionUseCase } from '../../application/use-cases/process-wagering-transaction.use-case';
import { SqsMessagingService } from './sqs-messaging.service';
import { WAGER_TRANSACTION_REPOSITORY } from '../database/database.module';
import { BusinessMetricsService } from '../observability/business-metrics.service';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private workerPromise?: Promise<void>;

  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    private readonly processTransaction: ProcessWageringTransactionUseCase,
    private readonly sqs: SqsMessagingService,
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly metrics: BusinessMetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.sqs.isEnabled()) return;
    this.running = true;
    this.workerPromise = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.workerPromise;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const pending = await RequestContext.create(this.em, () =>
          this.transactions.claimPendingReferenceCandidates(25),
        );
        for (const transaction of pending) {
          if (!this.running) break;
          try {
            const result = await RequestContext.create(this.em, () =>
              this.processTransaction.execute({
                idempotencyKey: transaction.idempotencyKey,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                playerId: transaction.playerId,
                walletId: transaction.walletId,
                roundId: transaction.roundId,
                gameId: transaction.gameId,
                kind: transaction.kind,
                money: transaction.amount.toJSON(),
                referenceExternalTransactionId: transaction.referenceExternalTransactionId,
              }),
            );
            if (result.status === TransactionStatus.PendingReference) {
              this.metrics.retry('pending_reference');
              await RequestContext.create(this.em, () =>
                this.transactions.schedulePendingReferenceRetry(transaction.id),
              );
            }
          } catch (error) {
            this.metrics.retry('pending_reference');
            await RequestContext.create(this.em, () =>
              this.transactions.schedulePendingReferenceRetry(transaction.id),
            ).catch((scheduleError: unknown) => {
              this.logger.error(JSON.stringify({
                level: 'error',
                event: 'pending_reference_retry_schedule_failed',
                transactionId: transaction.id,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                walletId: transaction.walletId,
                correlationId: transaction.idempotencyKey,
                error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError),
              }));
            });
            this.logger.error(JSON.stringify({
              level: 'error',
              event: 'pending_reference_retry_failed',
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: transaction.walletId,
              correlationId: transaction.idempotencyKey,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
        if (pending.length === 0) await this.delay(1_000);
      } catch (error) {
        this.logger.error(JSON.stringify({
          level: 'error',
          event: 'pending_reference_scan_failed',
          error: error instanceof Error ? error.message : String(error),
        }));
        await this.delay(1_000);
      }
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
