import { Migration } from '@mikro-orm/migrations';

export class Migration20261105000000 extends Migration {
  async up(): Promise<void> {
    // Wallets
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wallets" (
        "id" UUID PRIMARY KEY,
        "player_id" VARCHAR(255) NOT NULL,
        "currency" VARCHAR(3) NOT NULL,
        "balance_amount" NUMERIC(20, 2) NOT NULL,
        "balance_currency" VARCHAR(3) NOT NULL,
        "version" INT NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL,
        "updated_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "chk_wallet_balance_positive" CHECK ("balance_amount" >= 0),
        CONSTRAINT "uq_wallet_player_currency" UNIQUE ("player_id", "currency")
      );
    `);

    // Wager Transactions
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wager_transactions" (
        "id" UUID PRIMARY KEY,
        "provider_id" VARCHAR(255) NOT NULL,
        "external_transaction_id" VARCHAR(255) NOT NULL,
        "idempotency_key" VARCHAR(512) NOT NULL,
        "payload_hash" VARCHAR(64) NOT NULL,
        "wallet_id" UUID NOT NULL REFERENCES "wallets"("id"),
        "player_id" VARCHAR(255) NOT NULL,
        "round_id" VARCHAR(255) NOT NULL,
        "game_id" VARCHAR(255) NOT NULL,
        "kind" VARCHAR(32) NOT NULL,
        "amount" NUMERIC(20, 2) NOT NULL,
        "currency" VARCHAR(3) NOT NULL,
        "reference_external_transaction_id" VARCHAR(255),
        "reference_transaction_id" UUID REFERENCES "wager_transactions"("id"),
        "status" VARCHAR(32) NOT NULL,
        "failure_code" VARCHAR(64),
        "created_at" TIMESTAMPTZ NOT NULL,
        "processed_at" TIMESTAMPTZ,
        CONSTRAINT "uq_provider_ext_tx" UNIQUE ("provider_id", "external_transaction_id"),
        CONSTRAINT "uq_idempotency_key" UNIQUE ("idempotency_key")
      );
    `);

    this.addSql(`
      CREATE INDEX "idx_wager_tx_wallet_id" ON "wager_transactions"("wallet_id");
      CREATE INDEX "idx_wager_tx_provider_ref" ON "wager_transactions"("provider_id", "reference_external_transaction_id");
      CREATE INDEX "idx_wager_tx_status" ON "wager_transactions"("status");
    `);

    // Ledger Entries (Imutável)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wallet_ledger_entries" (
        "id" UUID PRIMARY KEY,
        "wallet_id" UUID NOT NULL REFERENCES "wallets"("id"),
        "transaction_id" UUID NOT NULL REFERENCES "wager_transactions"("id"),
        "direction" VARCHAR(10) NOT NULL,
        "amount" NUMERIC(20, 2) NOT NULL,
        "currency" VARCHAR(3) NOT NULL,
        "balance_before_amount" NUMERIC(20, 2) NOT NULL,
        "balance_before_currency" VARCHAR(3) NOT NULL,
        "balance_after_amount" NUMERIC(20, 2) NOT NULL,
        "balance_after_currency" VARCHAR(3) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "uq_ledger_transaction" UNIQUE ("transaction_id")
      );
    `);

    this.addSql(`
      CREATE INDEX "idx_ledger_wallet_created" ON "wallet_ledger_entries"("wallet_id", "created_at" DESC);
    `);

    // Inbox Messages
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "inbox_messages" (
        "message_id" VARCHAR(255) NOT NULL,
        "consumer_name" VARCHAR(255) NOT NULL,
        "payload_hash" VARCHAR(64) NOT NULL,
        "received_at" TIMESTAMPTZ NOT NULL,
        "processed_at" TIMESTAMPTZ,
        PRIMARY KEY ("consumer_name", "message_id")
      );
    `);

    // Outbox Messages
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "outbox_messages" (
        "id" UUID PRIMARY KEY,
        "aggregate_id" VARCHAR(255) NOT NULL,
        "event_type" VARCHAR(255) NOT NULL,
        "payload" JSONB NOT NULL,
        "occurred_at" TIMESTAMPTZ NOT NULL,
        "attempts" INT NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMPTZ,
        "published_at" TIMESTAMPTZ
      );
    `);

    this.addSql(`
      CREATE INDEX "idx_outbox_pending" ON "outbox_messages"("published_at", "next_attempt_at") WHERE "published_at" IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "outbox_messages";`);
    this.addSql(`DROP TABLE IF EXISTS "inbox_messages";`);
    this.addSql(`DROP TABLE IF EXISTS "wallet_ledger_entries";`);
    this.addSql(`DROP TABLE IF EXISTS "wager_transactions";`);
    this.addSql(`DROP TABLE IF EXISTS "wallets";`);
  }
}