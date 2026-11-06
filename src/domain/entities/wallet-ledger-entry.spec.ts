import { describe, it, expect } from 'bun:test';
import { WalletLedgerEntry, InvalidLedgerMathError } from './wallet-ledger-entry';
import { LedgerDirection } from '../enums/ledger-direction.enum';
import { Money } from '../value-objects/money';

describe('WalletLedgerEntry Entity', () => {
  it('should create valid debit entry when balance math is correct', () => {
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  it('should create valid credit entry when balance math is correct', () => {
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '125.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('should throw InvalidLedgerMathError when debit math does not match', () => {
    expect(() => {
      WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        walletId: crypto.randomUUID(),
        transactionId: crypto.randomUUID(),
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '50.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '60.00', currency: 'BRL' }), // wrong math
      });
    }).toThrow(InvalidLedgerMathError);
  });
});
