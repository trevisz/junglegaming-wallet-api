import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
  ) {}

  async execute(walletId: string, limit = 50, cursor?: string) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const { items, nextCursor } = await this.walletRepo.findLedgerEntries(walletId, limit, cursor);

    return {
      items: items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt,
      })),
      nextCursor,
    };
  }
}
