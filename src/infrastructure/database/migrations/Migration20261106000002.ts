import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION prevent_wallet_ledger_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only'
          USING ERRCODE = '55000';
      END;
      $$;

      CREATE TRIGGER wallet_ledger_no_update_or_delete
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_mutation();

      CREATE TRIGGER wallet_ledger_no_truncate
      BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS wallet_ledger_no_truncate ON wallet_ledger_entries;
      DROP TRIGGER IF EXISTS wallet_ledger_no_update_or_delete ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();
    `);
  }
}
