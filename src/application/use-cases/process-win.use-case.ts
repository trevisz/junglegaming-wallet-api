import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { ProcessWinCommand } from '../dtos/process-win.dto';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';
import { TransactionKind } from '../../domain/enums/transaction-kind.enum';
import { LedgerDirection } from '../../domain/enums/ledger-direction.enum';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { BusinessMetricsService } from '../../infrastructure/observability/business-metrics.service';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../../domain/events/wagering.events';

@Injectable()
export class ProcessWinUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTxRepo: WagerTransactionRepository,
    private readonly em: EntityManager,
    private readonly outbox: OutboxService,
    private readonly metrics: BusinessMetricsService,
  ) {}

  async execute(command: ProcessWinCommand): Promise<WagerTransaction> {
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
        this.metrics.duplicate('idempotency');
        return innerTx;
      }

      const winTx = WagerTransaction.create({
        id: command.transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: command.payloadHash,
        walletId: wallet.id,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: TransactionKind.Win,
        amount: moneyAmount,
      });

      const entryId = crypto.randomUUID();
      const balanceBefore = wallet.balance;
      const entry = wallet.credit(moneyAmount, winTx.id, entryId);
      winTx.markAsProcessed();
      winTx.setResultBalance(wallet.balance);

      await this.wagerTxRepo.save(winTx);
      await this.walletRepo.save(wallet, entry);
      this.outbox.enqueue(new WalletBalanceChanged({
        eventId: crypto.randomUUID(),
        aggregateId: wallet.id,
        correlationId: command.idempotencyKey,
        data: {
          walletId: wallet.id,
          transactionId: winTx.id,
          direction: LedgerDirection.Credit,
          money: moneyAmount.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
      }));
      this.outbox.enqueue(new WagerTransactionProcessed({
        eventId: crypto.randomUUID(),
        aggregateId: winTx.id,
        correlationId: command.idempotencyKey,
        data: {
          transactionId: winTx.id,
          providerId: winTx.providerId,
          externalTransactionId: winTx.externalTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          kind: winTx.kind,
          amount: moneyAmount.toJSON(),
          status: winTx.status,
        },
      }));

      this.metrics.transaction(winTx.status, {
        transactionId: winTx.id,
        providerId: winTx.providerId,
        externalTransactionId: winTx.externalTransactionId,
        walletId: winTx.walletId,
        correlationId: winTx.idempotencyKey,
      });
      return winTx;
    });
  }
}
