import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000004 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN result_balance_amount NUMERIC(20, 2),
        ADD COLUMN result_balance_currency VARCHAR(3),
        ADD CONSTRAINT chk_wager_result_balance_pair
          CHECK ((result_balance_amount IS NULL) = (result_balance_currency IS NULL)),
        ADD CONSTRAINT chk_wager_result_balance_nonnegative
          CHECK (result_balance_amount IS NULL OR result_balance_amount >= 0),
        ADD CONSTRAINT chk_wager_result_balance_currency
          CHECK (result_balance_currency IS NULL OR result_balance_currency = currency);
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS chk_wager_result_balance_currency,
        DROP CONSTRAINT IF EXISTS chk_wager_result_balance_nonnegative,
        DROP CONSTRAINT IF EXISTS chk_wager_result_balance_pair,
        DROP COLUMN IF EXISTS result_balance_currency,
        DROP COLUMN IF EXISTS result_balance_amount;
    `);
  }
}
