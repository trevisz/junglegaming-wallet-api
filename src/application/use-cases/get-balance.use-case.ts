import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';

@Injectable()
export class GetBalanceUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
  ) {}

  async execute(playerId: string, currency: string) {
    const wallet = await this.walletRepo.findByPlayerIdAndCurrency(playerId, currency);

    if (!wallet) {
      throw new NotFoundException(`Wallet not found for player ${playerId} and currency ${currency}`);
    }

    return {
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
    };
  }
}