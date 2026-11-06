import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as crypto from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { INestApplication } from '@nestjs/common';

describe('Wallet Domain & Edge Cases E2E Test', () => {
  const BASE_URL = 'http://localhost:3000/v1';
  const playerId = 'player-test-1';
  const HMAC_SECRET = process.env.HMAC_SECRET || 'super-secret-provider-key';
  let app: INestApplication | null = null;

  beforeAll(async () => {
    process.env.SQS_ENABLED = 'false';
    try {
      const res = await fetch('http://localhost:3000/health/live');
      if (res.ok) return;
    } catch {
      // Server not running, launch it
    }

    try {
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(3000);
    } catch {
      // Port already in use
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  function sign(payload: object): string {
    return crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  it('deve recusar aposta quando o saldo for insuficiente', async () => {
    const payload = {
      transactionId: crypto.randomUUID(),
      providerId: 'jungle',
      externalTransactionId: `ext-insufficient-${Date.now()}`,
      idempotencyKey: `idemp-insufficient-${Date.now()}`,
      payloadHash: 'hash-test',
      playerId,
      roundId: 'round-fail',
      gameId: 'sweet-bonanza',
      amount: '99999.00',
      currency: 'BRL',
    };

    const response = await fetch(`${BASE_URL}/wagers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': sign(payload),
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('deve garantir idempotência em chamadas duplicadas de rollback', async () => {
    const rollbackPayload = {
      transactionId: crypto.randomUUID(),
      providerId: 'jungle',
      externalTransactionId: `ext-rb-dup-${Date.now()}`,
      originalExternalTransactionId: 'ext-tx-1001',
      idempotencyKey: `idemp-rb-dup-${Date.now()}`,
      payloadHash: 'hash-rb-dup',
      playerId,
      roundId: 'round-88',
      gameId: 'sweet-bonanza',
      amount: '20.00',
      currency: 'BRL',
    };

    const signature = sign(rollbackPayload);

    const firstCall = await fetch(`${BASE_URL}/rollbacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: JSON.stringify(rollbackPayload),
    });

    const secondCall = await fetch(`${BASE_URL}/rollbacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: JSON.stringify(rollbackPayload),
    });

    const firstBody = await firstCall.json();
    const secondBody = await secondCall.json();

    expect(firstCall.status).toBe(200);
    expect(secondCall.status).toBe(200);
    expect(firstBody.transactionId).toBe(secondBody.transactionId);
  });
});
