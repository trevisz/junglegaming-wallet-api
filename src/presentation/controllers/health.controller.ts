import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { SqsMessagingService } from '../../infrastructure/messaging/sqs-messaging.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsMessagingService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready() {
    try {
      await this.em.getConnection().execute('SELECT 1');
      await this.sqs.checkReady();
      return {
        status: 'ok',
        postgres: 'connected',
        sqs: 'connected',
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      throw new ServiceUnavailableException({
        status: 'error',
        dependency: this.sqs.isEnabled() ? 'postgres_or_sqs' : 'sqs_disabled',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }
}
