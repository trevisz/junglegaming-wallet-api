import { Module, Global } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/core';
import config from '../../mikro-orm.config';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository';

export const WALLET_REPOSITORY = 'WALLET_REPOSITORY';
export const WAGER_TRANSACTION_REPOSITORY = 'WAGER_TRANSACTION_REPOSITORY';

@Global()
@Module({
  imports: [
    MikroOrmModule.forRoot(config),
  ],
  providers: [
    {
      provide: WALLET_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmWalletRepository(em as any),
      inject: [EntityManager],
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useFactory: (em: EntityManager) => new MikroOrmWagerTransactionRepository(em as any),
      inject: [EntityManager],
    },
  ],
  exports: [WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY],
})
export class DatabaseModule {}