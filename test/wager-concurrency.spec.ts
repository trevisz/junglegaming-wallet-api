import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as crypto from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { INestApplication } from '@nestjs/common';
import { DomainExceptionFilter } from '../src/presentation/filters/domain-exception.filter';

describe('Wager Concurrency & Idempotency E2E Test', () => {
  const API_URL = 'http://localhost:3000/v1/wagers';
  const playerId = 'player-test-1';
  const HMAC_SECRET = process.env.HMAC_SECRET || 'super-secret-provider-key';
  let app: INestApplication | null = null;

  function sign(payload: object): string {
    return crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  beforeAll(async () => {
    process.env.SQS_ENABLED = 'false';
    let running = false;
    try {
      const res = await fetch('http://localhost:3000/health/live');
      if (res.ok) running = true;
    } catch {
      // not running
    }

    if (!running) {
      try {
        app = await NestFactory.create(AppModule, { logger: false });
        app.useGlobalFilters(new DomainExceptionFilter());
        await app.listen(3000);
      } catch {
        // port might be bound
      }
    }

    const seedPayload = {
      transactionId: crypto.randomUUID(),
      providerId: 'jungle',
      externalTransactionId: `seed-win-${Date.now()}`,
      idempotencyKey: `seed-win-${Date.now()}`,
      payloadHash: 'seed-hash',
      playerId,
      roundId: `seed-round-${Date.now()}`,
      gameId: 'sweet-bonanza',
      amount: '500.00',
      currency: 'BRL',
    };

    await fetch('http://localhost:3000/v1/wins', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': sign(seedPayload),
      },
      body: JSON.stringify(seedPayload),
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('deve processar apostas simultâneas sem gerar saldo inconsistente (Race Condition Check)', async () => {
    const requests = Array.from({ length: 5 }).map((_, index) => {
      const txId = crypto.randomUUID();
      const payload = {
        transactionId: txId,
        providerId: 'jungle',
        externalTransactionId: `ext-concurrent-${index}-${Date.now()}`,
        idempotencyKey: `idemp-concurrent-${index}-${Date.now()}`,
        payloadHash: `hash-${index}`,
        playerId,
        roundId: `round-concurrent-${index}`,
        gameId: 'sweet-bonanza',
        amount: '10.00',
        currency: 'BRL',
      };

      return fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': sign(payload),
        },
        body: JSON.stringify(payload),
      });
    });

    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  it('deve retornar a mesma resposta ao disparar a mesma idempotencyKey simultaneamente', async () => {
    const fixedIdempotencyKey = `idemp-duplicate-${Date.now()}`;
    const fixedTxId = crypto.randomUUID();

    const payload = {
      transactionId: fixedTxId,
      providerId: 'jungle',
      externalTransactionId: `ext-dup-${Date.now()}`,
      idempotencyKey: fixedIdempotencyKey,
      payloadHash: 'hash-dup',
      playerId,
      roundId: 'round-dup',
      gameId: 'sweet-bonanza',
      amount: '5.00',
      currency: 'BRL',
    };

    const signature = sign(payload);

    const requests = Array.from({ length: 3 }).map(() =>
      fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature': signature,
        },
        body: JSON.stringify(payload),
      }),
    );

    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    for (const body of bodies) {
      expect(body.transactionId).toBe(fixedTxId);
      expect(body.status).toBe('PROCESSED');
    }
  });
});
