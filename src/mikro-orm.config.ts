import { Options, defineConfig } from '@mikro-orm/postgresql';
import { Migration20261105000000 } from './infrastructure/database/migrations/Migration20261105000000';
import { Migration20261106000001 } from './infrastructure/database/migrations/Migration20261106000001';
import { Migration20261106000002 } from './infrastructure/database/migrations/Migration20261106000002';
import { Migration20261106000003 } from './infrastructure/database/migrations/Migration20261106000003';
import { Migration20261106000004 } from './infrastructure/database/migrations/Migration20261106000004';
import { WalletEntity } from './infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from './infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './infrastructure/database/entities/wallet-ledger-entry.entity';
import { InboxMessageEntity } from './infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from './infrastructure/database/entities/outbox-message.entity';

const config: Options = defineConfig({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dbName: process.env.DB_NAME || 'jungle_wagering',
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  discovery: {
    warnWhenNoEntities: false,
  },
  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    migrationsList: [
      {
        name: 'Migration20261105000000',
        class: Migration20261105000000,
      },
      {
        name: 'Migration20261106000001',
        class: Migration20261106000001,
      },
      {
        name: 'Migration20261106000002',
        class: Migration20261106000002,
      },
      {
        name: 'Migration20261106000003',
        class: Migration20261106000003,
      },
      {
        name: 'Migration20261106000004',
        class: Migration20261106000004,
      },
    ],
  },
  ensureDatabase: true,
});

export default config;
