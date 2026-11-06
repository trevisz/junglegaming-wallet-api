import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../infrastructure/database/database.module';
import { WalletRepository } from '../../domain/repositories/wallet.repository';
import { Money } from '../../domain/value-objects/money';
import { LedgerDirection } from '../../domain/enums/ledger-direction.enum';

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
  ) {}

  async execute(walletId: string) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const entries = await this.walletRepo.findAllLedgerEntries(walletId);

    let calculated = Money.zero(wallet.currency);
    for (const entry of entries) {
      if (entry.direction === LedgerDirection.Credit) {
        calculated = calculated.add(entry.money);
      } else {
        calculated = calculated.subtract(entry.money);
      }
    }

    const stored = wallet.balance;
    const isConsistent = stored.equals(calculated);
    const difference = stored.subtract(calculated);

    if (!isConsistent) {
      this.logger.error(
        JSON.stringify({
          level: 'error',
          message: 'Wallet reconciliation mismatch detected',
          walletId,
          storedBalance: stored.toString(),
          calculatedBalance: calculated.toString(),
          difference: difference.toString(),
        }),
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: {
        amount: difference.isNegative() ? difference.negate().toString() : difference.toString(),
        currency: wallet.currency,
      },
      consistent: isConsistent,
      checkedEntries: entries.length,
    };
  }
}
