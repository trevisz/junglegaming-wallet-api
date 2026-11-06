import { IsString, Matches } from 'class-validator';

export class ProcessWagerCommand {
  @IsString()
  transactionId!: string;
  @IsString()
  providerId!: string;
  @IsString()
  externalTransactionId!: string;
  @IsString()
  idempotencyKey!: string;
  @IsString()
  payloadHash!: string;
  @IsString()
  playerId!: string;
  @IsString()
  roundId!: string;
  @IsString()
  gameId!: string;
  @Matches(/^\d+(\.\d{1,2})?$/)
  amount!: string;
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}
