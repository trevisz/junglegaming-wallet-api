import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ProcessWagerUseCase } from '../../application/use-cases/process-wager.use-case';
import { ProcessWinUseCase } from '../../application/use-cases/process-win.use-case';
import { ProcessRollbackUseCase } from '../../application/use-cases/process-rollback.use-case';
import { GetBalanceUseCase } from '../../application/use-cases/get-balance.use-case';
import { GetStatementUseCase } from '../../application/use-cases/get-statement.use-case';
import { ProcessWagerCommand } from '../../application/dtos/process-wager.dto';
import { ProcessWinCommand } from '../../application/dtos/process-win.dto';
import { ProcessRollbackCommand } from '../../application/dtos/process-rollback.dto';
import { HmacSignatureGuard } from '../guards/hmac-signature.guard';

@Controller('v1')
export class WagerController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerUseCase,
    private readonly processWinUseCase: ProcessWinUseCase,
    private readonly processRollbackUseCase: ProcessRollbackUseCase,
    private readonly getBalanceUseCase: GetBalanceUseCase,
    private readonly getStatementUseCase: GetStatementUseCase,
  ) {}

  @Post('wagers')
  @UseGuards(HmacSignatureGuard)
  @HttpCode(HttpStatus.OK)
  async handleWager(@Body() body: ProcessWagerCommand) {
    const tx = await this.processWagerUseCase.execute(body);
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      status: tx.status,
      amount: tx.amount.toString(),
      currency: tx.amount.currency,
      processedAt: tx.processedAt,
    };
  }

  @Post('wins')
  @UseGuards(HmacSignatureGuard)
  @HttpCode(HttpStatus.OK)
  async handleWin(@Body() body: ProcessWinCommand) {
    const tx = await this.processWinUseCase.execute(body);
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      status: tx.status,
      amount: tx.amount.toString(),
      currency: tx.amount.currency,
      processedAt: tx.processedAt,
    };
  }

  @Post('rollbacks')
  @UseGuards(HmacSignatureGuard)
  @HttpCode(HttpStatus.OK)
  async handleRollback(@Body() body: ProcessRollbackCommand) {
    const tx = await this.processRollbackUseCase.execute(body);
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      status: tx.status,
      amount: tx.amount.toString(),
      currency: tx.amount.currency,
      processedAt: tx.processedAt,
    };
  }

  @Get('wallets/:playerId/balance')
  async getBalance(
    @Param('playerId') playerId: string,
    @Query('currency') currency = 'BRL',
  ) {
    return await this.getBalanceUseCase.execute(playerId, currency);
  }

  @Get('wallets/:playerId/statement')
  async getStatement(
    @Param('playerId') playerId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    return await this.getStatementUseCase.execute(playerId, parsedLimit);
  }
}