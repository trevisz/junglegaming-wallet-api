import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ProcessWageringTransactionUseCase,
  ProcessWageringTransactionCommand,
} from '../../application/use-cases/process-wagering-transaction.use-case';
import { GetWageringTransactionUseCase } from '../../application/use-cases/get-wagering-transaction.use-case';

@Controller()
export class WageringController {
  constructor(
    private readonly processWageringTransactionUseCase: ProcessWageringTransactionUseCase,
    private readonly getWageringTransactionUseCase: GetWageringTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: ProcessWageringTransactionCommand,
  ) {
    if (idempotencyKeyHeader) {
      body.idempotencyKey = idempotencyKeyHeader;
    }
    return await this.processWageringTransactionUseCase.execute(body);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return await this.getWageringTransactionUseCase.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return await this.getWageringTransactionUseCase.getByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
