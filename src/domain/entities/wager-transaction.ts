import { Money } from '../value-objects/money';
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

  markAsProcessed(now = new Date()): void {
    this._status = TransactionStatus.Processed;
    this._processedAt = now;
  }

  markAsRejected(code: string, now = new Date()): void {
    this._status = TransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = now;
  }

  markPendingReference(): void {
    this._status = TransactionStatus.PendingReference;
  }

  markAsFailed(code: string, now = new Date()): void {
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
}
