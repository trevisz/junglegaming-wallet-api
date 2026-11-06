import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ProcessWagerUseCase } from './application/use-cases/process-wager.use-case';
import { ProcessWinUseCase } from './application/use-cases/process-win.use-case';
import { ProcessRollbackUseCase } from './application/use-cases/process-rollback.use-case';
import { GetBalanceUseCase } from './application/use-cases/get-balance.use-case';
import { GetStatementUseCase } from './application/use-cases/get-statement.use-case';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from './application/use-cases/get-wallet.use-case';
import { GetWalletLedgerUseCase } from './application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { GetWageringTransactionUseCase } from './application/use-cases/get-wagering-transaction.use-case';
import { WagerController } from './presentation/controllers/wager.controller';
import { WalletController } from './presentation/controllers/wallet.controller';
import { WageringController } from './presentation/controllers/wagering.controller';
import { HealthController } from './presentation/controllers/health.controller';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ProviderIdentityGuard } from './presentation/guards/provider-identity.guard';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'wagering-processor',
    }),
    DatabaseModule,
    MessagingModule,
  ],
  controllers: [
    AppController,
    WagerController,
    WalletController,
    WageringController,
    HealthController,
  ],
  providers: [
    AppService,
    ProcessWagerUseCase,
    ProcessWinUseCase,
    ProcessRollbackUseCase,
    GetBalanceUseCase,
    GetStatementUseCase,
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
    GetWageringTransactionUseCase,
    ProviderIdentityGuard,
  ],
})
export class AppModule {}
