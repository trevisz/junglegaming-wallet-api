import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { Wallet } from '../../domain/entities/wallet';
import { Money } from '../../domain/value-objects/money';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { TransactionKind } from '../../domain/enums/transaction-kind.enum';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { WalletBalanceChanged } from '../../domain/events/wagering.events';

export class CreateWalletCommand {
  playerId!: string;
  initialBalance!: {
    amount: string;
    currency: string;
  };
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTxRepo: WagerTransactionRepository,
    private readonly outboxService: OutboxService,
    private readonly em: EntityManager,
  ) {}

  async execute(command: CreateWalletCommand) {
    const existing = await this.walletRepo.findByPlayerIdAndCurrency(
      command.playerId,
      command.initialBalance.currency,
    );

    if (existing) {
      throw new ConflictException(
        `Wallet already exists for player ${command.playerId} and currency ${command.initialBalance.currency}`,
      );
    }

    const initialMoney = Money.from(command.initialBalance);
    const walletId = crypto.randomUUID();

    return await this.em.transactional(async () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: initialMoney,
      });

      if (initialMoney.isPositive()) {
        const openingTxId = crypto.randomUUID();
        const openingEntryId = crypto.randomUUID();

        const openingTx = WagerTransaction.create({
          id: openingTxId,
          providerId: 'INTERNAL',
          externalTransactionId: `OPENING-${openingTxId}`,
          idempotencyKey: `OPENING:${walletId}`,
          payloadHash: 'OPENING',
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'OPENING',
          gameId: 'INTERNAL',
          kind: TransactionKind.Opening,
          amount: initialMoney,
        });

        openingTx.markAsProcessed();

        const zeroMoney = Money.zero(initialMoney.currency);
        const { WalletLedgerEntry } = await import('../../domain/entities/wallet-ledger-entry');
        const { LedgerDirection } = await import('../../domain/enums/ledger-direction.enum');

        const ledgerEntry = WalletLedgerEntry.create({
          id: openingEntryId,
          walletId: wallet.id,
          transactionId: openingTx.id,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: zeroMoney,
          balanceAfter: initialMoney,
        });

        await this.wagerTxRepo.save(openingTx);
        await this.walletRepo.save(wallet, ledgerEntry);

        this.outboxService.enqueue(
          new WalletBalanceChanged({
            eventId: crypto.randomUUID(),
            aggregateId: wallet.id,
            correlationId: openingTx.id,
            data: {
              walletId: wallet.id,
              transactionId: openingTx.id,
              direction: LedgerDirection.Credit,
              money: initialMoney.toJSON(),
              balanceBefore: zeroMoney.toJSON(),
              balanceAfter: initialMoney.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );
      } else {
        await this.walletRepo.save(wallet);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
