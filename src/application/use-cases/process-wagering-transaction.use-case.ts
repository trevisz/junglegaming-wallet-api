import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { Money, MoneyProps } from '../../domain/value-objects/money';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { TransactionKind } from '../../domain/enums/transaction-kind.enum';
import { TransactionStatus } from '../../domain/enums/transaction-status.enum';
import { LedgerDirection } from '../../domain/enums/ledger-direction.enum';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { computePayloadHash } from '../utils/canonical-hash.util';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from '../../domain/events/wagering.events';

export class ProcessWageringTransactionCommand {
  idempotencyKey?: string;
  providerId!: string;
  externalTransactionId!: string;
  playerId!: string;
  walletId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  money!: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Injectable()
export class ProcessWageringTransactionUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTxRepo: WagerTransactionRepository,
    private readonly outboxService: OutboxService,
    private readonly em: EntityManager,
  ) {}

  async execute(command: ProcessWageringTransactionCommand) {
    const idempotencyKey =
      command.idempotencyKey || `${command.providerId}:${command.externalTransactionId}`;

    const canonicalData = {
      gameId: command.gameId,
      kind: command.kind.toUpperCase(),
      money: {
        amount: command.money.amount,
        currency: command.money.currency.toUpperCase(),
      },
      playerId: command.playerId,
      providerId: command.providerId,
      roundId: command.roundId,
      walletId: command.walletId,
      referenceExternalTransactionId: command.referenceExternalTransactionId || null,
    };
    const payloadHash = computePayloadHash(canonicalData);

    const existingTx = await this.wagerTxRepo.findByIdempotencyKey(idempotencyKey);
    if (existingTx) {
      if (existingTx.payloadHash !== payloadHash) {
        throw new ConflictException('Idempotency key conflict with differing payload');
      }

      const wallet = await this.walletRepo.findById(existingTx.walletId);
      return {
        transactionId: existingTx.id,
        status: existingTx.status,
        balance: wallet ? wallet.balance.toJSON() : existingTx.amount.toJSON(),
        idempotentReplay: true,
      };
    }

    const money = Money.from(command.money);
    const kindUpper = command.kind.toUpperCase() as TransactionKind;

    return await this.em.transactional(async () => {
      const wallet = await this.walletRepo.findByIdWithLock(command.walletId);
      if (!wallet) {
        throw new NotFoundException(`Wallet ${command.walletId} not found`);
      }

      if (wallet.playerId !== command.playerId) {
        throw new BadRequestException('Player ID does not match wallet owner');
      }

      if (wallet.currency !== money.currency) {
        throw new BadRequestException('Currency does not match wallet currency');
      }

      const innerTx = await this.wagerTxRepo.findByIdempotencyKey(idempotencyKey);
      if (innerTx) {
        if (innerTx.payloadHash !== payloadHash) {
          throw new ConflictException('Idempotency key conflict with differing payload');
        }
        return {
          transactionId: innerTx.id,
          status: innerTx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: true,
        };
      }

      const txId = crypto.randomUUID();
      const transaction = WagerTransaction.create({
        id: txId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: wallet.id,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: kindUpper,
        amount: money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });

      if (kindUpper === TransactionKind.Bet || (kindUpper as string) === 'BET') {
        if (wallet.balance.isLessThan(money)) {
          transaction.markAsRejected('INSUFFICIENT_FUNDS');
          await this.wagerTxRepo.save(transaction);

          this.outboxService.enqueue(
            new WagerTransactionRejected({
              eventId: crypto.randomUUID(),
              aggregateId: transaction.id,
              correlationId: idempotencyKey,
              data: {
                transactionId: transaction.id,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                walletId: wallet.id,
                playerId: wallet.playerId,
                kind: transaction.kind,
                amount: money.toJSON(),
                failureCode: 'INSUFFICIENT_FUNDS',
              },
            }),
          );

          throw new UnprocessableEntityException('Insufficient wallet balance');
        }

        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;
        const entry = wallet.debit(money, transaction.id, entryId);
        transaction.markAsProcessed();

        await this.wagerTxRepo.save(transaction);
        await this.walletRepo.save(wallet, entry);

        this.outboxService.enqueue(
          new WalletBalanceChanged({
            eventId: crypto.randomUUID(),
            aggregateId: wallet.id,
            correlationId: idempotencyKey,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: LedgerDirection.Debit,
              money: money.toJSON(),
              balanceBefore: balanceBefore.toJSON(),
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );

        this.outboxService.enqueue(
          new WagerTransactionProcessed({
            eventId: crypto.randomUUID(),
            aggregateId: transaction.id,
            correlationId: idempotencyKey,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              kind: transaction.kind,
              amount: money.toJSON(),
              status: transaction.status,
            },
          }),
        );
      } else if (kindUpper === TransactionKind.Win || (kindUpper as string) === 'WIN') {
        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;
        const entry = wallet.credit(money, transaction.id, entryId);
        transaction.markAsProcessed();

        await this.wagerTxRepo.save(transaction);
        await this.walletRepo.save(wallet, entry);

        this.outboxService.enqueue(
          new WalletBalanceChanged({
            eventId: crypto.randomUUID(),
            aggregateId: wallet.id,
            correlationId: idempotencyKey,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: LedgerDirection.Credit,
              money: money.toJSON(),
              balanceBefore: balanceBefore.toJSON(),
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );

        this.outboxService.enqueue(
          new WagerTransactionProcessed({
            eventId: crypto.randomUUID(),
            aggregateId: transaction.id,
            correlationId: idempotencyKey,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              kind: transaction.kind,
              amount: money.toJSON(),
              status: transaction.status,
            },
          }),
        );
      } else if (kindUpper === TransactionKind.Loss || (kindUpper as string) === 'LOSS') {
        transaction.markAsProcessed();
        await this.wagerTxRepo.save(transaction);

        this.outboxService.enqueue(
          new WagerTransactionProcessed({
            eventId: crypto.randomUUID(),
            aggregateId: transaction.id,
            correlationId: idempotencyKey,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              kind: transaction.kind,
              amount: money.toJSON(),
              status: transaction.status,
            },
          }),
        );
      } else if (kindUpper === TransactionKind.Refund || (kindUpper as string) === 'REFUND') {
        if (!command.referenceExternalTransactionId) {
          throw new BadRequestException('REFUND requires referenceExternalTransactionId');
        }

        const ref = await this.wagerTxRepo.findByProviderAndExternalId(
          command.providerId,
          command.referenceExternalTransactionId,
        );

        if (!ref) {
          transaction.markPendingReference();
          await this.wagerTxRepo.save(transaction);

          this.outboxService.enqueue(
            new WagerTransactionPendingReference({
              eventId: crypto.randomUUID(),
              aggregateId: transaction.id,
              correlationId: idempotencyKey,
              data: {
                transactionId: transaction.id,
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                referenceExternalTransactionId: command.referenceExternalTransactionId,
                walletId: wallet.id,
              },
            }),
          );

          return {
            transactionId: transaction.id,
            status: TransactionStatus.PendingReference,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }

        if (ref.kind !== TransactionKind.Bet && (ref.kind as string) !== 'BET' && (ref.kind as string) !== 'WAGER') {
          throw new BadRequestException('REFUND can only reference a BET transaction');
        }

        if (!ref.amount.equals(money)) {
          throw new BadRequestException('REFUND amount must match reference amount');
        }

        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;
        const entry = wallet.credit(money, transaction.id, entryId);
        transaction.markAsProcessed();

        await this.wagerTxRepo.save(transaction);
        await this.walletRepo.save(wallet, entry);

        this.outboxService.enqueue(
          new WalletBalanceChanged({
            eventId: crypto.randomUUID(),
            aggregateId: wallet.id,
            correlationId: idempotencyKey,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: LedgerDirection.Credit,
              money: money.toJSON(),
              balanceBefore: balanceBefore.toJSON(),
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );

        this.outboxService.enqueue(
          new WagerTransactionProcessed({
            eventId: crypto.randomUUID(),
            aggregateId: transaction.id,
            correlationId: idempotencyKey,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              kind: transaction.kind,
              amount: money.toJSON(),
              status: transaction.status,
            },
          }),
        );
      } else if (kindUpper === TransactionKind.Rollback || (kindUpper as string) === 'ROLLBACK') {
        if (!command.referenceExternalTransactionId) {
          throw new BadRequestException('ROLLBACK requires referenceExternalTransactionId');
        }

        const ref = await this.wagerTxRepo.findByProviderAndExternalId(
          command.providerId,
          command.referenceExternalTransactionId,
        );

        if (!ref) {
          transaction.markPendingReference();
          await this.wagerTxRepo.save(transaction);

          this.outboxService.enqueue(
            new WagerTransactionPendingReference({
              eventId: crypto.randomUUID(),
              aggregateId: transaction.id,
              correlationId: idempotencyKey,
              data: {
                transactionId: transaction.id,
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                referenceExternalTransactionId: command.referenceExternalTransactionId,
                walletId: wallet.id,
              },
            }),
          );

          return {
            transactionId: transaction.id,
            status: TransactionStatus.PendingReference,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }

        const isReferenceDebit =
          ref.kind === TransactionKind.Bet ||
          (ref.kind as string) === 'BET' ||
          (ref.kind as string) === 'WAGER';

        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;

        let entry;
        if (isReferenceDebit) {
          entry = wallet.credit(money, transaction.id, entryId);
        } else {
          if (wallet.balance.isLessThan(money)) {
            transaction.markAsRejected('ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE');
            await this.wagerTxRepo.save(transaction);
            throw new UnprocessableEntityException('Rollback would cause negative balance');
          }
          entry = wallet.debit(money, transaction.id, entryId);
        }

        transaction.markAsProcessed();
        await this.wagerTxRepo.save(transaction);
        await this.walletRepo.save(wallet, entry);

        this.outboxService.enqueue(
          new WalletBalanceChanged({
            eventId: crypto.randomUUID(),
            aggregateId: wallet.id,
            correlationId: idempotencyKey,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: isReferenceDebit ? LedgerDirection.Credit : LedgerDirection.Debit,
              money: money.toJSON(),
              balanceBefore: balanceBefore.toJSON(),
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );

        this.outboxService.enqueue(
          new WagerTransactionProcessed({
            eventId: crypto.randomUUID(),
            aggregateId: transaction.id,
            correlationId: idempotencyKey,
            data: {
              transactionId: transaction.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              kind: transaction.kind,
              amount: money.toJSON(),
              status: transaction.status,
            },
          }),
        );
      } else {
        throw new BadRequestException(`Unsupported transaction kind: ${command.kind}`);
      }

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    });
  }
}
