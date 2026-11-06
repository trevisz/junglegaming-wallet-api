import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallets
        ADD CONSTRAINT chk_wallet_currency_consistent
          CHECK (balance_currency = currency);

      ALTER TABLE wager_transactions
        ADD CONSTRAINT chk_wager_amount_nonnegative
          CHECK (amount >= 0);

      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT chk_ledger_amount_nonnegative
          CHECK (amount >= 0),
        ADD CONSTRAINT chk_ledger_direction
          CHECK (direction IN ('DEBIT', 'CREDIT')),
        ADD CONSTRAINT chk_ledger_currency_consistent
          CHECK (balance_before_currency = currency AND balance_after_currency = currency),
        ADD CONSTRAINT chk_ledger_balance_math
          CHECK (
            (direction = 'CREDIT' AND balance_before_amount + amount = balance_after_amount)
            OR
            (direction = 'DEBIT' AND balance_before_amount - amount = balance_after_amount)
          );
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        DROP CONSTRAINT IF EXISTS chk_ledger_balance_math,
        DROP CONSTRAINT IF EXISTS chk_ledger_currency_consistent,
        DROP CONSTRAINT IF EXISTS chk_ledger_direction,
        DROP CONSTRAINT IF EXISTS chk_ledger_amount_nonnegative;
      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS chk_wager_amount_nonnegative;
      ALTER TABLE wallets
        DROP CONSTRAINT IF EXISTS chk_wallet_currency_consistent;
    `);
  }
}
