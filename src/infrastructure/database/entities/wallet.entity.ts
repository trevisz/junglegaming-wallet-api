import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ fieldName: 'currency', type: 'string', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_amount', type: 'decimal', precision: 20, scale: 2 })
  balanceAmount!: string;

  @Property({ fieldName: 'balance_currency', type: 'string', length: 3 })
  balanceCurrency!: string;

  @Property({ fieldName: 'version', type: 'number', default: 1 })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', type: 'datetime', onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}