import { Wallet } from '../entities/wallet';
import { WalletLedgerEntry } from '../entities/wallet-ledger-entry';

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | null>;
  abstract findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  abstract findByIdWithLock(id: string): Promise<Wallet | null>;
  abstract findByPlayerIdAndCurrencyWithLock(playerId: string, currency: string): Promise<Wallet | null>;
  abstract save(wallet: Wallet, entry?: WalletLedgerEntry): Promise<void>;
  abstract findLedgerEntries(
    walletId: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ items: WalletLedgerEntry[]; nextCursor?: string }>;
  abstract findAllLedgerEntries(walletId: string): Promise<WalletLedgerEntry[]>;
}
