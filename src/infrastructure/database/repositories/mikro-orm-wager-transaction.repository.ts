import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionRepository } from '../../../domain/repositories/wager-transaction.repository';
import { WagerTransaction } from '../../../domain/entities/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { Money } from '../../../domain/value-objects/money';
import { TransactionStatus } from '../../../domain/enums/transaction-status.enum';
import { TransactionKind } from '../../../domain/enums/transaction-kind.enum';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerId(playerId: string, limit = 20): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionEntity,
      { playerId },
      {
        limit,
        orderBy: { createdAt: 'DESC' },
      },
    );
    return entities.map((entity) => this.toDomain(entity));
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey: key });
    return entity ? this.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? this.toDomain(entity) : null;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    let entity = await this.em.findOne(WagerTransactionEntity, { id: transaction.id });
    if (!entity) {
      entity = this.em.create(WagerTransactionEntity, {
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        payloadHash: transaction.payloadHash,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        amount: transaction.amount.toString(),
        currency: transaction.amount.currency,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        referenceTransactionId: transaction.referenceTransactionId,
        status: transaction.status,
        failureCode: transaction.failureCode,
        createdAt: transaction.createdAt,
        processedAt: transaction.processedAt,
      });
    } else {
      entity.status = transaction.status;
      entity.failureCode = transaction.failureCode;
      entity.processedAt = transaction.processedAt;
    }

    await this.em.persist(entity).flush();
  }

  private toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const amountMoney = Money.from({ amount: entity.amount, currency: entity.currency });
    
    return (WagerTransaction as any).rehydrate ? (WagerTransaction as any).rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as TransactionKind,
      amount: amountMoney,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      status: entity.status as TransactionStatus,
      failureCode: entity.failureCode,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt,
    }) : new (WagerTransaction as any)({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as TransactionKind,
      amount: amountMoney,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      status: entity.status as TransactionStatus,
      failureCode: entity.failureCode,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt,
    });
  }
}