export class ProcessRollbackCommand {
  transactionId!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  originalExternalTransactionId!: string;
  amount!: string;
  currency!: string;
}
