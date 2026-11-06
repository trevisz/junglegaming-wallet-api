import { describe, expect, it } from 'bun:test';
import { Money } from '../value-objects/money';
import { InsufficientBalanceError, Wallet } from './wallet';
import { LedgerDirection } from '../enums/ledger-direction.enum';

describe('Wallet Aggregate', () => {
  it('should debit balance and generate valid ledger entry', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.debit(
      Money.from({ amount: '40.00', currency: 'BRL' }),
      'tx-1',
      'entry-1',
    );

    expect(wallet.balance.toString()).toBe('60.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('60.00');
  });

  it('should throw InsufficientBalanceError when debit exceeds balance', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit(Money.from({ amount: '60.00', currency: 'BRL' }), 'tx-1', 'entry-1'),
    ).toThrow(InsufficientBalanceError);
  });

  it('should credit balance and increment version', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const entry = wallet.credit(
      Money.from({ amount: '25.00', currency: 'BRL' }),
      'tx-2',
      'entry-2',
    );

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });
});