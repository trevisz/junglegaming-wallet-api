import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';

@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

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
      return {
        status: 'ok',
        postgres: 'connected',
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        status: 'error',
        postgres: 'disconnected',
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
