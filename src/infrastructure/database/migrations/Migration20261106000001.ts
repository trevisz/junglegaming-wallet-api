import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "wager_transactions"
      ADD COLUMN "reference_attempts" INT NOT NULL DEFAULT 0,
      ADD COLUMN "next_reference_attempt_at" TIMESTAMPTZ NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "wager_transactions"
      DROP COLUMN IF EXISTS "next_reference_attempt_at",
      DROP COLUMN IF EXISTS "reference_attempts";
    `);
  }
}
