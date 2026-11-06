import { Money } from '../value-objects/money';
import type { MoneyProps } from '../value-objects/money';
import { TransactionStatus } from '../enums/transaction-status.enum';
import { TransactionKind } from '../enums/transaction-kind.enum';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  amount: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: TransactionStatus;
  failureCode?: string;
  createdAt: Date;
  processedAt?: Date;
  resultBalance?: MoneyProps;
}

export class InvalidTransactionStateError extends Error {
  constructor(status: TransactionStatus, operation: string) {
    super(`Cannot ${operation} a transaction in ${status} status`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: TransactionKind,
    public readonly amount: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly referenceTransactionId: string | undefined,
    private _status: TransactionStatus,
    private _failureCode: string | undefined,
    public readonly createdAt: Date,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
  ) {}

  static create(props: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: TransactionKind;
    amount: Money;
    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;
  }): WagerTransaction {
    if (
      (props.kind === TransactionKind.Refund || props.kind === TransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference transaction`);
    }
    if (props.kind === TransactionKind.Opening && props.providerId !== 'INTERNAL') {
      throw new InvalidWagerTransactionError('OPENING transactions are internal only');
    }

    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.amount,
      props.referenceExternalTransactionId,
      props.referenceTransactionId,
      TransactionStatus.Pending,
      undefined,
      now,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.amount,
      state.referenceExternalTransactionId,
      state.referenceTransactionId,
      state.status,
      state.failureCode,
      state.createdAt,
      state.processedAt,
      state.resultBalance ? Money.from(state.resultBalance) : undefined,
    );
  }

  get status(): TransactionStatus {
    return this._status;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  setResultBalance(balance: Money): void {
    this._resultBalance = balance;
  }

  markAsProcessed(now = new Date()): void {
    this.assertCanTransition('mark as processed');
    this._status = TransactionStatus.Processed;
    this._processedAt = now;
  }

  markAsRejected(code: string, now = new Date()): void {
    this.assertCanTransition('mark as rejected');
    this._status = TransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = now;
  }

  markPendingReference(): void {
    this.assertCanTransition('mark as pending reference');
    this._status = TransactionStatus.PendingReference;
  }

  markAsFailed(code: string, now = new Date()): void {
    this.assertCanTransition('mark as failed');
    this._status = TransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = now;
  }

  isTerminal(): boolean {
    return (
      this._status === TransactionStatus.Processed ||
      this._status === TransactionStatus.Rejected ||
      this._status === TransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== TransactionKind.Loss;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  private assertCanTransition(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, operation);
    }
  }
}
