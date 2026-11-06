import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { WAGER_TRANSACTION_REPOSITORY } from '../../infrastructure/database/database.module';
import { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository';

@Injectable()
export class GetWageringTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly wagerTxRepo: WagerTransactionRepository,
  ) {}

  async getById(transactionId: string) {
    const tx = await this.wagerTxRepo.findById(transactionId);
    if (!tx) {
      throw new NotFoundException(`Transaction ${transactionId} not found`);
    }
    return this.toResponse(tx);
  }

  async getByProviderAndExternalId(providerId: string, externalTransactionId: string) {
    const tx = await this.wagerTxRepo.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new NotFoundException(
        `Transaction with provider ${providerId} and external ID ${externalTransactionId} not found`,
      );
    }
    return this.toResponse(tx);
  }

  private toResponse(tx: any) {
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.amount.toJSON(),
      status: tx.status,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt,
    };
  }
}
