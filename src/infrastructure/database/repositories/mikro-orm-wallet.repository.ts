import { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { WalletRepository } from '../../../domain/repositories/wallet.repository';
import { Wallet } from '../../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';
import { LedgerDirection } from '../../../domain/enums/ledger-direction.enum';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdWithLock(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletEntity,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE }
    );
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerIdAndCurrencyWithLock(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletEntity,
      { playerId, currency },
      { lockMode: LockMode.PESSIMISTIC_WRITE }
    );
    return entity ? this.toDomain(entity) : null;
  }

  async save(wallet: Wallet, entry?: WalletLedgerEntry): Promise<void> {
    const amountStr = wallet.balance.toString();

    let entity = await this.em.findOne(WalletEntity, { id: wallet.id });
    if (!entity) {
      entity = this.em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceAmount: amountStr,
        balanceCurrency: wallet.balance.currency,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
    } else {
      entity.balanceAmount = amountStr;
      entity.version = wallet.version;
      entity.updatedAt = wallet.updatedAt;
    }

    this.em.persist(entity);

    if (entry) {
      let ledgerEntity = await this.em.findOne(WalletLedgerEntryEntity, { id: entry.id });
      if (!ledgerEntity) {
        ledgerEntity = this.em.create(WalletLedgerEntryEntity, {
          id: entry.id,
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          amount: entry.money.toString(),
          currency: entry.money.currency,
          balanceBeforeAmount: entry.balanceBefore.toString(),
          balanceBeforeCurrency: entry.balanceBefore.currency,
          balanceAfterAmount: entry.balanceAfter.toString(),
          balanceAfterCurrency: entry.balanceAfter.currency,
          createdAt: entry.createdAt,
        });
        this.em.persist(ledgerEntity);
      }
    }

    await this.em.flush();
  }

  async findLedgerEntries(
    walletId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ items: WalletLedgerEntry[]; nextCursor?: string }> {
    let where: any = { walletId };
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');
        const [createdAtStr, id] = decoded.split('|');
        const cursorDate = new Date(createdAtStr);
        where = {
          walletId,
          $or: [
            { createdAt: { $lt: cursorDate } },
            { createdAt: cursorDate, id: { $lt: id } },
          ],
        };
      } catch {
        // Fallback if cursor invalid
      }
    }

    const entities = await this.em.find(
      WalletLedgerEntryEntity,
      where,
      {
        limit: limit + 1,
        orderBy: { createdAt: 'DESC', id: 'DESC' },
      }
    );

    const hasMore = entities.length > limit;
    const itemsEntities = hasMore ? entities.slice(0, limit) : entities;
    const items = itemsEntities.map((e) => this.toLedgerDomain(e));

    let nextCursor: string | undefined;
    if (hasMore) {
      const last = itemsEntities[itemsEntities.length - 1];
      nextCursor = Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64');
    }

    return { items, nextCursor };
  }

  async findAllLedgerEntries(walletId: string): Promise<WalletLedgerEntry[]> {
    const entities = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId },
      { orderBy: { createdAt: 'ASC' } }
    );
    return entities.map((e) => this.toLedgerDomain(e));
  }

  private toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: {
        amount: entity.balanceAmount,
        currency: entity.balanceCurrency,
      },
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  private toLedgerDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: {
        amount: entity.amount,
        currency: entity.currency,
      },
      balanceBefore: {
        amount: entity.balanceBeforeAmount,
        currency: entity.balanceBeforeCurrency,
      },
      balanceAfter: {
        amount: entity.balanceAfterAmount,
        currency: entity.balanceAfterCurrency,
      },
      createdAt: entity.createdAt,
    });
  }
}
