import { WagerTransaction } from '../entities/wager-transaction';

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | null>;
  abstract findByPlayerId(playerId: string, limit?: number): Promise<WagerTransaction[]>;
  abstract findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  abstract findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  abstract findByReferenceAndKind(providerId: string, referenceExternalTransactionId: string, kind: string): Promise<WagerTransaction | null>;
  abstract claimPendingReferenceCandidates(limit?: number, now?: Date, leaseMs?: number): Promise<WagerTransaction[]>;
  abstract schedulePendingReferenceRetry(transactionId: string, now?: Date): Promise<void>;
  abstract save(transaction: WagerTransaction): Promise<void>;
}
