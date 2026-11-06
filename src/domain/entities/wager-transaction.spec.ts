import { describe, it, expect } from 'bun:test';
import { WagerTransaction } from './wager-transaction';
import { TransactionKind } from '../enums/transaction-kind.enum';
import { TransactionStatus } from '../enums/transaction-status.enum';
import { Money } from '../value-objects/money';

describe('WagerTransaction Entity', () => {
  it('should initialize with PENDING status', () => {
    const tx = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'prv-1',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'prv-1:ext-1',
      payloadHash: 'hash123',
      walletId: crypto.randomUUID(),
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: TransactionKind.Bet,
      amount: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(tx.status).toBe(TransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  it('should transition to PROCESSED and become terminal', () => {
    const tx = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'prv-1',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'prv-1:ext-1',
      payloadHash: 'hash123',
      walletId: crypto.randomUUID(),
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: TransactionKind.Bet,
      amount: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    tx.markAsProcessed();
    expect(tx.status).toBe(TransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toBeDefined();
  });

  it('should transition to REJECTED with failure code', () => {
    const tx = WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'prv-1',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'prv-1:ext-1',
      payloadHash: 'hash123',
      walletId: crypto.randomUUID(),
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: TransactionKind.Bet,
      amount: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    tx.markAsRejected('INSUFFICIENT_FUNDS');
    expect(tx.status).toBe(TransactionStatus.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.isTerminal()).toBe(true);
  });
});
