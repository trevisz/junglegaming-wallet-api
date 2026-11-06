import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { ProcessRollbackCommand } from '../dtos/process-rollback.dto';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';
import { TransactionKind } from '../../domain/enums/transaction-kind.enum';
import { TransactionStatus } from '../../domain/enums/transaction-status.enum';
import { LedgerDirection } from '../../domain/enums/ledger-direction.enum';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { BusinessMetricsService } from '../../infrastructure/observability/business-metrics.service';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/events/wagering.events';

@Injectable()
export class ProcessRollbackUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTxRepo: WagerTransactionRepository,
    private readonly em: EntityManager,
    private readonly outbox: OutboxService,
    private readonly metrics: BusinessMetricsService,
  ) {}

  async execute(command: ProcessRollbackCommand): Promise<WagerTransaction> {
    const existingTx = await this.wagerTxRepo.findByIdempotencyKey(command.idempotencyKey);
    if (existingTx) {
      if (command.payloadHash && existingTx.payloadHash && existingTx.payloadHash !== command.payloadHash) {
        throw new ConflictException('Idempotency key collision with different payload hash');
      }
      this.metrics.duplicate('idempotency');
      this.metrics.transaction(existingTx.status, {
        transactionId: existingTx.id,
        providerId: existingTx.providerId,
        externalTransactionId: existingTx.externalTransactionId,
        walletId: existingTx.walletId,
        correlationId: existingTx.idempotencyKey,
      });
      return existingTx;
    }

    const moneyAmount = Money.from({ amount: command.amount, currency: command.currency });

    return await this.em.transactional(async () => {
      const wallet = await this.walletRepo.findByPlayerIdAndCurrencyWithLock(
        command.playerId,
        command.currency,
      );

      if (!wallet) {
        throw new NotFoundException(`Wallet not found for player ${command.playerId} and currency ${command.currency}`);
      }

      const innerTx = await this.wagerTxRepo.findByIdempotencyKey(command.idempotencyKey);
      if (innerTx) {
        if (command.payloadHash && innerTx.payloadHash && innerTx.payloadHash !== command.payloadHash) {
          throw new ConflictException('Idempotency key collision with different payload hash');
        }
        return innerTx;
      }

      const reference = await this.wagerTxRepo.findByProviderAndExternalId(
        command.providerId,
        command.originalExternalTransactionId,
      );
      if (!reference) {
        const pendingRollback = WagerTransaction.create({
          id: command.transactionId,
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          walletId: wallet.id,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: TransactionKind.Rollback,
          amount: moneyAmount,
          referenceExternalTransactionId: command.originalExternalTransactionId,
        });
        pendingRollback.markPendingReference();
        pendingRollback.setResultBalance(wallet.balance);
        await this.wagerTxRepo.save(pendingRollback);
        this.outbox.enqueue(new WagerTransactionPendingReference({
          eventId: crypto.randomUUID(),
          aggregateId: pendingRollback.id,
          correlationId: command.idempotencyKey,
          data: {
            transactionId: pendingRollback.id,
            providerId: pendingRollback.providerId,
            externalTransactionId: pendingRollback.externalTransactionId,
            referenceExternalTransactionId: command.originalExternalTransactionId,
            walletId: wallet.id,
          },
        }));
        return pendingRollback;
      }

      const reversibleKinds = [
        TransactionKind.Bet,
        TransactionKind.Wager,
        TransactionKind.Win,
        TransactionKind.Refund,
      ];
      if (!reversibleKinds.includes(reference.kind)) {
        throw new BadRequestException('ROLLBACK can only reference a BET, WIN, or REFUND transaction');
      }
      if (reference.status !== TransactionStatus.Processed) {
        throw new ConflictException('ROLLBACK can only reference a processed transaction');
      }
      if (
        reference.walletId !== wallet.id ||
        reference.playerId !== wallet.playerId ||
        reference.roundId !== command.roundId ||
        reference.amount.currency !== wallet.currency
      ) {
        throw new BadRequestException('Referenced transaction does not belong to this wallet, player, round, or currency');
      }
      if (!reference.amount.equals(moneyAmount)) {
        throw new BadRequestException('ROLLBACK amount must match reference amount');
      }

      const previousRollback = await this.wagerTxRepo.findByReferenceAndKind(
        command.providerId,
        command.originalExternalTransactionId,
        TransactionKind.Rollback,
      );
      if (previousRollback) {
        throw new ConflictException('Reference transaction has already been rolled back');
      }

      const rollbackTx = WagerTransaction.create({
        id: command.transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: command.payloadHash,
        walletId: wallet.id,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: TransactionKind.Rollback,
        amount: moneyAmount,
        referenceExternalTransactionId: command.originalExternalTransactionId,
        referenceTransactionId: reference.id,
      });

      const entryId = crypto.randomUUID();
      const reversesDebit =
        reference.kind === TransactionKind.Bet || reference.kind === TransactionKind.Wager;
      if (!reversesDebit && wallet.balance.isLessThan(moneyAmount)) {
        rollbackTx.markAsRejected('ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE');
        rollbackTx.setResultBalance(wallet.balance);
        await this.wagerTxRepo.save(rollbackTx);
        this.outbox.enqueue(new WagerTransactionRejected({
          eventId: crypto.randomUUID(),
          aggregateId: rollbackTx.id,
          correlationId: command.idempotencyKey,
          data: {
            transactionId: rollbackTx.id,
            providerId: rollbackTx.providerId,
            externalTransactionId: rollbackTx.externalTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: rollbackTx.kind,
            amount: moneyAmount.toJSON(),
            failureCode: 'ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE',
          },
        }));
        this.metrics.transaction(rollbackTx.status, {
          transactionId: rollbackTx.id,
          providerId: rollbackTx.providerId,
          externalTransactionId: rollbackTx.externalTransactionId,
          walletId: rollbackTx.walletId,
          correlationId: rollbackTx.idempotencyKey,
        });
        return rollbackTx;
      }

      const balanceBefore = wallet.balance;
      const entry = reversesDebit
        ? wallet.credit(moneyAmount, rollbackTx.id, entryId)
        : wallet.debit(moneyAmount, rollbackTx.id, entryId);
      rollbackTx.markAsProcessed();
      rollbackTx.setResultBalance(wallet.balance);

      await this.wagerTxRepo.save(rollbackTx);
      await this.walletRepo.save(wallet, entry);
      this.outbox.enqueue(new WalletBalanceChanged({
        eventId: crypto.randomUUID(),
        aggregateId: wallet.id,
        correlationId: command.idempotencyKey,
        data: {
          walletId: wallet.id,
          transactionId: rollbackTx.id,
          direction: reversesDebit ? LedgerDirection.Credit : LedgerDirection.Debit,
          money: moneyAmount.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
      }));
      this.outbox.enqueue(new WagerTransactionProcessed({
        eventId: crypto.randomUUID(),
        aggregateId: rollbackTx.id,
        correlationId: command.idempotencyKey,
        data: {
          transactionId: rollbackTx.id,
          providerId: rollbackTx.providerId,
          externalTransactionId: rollbackTx.externalTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: rollbackTx.kind,
          amount: moneyAmount.toJSON(),
          status: rollbackTx.status,
        },
      }));

      this.metrics.transaction(rollbackTx.status, {
        transactionId: rollbackTx.id,
        providerId: rollbackTx.providerId,
        externalTransactionId: rollbackTx.externalTransactionId,
        walletId: rollbackTx.walletId,
        correlationId: rollbackTx.idempotencyKey,
      });
      return rollbackTx;
    });
  }
}
