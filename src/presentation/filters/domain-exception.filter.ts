import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const exceptionResponse = typeof exception.getResponse === 'function'
      ? exception.getResponse()
      : exception.response;

    if (
      exceptionResponse &&
      typeof exceptionResponse === 'object' &&
      ['REJECTED', 'PENDING_REFERENCE'].includes(exceptionResponse.status)
    ) {
      const status = typeof exception.getStatus === 'function'
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
      response.status(status).json({ ...exceptionResponse, statusCode: status });
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_ERROR';
    let message = exception.message || 'An unexpected error occurred';

    if (
      exception.name === 'InsufficientBalanceException' ||
      exception.name === 'InsufficientBalanceError' ||
      exception.status === 422
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      errorCode = 'INSUFFICIENT_FUNDS';
    } else if (
      exception.name === 'WalletNotFoundException' ||
      exception.name === 'WalletNotFoundError' ||
      exception.status === 404
    ) {
      status = HttpStatus.NOT_FOUND;
      errorCode = 'WALLET_NOT_FOUND';
    } else if (
      exception.name === 'DuplicateTransactionException' ||
      exception.status === 409
    ) {
      status = HttpStatus.CONFLICT;
      errorCode = 'DUPLICATE_TRANSACTION';
    } else if (exception.status && typeof exception.status === 'number') {
      status = exception.status;
      errorCode = exception.response?.error || 'BAD_REQUEST';
    }

    response.status(status).json({
      statusCode: status,
      code: errorCode,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
