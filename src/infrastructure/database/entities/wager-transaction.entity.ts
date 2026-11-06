import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Unique({ properties: ['idempotencyKey'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'string' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'string' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'string' })
  payloadHash!: string;

  @Index()
  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'string' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string' })
  gameId!: string;

  @Property({ fieldName: 'kind', type: 'string' })
  kind!: string;

  @Property({ fieldName: 'amount', type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ fieldName: 'currency', type: 'string', length: 3 })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', type: 'string', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Index()
  @Property({ fieldName: 'status', type: 'string' })
  status!: string;

  @Property({ fieldName: 'failure_code', type: 'string', nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'created_at', type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'processed_at', type: 'datetime', nullable: true })
  processedAt?: Date;
}