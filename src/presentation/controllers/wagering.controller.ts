import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import {
  ProcessWageringTransactionUseCase,
  ProcessWageringTransactionCommand,
} from '../../application/use-cases/process-wagering-transaction.use-case';
import { GetWageringTransactionUseCase } from '../../application/use-cases/get-wagering-transaction.use-case';
import { ProviderIdentityGuard } from '../guards/provider-identity.guard';

@Controller()
export class WageringController {
  constructor(
    private readonly processWageringTransactionUseCase: ProcessWageringTransactionUseCase,
    private readonly getWageringTransactionUseCase: GetWageringTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @UseGuards(ProviderIdentityGuard)
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: ProcessWageringTransactionCommand,
  ) {
    if (!idempotencyKeyHeader?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    body.idempotencyKey = idempotencyKeyHeader.trim();
    const result = await this.processWageringTransactionUseCase.execute(body);
    if (result.status === 'REJECTED') {
      throw new HttpException(result, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (result.status === 'PENDING_REFERENCE') {
      throw new HttpException(result, HttpStatus.ACCEPTED);
    }
    return result;
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
