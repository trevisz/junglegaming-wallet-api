import { Injectable, Logger } from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import { TransactionStatus } from '../../domain/enums/transaction-status.enum';

@Injectable()
export class BusinessMetricsService {
  private readonly logger = new Logger(BusinessMetricsService.name);
  private readonly transactions;
  private readonly duplicates;
  private readonly retries;
  private readonly deadLetters;
  private readonly lockConflicts;
  private readonly processingLatency;
  private readonly outboxLag;
  private readonly reconciliationMismatches;

  constructor(tracer: TracerService) {
    this.transactions = tracer.counter<'status'>(
      'wager_transactions_total',
      { description: 'Wagering transaction outcomes by status', labels: ['status'] },
    );
    this.duplicates = tracer.counter<'source'>(
      'wager_duplicates_total',
      { description: 'Duplicate transactions detected by persistent idempotency', labels: ['source'] },
    );
    this.retries = tracer.counter<'source'>(
      'wager_retries_total',
      { description: 'Scheduled or attempted retries by subsystem', labels: ['source'] },
    );
    this.deadLetters = tracer.counter<'reason'>(
      'wager_dlq_messages_total',
      { description: 'Messages moved to the dead-letter queue', labels: ['reason'] },
    );
    this.lockConflicts = tracer.counter(
      'wager_lock_conflicts_total',
      { description: 'PostgreSQL lock or deadlock conflicts' },
    );
    this.processingLatency = tracer.summary(
      'wager_processing_latency_seconds',
      { description: 'Wager transaction processing latency in seconds', sampleSize: 500 },
    );
    this.outboxLag = tracer.gauge(
      'wager_outbox_lag_seconds',
      { description: 'Age of the oldest pending outbox event in seconds', kind: 'ratio' },
    );
    this.reconciliationMismatches = tracer.counter(
      'wager_reconciliation_mismatches_total',
      { description: 'Wallet ledger reconciliation mismatches detected' },
    );
  }

  transaction(
    status: TransactionStatus,
    context?: {
      transactionId: string;
      providerId: string;
      externalTransactionId: string;
      walletId: string;
      correlationId: string;
    },
  ): void {
    this.transactions.increment({ status });
    if (context) {
      this.logger.log(JSON.stringify({
        level: 'info',
        event: 'wager_transaction_completed',
        status,
        ...context,
      }));
    }
  }

  duplicate(source: 'idempotency' | 'inbox'): void {
    this.duplicates.increment({ source });
  }

  retry(source: 'sqs' | 'outbox' | 'pending_reference'): void {
    this.retries.increment({ source });
  }

  deadLetter(reason: 'invalid_message'): void {
    this.deadLetters.increment({ reason });
  }

  lockConflict(): void {
    this.lockConflicts.increment();
  }

  processingTime(seconds: number): void {
    this.processingLatency.observe(seconds);
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.setValue(Math.max(0, seconds));
  }

  reconciliationMismatch(): void {
    this.reconciliationMismatches.increment();
  }
}
