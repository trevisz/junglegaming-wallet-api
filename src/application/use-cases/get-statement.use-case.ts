import { Injectable, Inject } from '@nestjs/common';
import { WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WagerTransactionRepository } from '../../infrastructure/database/repositories/wager-transaction.repository';
import { WagerTransaction } from '../../domain/entities/wager-transaction';

@Injectable()
export class GetStatementUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly wagerTxRepo: WagerTransactionRepository,
  ) {}

  async execute(playerId: string, limit = 20) {
    const transactions = await this.wagerTxRepo.findByPlayerId(playerId, limit);

    return transactions.map((tx: WagerTransaction) => ({
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      kind: tx.kind,
      amount: tx.amount.toString(),
      currency: tx.amount.currency,
      status: tx.status,
      createdAt: tx.createdAt,
    }));
  }
}