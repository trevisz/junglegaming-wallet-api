import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';
import { Money } from '../../domain/value-objects/money';
import type { MoneyProps } from '../../domain/value-objects/money';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { Wallet } from '../../domain/entities/wallet';
import { TransactionKind } from '../../domain/enums/transaction-kind.enum';
import { TransactionStatus } from '../../domain/enums/transaction-status.enum';
import { LedgerDirection } from '../../domain/enums/ledger-direction.enum';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { computePayloadHash } from '../utils/canonical-hash.util';
import { InboxService } from '../../infrastructure/messaging/inbox.service';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from '../../domain/events/wagering.events';
import { IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BusinessMetricsService } from '../../infrastructure/observability/business-metrics.service';

class WageringMoneyCommand {
  @Matches(/^\d+(\.\d{1,2})?$/)
  amount!: string;

  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}

export class ProcessWageringTransactionCommand {
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
  @IsString()
  providerId!: string;
  @IsString()
  externalTransactionId!: string;
  @IsString()
  playerId!: string;
  @IsString()
  walletId!: string;
  @IsString()
  roundId!: string;
  @IsString()
  gameId!: string;
  @IsString()
  kind!: string;
  @ValidateNested()
  @Type(() => WageringMoneyCommand)
  money!: MoneyProps;
  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
}

@Injectable()
export class ProcessWageringTransactionUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTxRepo: WagerTransactionRepository,
    private readonly outboxService: OutboxService,
    private readonly inboxService: InboxService,
    private readonly em: EntityManager,
    private readonly metrics: BusinessMetricsService,
  ) {}

  async execute(command: ProcessWageringTransactionCommand, inboxContext?: InboxContext) {
    const startedAt = performance.now();
    try {
      const result = await this.executeInternal(command, inboxContext);
      if ('duplicateMessage' in result && result.duplicateMessage) {
        this.metrics.duplicate('inbox');
      } else if (result.idempotentReplay) {
        this.metrics.duplicate('idempotency');
      }
      this.metrics.transaction(result.status, result.status === TransactionStatus.PendingReference ? undefined : {
        transactionId: result.transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        walletId: command.walletId,
        correlationId: command.idempotencyKey ?? `${command.providerId}:${command.externalTransactionId}`,
      });
      return result;
    } catch (error) {
      const candidate = error as { code?: string; cause?: { code?: string } };
      if (['55P03', '40P01'].includes(candidate.code ?? candidate.cause?.code ?? '')) {
        this.metrics.lockConflict();
      }
      throw error;
    } finally {
      this.metrics.processingTime((performance.now() - startedAt) / 1_000);
    }
  }

  private async executeInternal(command: ProcessWageringTransactionCommand, inboxContext?: InboxContext) {
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
    if (existingTx && existingTx.status !== TransactionStatus.PendingReference) {
      if (existingTx.payloadHash !== payloadHash) {
        throw new ConflictException('Idempotency key conflict with differing payload');
      }

      const wallet = await this.walletRepo.findById(existingTx.walletId);
      if (inboxContext) {
        const inserted = await this.em.transactional(() =>
          this.inboxService.markProcessed(inboxContext.consumerName, inboxContext.messageId, payloadHash),
        );
        if (!inserted) {
          return {
            transactionId: existingTx.id,
            status: existingTx.status,
            balance: existingTx.resultBalance?.toJSON() ?? wallet?.balance.toJSON() ?? existingTx.amount.toJSON(),
            failureCode: existingTx.failureCode,
            idempotentReplay: true,
            duplicateMessage: true,
          };
        }
      }
      return {
        transactionId: existingTx.id,
        status: existingTx.status,
        balance: existingTx.resultBalance?.toJSON() ?? wallet?.balance.toJSON() ?? existingTx.amount.toJSON(),
        failureCode: existingTx.failureCode,
        idempotentReplay: true,
      };
    }

    const money = Money.from(command.money);
    const kindUpper = command.kind.toUpperCase() as TransactionKind;

    return await this.em.transactional(async () => {
      if (inboxContext) {
        const inserted = await this.inboxService.markProcessed(
          inboxContext.consumerName,
          inboxContext.messageId,
          payloadHash,
        );
        if (!inserted) {
          const receivedTx = await this.wagerTxRepo.findByIdempotencyKey(idempotencyKey);
          if (!receivedTx) {
            throw new ConflictException('Inbox message was already processed without its wagering transaction');
          }
          const receivedWallet = await this.walletRepo.findById(receivedTx.walletId);
          return {
            transactionId: receivedTx.id,
            status: receivedTx.status,
            balance: receivedTx.resultBalance?.toJSON() ?? receivedWallet?.balance.toJSON() ?? receivedTx.amount.toJSON(),
            failureCode: receivedTx.failureCode,
            idempotentReplay: true,
            duplicateMessage: true,
          };
        }
      }

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
      if (innerTx && innerTx.status !== TransactionStatus.PendingReference) {
        if (innerTx.payloadHash !== payloadHash) {
          throw new ConflictException('Idempotency key conflict with differing payload');
        }
        return {
          transactionId: innerTx.id,
          status: innerTx.status,
          balance: innerTx.resultBalance?.toJSON() ?? wallet.balance.toJSON(),
          failureCode: innerTx.failureCode,
          idempotentReplay: true,
        };
      }

      const isReferenceRetry = innerTx?.status === TransactionStatus.PendingReference;
      const transaction = innerTx ?? WagerTransaction.create({
        id: crypto.randomUUID(),
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
          transaction.setResultBalance(wallet.balance);
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

          return {
            transactionId: transaction.id,
            status: transaction.status,
            balance: wallet.balance.toJSON(),
            failureCode: transaction.failureCode,
            idempotentReplay: false,
          };
        }

        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;
        const entry = wallet.debit(money, transaction.id, entryId);
        transaction.markAsProcessed();
        transaction.setResultBalance(wallet.balance);

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
        transaction.setResultBalance(wallet.balance);

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
        transaction.setResultBalance(wallet.balance);
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
          return this.handleMissingReference(transaction, idempotencyKey, money, wallet, isReferenceRetry);
        }

        if (ref.kind !== TransactionKind.Bet && (ref.kind as string) !== 'BET' && (ref.kind as string) !== 'WAGER') {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'INVALID_REFERENCE_KIND');
        }

        if (ref.status !== TransactionStatus.Processed) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_NOT_PROCESSED');
        }

        try {
          this.assertSameReferenceContext(ref, wallet, command.roundId, money);
        } catch {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_CONTEXT_MISMATCH');
        }

        const previousRefund = await this.wagerTxRepo.findByReferenceAndKind(
          command.providerId,
          command.referenceExternalTransactionId,
          TransactionKind.Refund,
        );
        if (previousRefund) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_ALREADY_REFUNDED');
        }

        if (!ref.amount.equals(money)) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_AMOUNT_MISMATCH');
        }

        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;
        const entry = wallet.credit(money, transaction.id, entryId);
        transaction.markAsProcessed();
        transaction.setResultBalance(wallet.balance);

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
          return this.handleMissingReference(transaction, idempotencyKey, money, wallet, isReferenceRetry);
        }

        const isReferenceDebit =
          ref.kind === TransactionKind.Bet ||
          (ref.kind as string) === 'BET' ||
          (ref.kind as string) === 'WAGER';

        if (
          ref.kind !== TransactionKind.Bet &&
          ref.kind !== TransactionKind.Wager &&
          ref.kind !== TransactionKind.Win &&
          ref.kind !== TransactionKind.Refund
        ) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'INVALID_REFERENCE_KIND');
        }

        if (ref.status !== TransactionStatus.Processed) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_NOT_PROCESSED');
        }

        try {
          this.assertSameReferenceContext(ref, wallet, command.roundId, money);
        } catch {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_CONTEXT_MISMATCH');
        }

        const previousRollback = await this.wagerTxRepo.findByReferenceAndKind(
          command.providerId,
          command.referenceExternalTransactionId,
          TransactionKind.Rollback,
        );
        if (previousRollback) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_ALREADY_ROLLED_BACK');
        }

        if (!ref.amount.equals(money)) {
          return this.rejectTransaction(transaction, idempotencyKey, money, wallet, 'REFERENCE_AMOUNT_MISMATCH');
        }

        const entryId = crypto.randomUUID();
        const balanceBefore = wallet.balance;

        let entry;
        if (isReferenceDebit) {
          entry = wallet.credit(money, transaction.id, entryId);
        } else {
          if (wallet.balance.isLessThan(money)) {
            return this.rejectTransaction(
              transaction,
              idempotencyKey,
              money,
              wallet,
              'ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE',
            );
          }
          entry = wallet.debit(money, transaction.id, entryId);
        }

        transaction.markAsProcessed();
        transaction.setResultBalance(wallet.balance);
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

  private assertSameReferenceContext(
    reference: WagerTransaction,
    wallet: { id: string; playerId: string; currency: string },
    roundId: string,
    money: Money,
  ): void {
    if (
      reference.walletId !== wallet.id ||
      reference.playerId !== wallet.playerId ||
      reference.roundId !== roundId ||
      reference.amount.currency !== wallet.currency ||
      reference.amount.currency !== money.currency
    ) {
      throw new BadRequestException('Reference transaction does not belong to this wallet, player, round, or currency');
    }
  }

  private async handleMissingReference(
    transaction: WagerTransaction,
    correlationId: string,
    money: Money,
    wallet: Wallet,
    isRetry: boolean,
  ) {
    if (isRetry && Date.now() - transaction.createdAt.getTime() >= 24 * 60 * 60 * 1_000) {
      transaction.markAsRejected('REFERENCE_NOT_FOUND');
      transaction.setResultBalance(wallet.balance);
      await this.wagerTxRepo.save(transaction);
      this.enqueueRejected(transaction, correlationId, money, 'REFERENCE_NOT_FOUND');
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    transaction.markPendingReference();
    transaction.setResultBalance(wallet.balance);
    await this.wagerTxRepo.save(transaction);
    if (!isRetry) {
      this.outboxService.enqueue(
        new WagerTransactionPendingReference({
          eventId: crypto.randomUUID(),
          aggregateId: transaction.id,
          correlationId,
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
            walletId: wallet.id,
          },
        }),
      );
    }

    return {
      transactionId: transaction.id,
      status: TransactionStatus.PendingReference,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private enqueueRejected(
    transaction: WagerTransaction,
    correlationId: string,
    money: Money,
    failureCode: string,
  ): void {
    this.outboxService.enqueue(
      new WagerTransactionRejected({
        eventId: crypto.randomUUID(),
        aggregateId: transaction.id,
        correlationId,
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          kind: transaction.kind,
          amount: money.toJSON(),
          failureCode,
        },
      }),
    );
  }

  private async rejectTransaction(
    transaction: WagerTransaction,
    correlationId: string,
    money: Money,
    wallet: Wallet,
    failureCode: string,
  ) {
    transaction.markAsRejected(failureCode);
    transaction.setResultBalance(wallet.balance);
    await this.wagerTxRepo.save(transaction);
    this.enqueueRejected(transaction, correlationId, money, failureCode);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      failureCode: transaction.failureCode,
      idempotentReplay: false,
    };
  }
}
