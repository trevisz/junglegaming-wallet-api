import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { ProcessWagerCommand } from '../dtos/process-wager.dto';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';
import { TransactionKind } from '../../domain/enums/transaction-kind.enum';
import { LedgerDirection } from '../../domain/enums/ledger-direction.enum';
import { InsufficientBalanceError } from '../../domain/entities/wallet';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { BusinessMetricsService } from '../../infrastructure/observability/business-metrics.service';
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/events/wagering.events';

@Injectable()
export class ProcessWagerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTxRepo: WagerTransactionRepository,
    private readonly em: EntityManager,
    private readonly outbox: OutboxService,
    private readonly metrics: BusinessMetricsService,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<WagerTransaction> {
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

    const outcome = await this.em.transactional(async () => {
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
        return { transaction: innerTx, rejectedForBalance: false };
      }

      const wagerTx = WagerTransaction.create({
        id: command.transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: command.payloadHash,
        walletId: wallet.id,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: TransactionKind.Bet,
        amount: moneyAmount,
      });

      if (wallet.balance.isLessThan(moneyAmount)) {
        wagerTx.markAsRejected('INSUFFICIENT_FUNDS');
        wagerTx.setResultBalance(wallet.balance);
        await this.wagerTxRepo.save(wagerTx);
        this.outbox.enqueue(new WagerTransactionRejected({
          eventId: crypto.randomUUID(),
          aggregateId: wagerTx.id,
          correlationId: command.idempotencyKey,
          data: {
            transactionId: wagerTx.id,
            providerId: wagerTx.providerId,
            externalTransactionId: wagerTx.externalTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            kind: wagerTx.kind,
            amount: moneyAmount.toJSON(),
            failureCode: 'INSUFFICIENT_FUNDS',
          },
        }));
        return { transaction: wagerTx, rejectedForBalance: true };
      }

      const entryId = crypto.randomUUID();
      const balanceBefore = wallet.balance;
      const entry = wallet.debit(moneyAmount, wagerTx.id, entryId);
      wagerTx.markAsProcessed();
      wagerTx.setResultBalance(wallet.balance);

      await this.wagerTxRepo.save(wagerTx);
      await this.walletRepo.save(wallet, entry);
      this.outbox.enqueue(new WalletBalanceChanged({
        eventId: crypto.randomUUID(),
        aggregateId: wallet.id,
        correlationId: command.idempotencyKey,
        data: {
          walletId: wallet.id,
          transactionId: wagerTx.id,
          direction: LedgerDirection.Debit,
          money: moneyAmount.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
      }));
      this.outbox.enqueue(new WagerTransactionProcessed({
        eventId: crypto.randomUUID(),
        aggregateId: wagerTx.id,
        correlationId: command.idempotencyKey,
        data: {
          transactionId: wagerTx.id,
          providerId: wagerTx.providerId,
          externalTransactionId: wagerTx.externalTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: wagerTx.kind,
          amount: moneyAmount.toJSON(),
          status: wagerTx.status,
        },
      }));

      return { transaction: wagerTx, rejectedForBalance: false };
    });
    this.metrics.transaction(outcome.transaction.status, {
      transactionId: outcome.transaction.id,
      providerId: outcome.transaction.providerId,
      externalTransactionId: outcome.transaction.externalTransactionId,
      walletId: outcome.transaction.walletId,
      correlationId: outcome.transaction.idempotencyKey,
    });
    if (outcome.rejectedForBalance) throw new InsufficientBalanceError();
    return outcome.transaction;
  }
}
