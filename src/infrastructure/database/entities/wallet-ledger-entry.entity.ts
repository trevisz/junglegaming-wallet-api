import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['transactionId'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Index()
  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ fieldName: 'direction', type: 'string' })
  direction!: string;

  @Property({ fieldName: 'amount', type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ fieldName: 'currency', type: 'string', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before_amount', type: 'decimal', precision: 20, scale: 2 })
  balanceBeforeAmount!: string;

  @Property({ fieldName: 'balance_before_currency', type: 'string', length: 3 })
  balanceBeforeCurrency!: string;

  @Property({ fieldName: 'balance_after_amount', type: 'decimal', precision: 20, scale: 2 })
  balanceAfterAmount!: string;

  @Property({ fieldName: 'balance_after_currency', type: 'string', length: 3 })
  balanceAfterCurrency!: string;

  @Property({ fieldName: 'created_at', type: 'datetime' })
  createdAt: Date = new Date();
}