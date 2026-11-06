import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/mikro-orm.config';

const enabled = process.env.RUN_INFRA_INTEGRATION === 'true';
const integrationDescribe = enabled ? describe : describe.skip;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const suffix = `${Date.now()}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
let integrationClient: SQSClient;
let integrationQueueUrls: { wagers: string; deadLetter: string; events: string };
let integrationWorkerEnv: NodeJS.ProcessEnv;
let integrationOrm: MikroORM;

if (enabled && (!process.env.SQS_ENABLED || !process.env.SQS_ENDPOINT)) {
  throw new Error('Set SQS_ENABLED=true and SQS_ENDPOINT before running the infrastructure integration suite.');
}

setDefaultTimeout(120_000);

interface Worker {
  port: number;
  process: ReturnType<typeof Bun.spawn>;
}

let workers: Worker[] = [];

integrationDescribe('Distributed PostgreSQL and SQS integration', () => {
  beforeAll(async () => {
    const queuePrefix = `integration-${suffix}`;
    integrationWorkerEnv = {
      ...process.env,
      DB_NAME: process.env.DB_NAME ?? 'jungle_wagering_integration',
      SQS_ENABLED: 'true',
      SQS_WAGER_QUEUE_NAME: `${queuePrefix}-wagers.fifo`,
      SQS_DLQ_QUEUE_NAME: `${queuePrefix}-dlq.fifo`,
      SQS_EVENT_QUEUE_NAME: `${queuePrefix}-events.fifo`,
      SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
      SQS_MAX_RECEIVE_COUNT: '5',
    };
    integrationClient = new SQSClient({
      region: integrationWorkerEnv.AWS_REGION ?? 'us-east-1',
      endpoint: integrationWorkerEnv.SQS_ENDPOINT,
      credentials: {
        accessKeyId: integrationWorkerEnv.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: integrationWorkerEnv.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });

    integrationOrm = await MikroORM.init({ ...ormConfig, dbName: integrationWorkerEnv.DB_NAME });
    workers = await startWorkers(3);

    integrationQueueUrls = {
      wagers: await queueUrl(integrationWorkerEnv.SQS_WAGER_QUEUE_NAME!),
      deadLetter: await queueUrl(integrationWorkerEnv.SQS_DLQ_QUEUE_NAME!),
      events: await queueUrl(integrationWorkerEnv.SQS_EVENT_QUEUE_NAME!),
    };
  });

  afterAll(async () => {
    await stopWorkers();
    if (integrationQueueUrls) {
      await Promise.all(Object.values(integrationQueueUrls).map((QueueUrl) =>
        integrationClient.send(new DeleteQueueCommand({ QueueUrl })),
      ));
    }
    integrationClient?.destroy();
    await integrationOrm?.close(true);
  });

  it('processes duplicate SQS deliveries once and publishes the committed outbox event', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const openingTransactions = await integrationOrm.em.getConnection().execute(
      "SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'",
      [wallet.id],
    );
    const openingEvents = await drainUntil(
      integrationQueueUrls.events,
      (event) => event.eventType === 'WagerTransactionProcessed' &&
        event.data?.transactionId === openingTransactions[0]?.id,
    );
    expect(openingEvents).toHaveLength(1);

    const externalTransactionId = `sqs-duplicate-${suffix}`;
    const envelope = wagerEnvelope(wallet, {
      messageId: `message-${suffix}`,
      externalTransactionId,
      idempotencyKey: `idempotency-${suffix}`,
      amount: '10.00',
    });

    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      integrationClient.send(new SendMessageCommand({
        QueueUrl: integrationQueueUrls.wagers,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: `delivery-${suffix}-${index}`,
      })),
    ));

    await waitForBalance(workers[0].port, wallet.id, '90.00');
    const ledger = await getLedger(workers[0].port, wallet.id);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    const queueAttributes = await integrationClient.send(new GetQueueAttributesCommand({
      QueueUrl: integrationQueueUrls.wagers,
      AttributeNames: ['RedrivePolicy'],
    }));
    expect(JSON.parse(queueAttributes.Attributes?.RedrivePolicy ?? '{}').maxReceiveCount).toBe('5');

    const matchingEvents = await drainUntil(
      integrationQueueUrls.events,
      (event) => event.eventType === 'WagerTransactionProcessed' && event.data?.externalTransactionId === externalTransactionId,
    );
    expect(matchingEvents).toHaveLength(1);

    await stopWorkers();
    workers = await startWorkers(1);
    await sendWager(envelope, wallet.id, 'after-restart');
    await waitForQueueEmpty(integrationQueueUrls.wagers);
    const replayedLedger = await getLedger(workers[0].port, wallet.id);
    expect(replayedLedger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    const inboxRows = await integrationOrm.em.getConnection().execute(
      'SELECT count(*)::int AS count FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      ['wager-transactions', envelope.messageId],
    );
    expect(inboxRows[0].count).toBe(1);
    await stopWorkers();
    workers = await startWorkers(3);

    await stopWorkers();
    workers = await startWorkers(1, { TEST_EXIT_BEFORE_ACK_ONCE: 'true' });
    const crashWallet = await createWallet(workers[0].port, '100.00');
    const crashEnvelope = wagerEnvelope(crashWallet, {
      messageId: `crash-after-commit-${suffix}`,
      externalTransactionId: `crash-tx-${suffix}`,
      idempotencyKey: `crash-key-${suffix}`,
      amount: '10.00',
    });
    await sendWager(crashEnvelope, crashWallet.id, 'crash-after-commit');
    const exitCode = await workers[0].process.exited;
    expect(exitCode).toBe(77);
    workers = await startWorkers(1);
    await waitForBalance(workers[0].port, crashWallet.id, '90.00');
    await waitForQueueEmpty(integrationQueueUrls.wagers);
    const crashLedger = await getLedger(workers[0].port, crashWallet.id);
    expect(crashLedger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    const crashInboxRows = await integrationOrm.em.getConnection().execute(
      'SELECT count(*)::int AS count FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      ['wager-transactions', crashEnvelope.messageId],
    );
    expect(crashInboxRows[0].count).toBe(1);
    await stopWorkers();
    workers = await startWorkers(3);

    await stopWorkers();
    workers = await startWorkers(1, { SQS_ENABLED: 'false' }, 'live');
    const unpublishedWallet = await createWallet(workers[0].port, '25.00');
    await stopWorkers();
    workers = await startWorkers(3);
    const recoveredEvents = await drainUntil(
      integrationQueueUrls.events,
      (event) => event.eventType === 'WalletBalanceChanged' && event.data?.walletId === unpublishedWallet.id,
    );
    expect(recoveredEvents).toHaveLength(1);
  });

  it('deduplicates 50 concurrent requests across three processes and protects hot and separate wallets', async () => {
    const duplicateWallet = await createWallet(workers[0].port, '100.00');
    const duplicateId = `http-duplicate-${suffix}`;
    const duplicateResponses = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      submitBet(workers[index % workers.length].port, duplicateWallet, duplicateId, '10.00'),
    ));
    const duplicateBodies = await Promise.all(duplicateResponses.map((response) => response.json()));
    expect(duplicateResponses.map((response) => response.status).every((status) => status === 200)).toBe(true);
    expect(new Set(duplicateBodies.map((body) => body.transactionId)).size).toBe(1);
    expect((await getWallet(workers[0].port, duplicateWallet.id)).balance.amount).toBe('90.00');
    expect((await getLedger(workers[0].port, duplicateWallet.id)).items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);

    const later = await submitBet(workers[2].port, duplicateWallet, `later-${suffix}`, '5.00');
    expect(later.status).toBe(200);
    const originalReplay = await submitBet(workers[1].port, duplicateWallet, duplicateId, '10.00');
    expect((await originalReplay.json()).balance.amount).toBe('90.00');
    const conflictingReplay = await submitBet(workers[2].port, duplicateWallet, duplicateId, '11.00');
    expect(conflictingReplay.status).toBe(409);
    expect((await getWallet(workers[0].port, duplicateWallet.id)).balance.amount).toBe('85.00');

    const hotWallet = await createWallet(workers[0].port, '100.00');
    const hotRequests = await Promise.all([
      submitBet(workers[0].port, hotWallet, `hot-a-${suffix}`, '80.00'),
      submitBet(workers[1].port, hotWallet, `hot-b-${suffix}`, '80.00'),
    ]);
    const hotResults = await Promise.all(hotRequests.map((response) => response.json()));
    expect(hotRequests.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 422]);
    expect(hotResults.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(hotResults.filter((result) => result.status === 'REJECTED')).toHaveLength(1);
    expect((await getWallet(workers[2].port, hotWallet.id)).balance.amount).toBe('20.00');
    expect((await getLedger(workers[2].port, hotWallet.id)).items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);

    const wallets = await Promise.all([0, 1, 2].map((index) => createWallet(workers[index].port, '100.00')));
    const responses = await Promise.all(wallets.map((wallet, index) =>
      submitBet(workers[index].port, wallet, `separate-${suffix}-${index}`, '15.00'),
    ));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    for (const wallet of wallets) {
      expect((await getWallet(workers[0].port, wallet.id)).balance.amount).toBe('85.00');
    }
  });

  it('keeps legacy provider endpoints inside the ledger, rejection, and outbox guarantees', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const win = legacyPayload(wallet, `legacy-win-${suffix}`, '5.00');
    const winResponse = await sendLegacy(workers[0].port, '/v1/wins', win);
    expect(winResponse.status).toBe(200);
    expect((await getWallet(workers[0].port, wallet.id)).balance.amount).toBe('105.00');

    const winEvents = await drainUntil(
      integrationQueueUrls.events,
      (event) => event.eventType === 'WagerTransactionProcessed' && event.data?.externalTransactionId === win.externalTransactionId,
    );
    expect(winEvents).toHaveLength(1);

    const rejectedWager = legacyPayload(wallet, `legacy-bet-${suffix}`, '9999.00');
    const rejectedResponse = await sendLegacy(workers[1].port, '/v1/wagers', rejectedWager);
    expect(rejectedResponse.status).toBe(422);
    const persistedRejection = await fetch(
      `http://127.0.0.1:${workers[2].port}/providers/integration-provider/wagering/transactions/${rejectedWager.externalTransactionId}`,
    ).then((response) => response.json());
    expect(persistedRejection.status).toBe('REJECTED');
    expect(persistedRejection.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await getWallet(workers[0].port, wallet.id)).balance.amount).toBe('105.00');

    const rejectionEvents = await drainUntil(
      integrationQueueUrls.events,
      (event) => event.eventType === 'WagerTransactionRejected' && event.data?.externalTransactionId === rejectedWager.externalTransactionId,
    );
    expect(rejectionEvents).toHaveLength(1);
  });

  it('applies all transaction kinds with reference, currency, and ledger rules', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const betId = `rules-bet-${suffix}`;
    const bet = await submitTransaction(workers[0].port, wallet, {
      id: betId,
      kind: 'BET',
      amount: '10.00',
    });
    expect((await bet.json()).status).toBe('PROCESSED');

    const win = await submitTransaction(workers[1].port, wallet, {
      id: `rules-win-${suffix}`,
      kind: 'WIN',
      amount: '5.00',
    });
    expect((await win.json()).status).toBe('PROCESSED');

    const loss = await submitTransaction(workers[2].port, wallet, {
      id: `rules-loss-${suffix}`,
      kind: 'LOSS',
      amount: '5.00',
    });
    expect((await loss.json()).status).toBe('PROCESSED');
    expect((await getWallet(workers[0].port, wallet.id)).balance.amount).toBe('95.00');

    const refund = await submitTransaction(workers[0].port, wallet, {
      id: `rules-refund-${suffix}`,
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: betId,
    });
    expect((await refund.json()).status).toBe('PROCESSED');

    const rollback = await submitTransaction(workers[1].port, wallet, {
      id: `rules-rollback-${suffix}`,
      kind: 'ROLLBACK',
      amount: '5.00',
      referenceExternalTransactionId: `rules-win-${suffix}`,
    });
    expect((await rollback.json()).status).toBe('PROCESSED');
    expect((await getWallet(workers[2].port, wallet.id)).balance.amount).toBe('100.00');

    const rejected = await submitTransaction(workers[0].port, wallet, {
      id: `rules-rejected-${suffix}`,
      kind: 'BET',
      amount: '1000.00',
    });
    expect(rejected.status).toBe(422);
    expect((await rejected.json()).failureCode).toBe('INSUFFICIENT_FUNDS');

    const pending = await submitTransaction(workers[1].port, wallet, {
      id: `rules-pending-${suffix}`,
      kind: 'ROLLBACK',
      amount: '1.00',
      referenceExternalTransactionId: `missing-reference-${suffix}`,
    });
    expect(pending.status).toBe(202);
    expect((await pending.json()).status).toBe('PENDING_REFERENCE');

    const wrongCurrency = await submitTransaction(workers[2].port, wallet, {
      id: `rules-currency-${suffix}`,
      kind: 'WIN',
      amount: '5.00',
      currency: 'USD',
    });
    expect(wrongCurrency.status).toBe(400);
    const ledger = await getLedger(workers[0].port, wallet.id);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT' || entry.direction === 'CREDIT')).toHaveLength(5);
  });

  it('recovers a rollback delivered before its reference and sends invalid messages to the DLQ', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const referenceExternalTransactionId = `late-bet-${suffix}`;
    const rollback = wagerEnvelope(wallet, {
      messageId: `rollback-${suffix}`,
      externalTransactionId: `rollback-tx-${suffix}`,
      idempotencyKey: `rollback-key-${suffix}`,
      kind: 'ROLLBACK',
      amount: '10.00',
      referenceExternalTransactionId,
    });
    await sendWager(rollback, wallet.id, 'rollback-first');
    await waitForTransactionStatus(workers[0].port, 'integration-provider', rollback.data.externalTransactionId, 'PENDING_REFERENCE');

    const reference = wagerEnvelope(wallet, {
      messageId: `reference-${suffix}`,
      externalTransactionId: referenceExternalTransactionId,
      idempotencyKey: `reference-key-${suffix}`,
      kind: 'BET',
      amount: '10.00',
    });
    await sendWager(reference, wallet.id, 'reference-second');
    await waitForTransactionStatus(workers[0].port, 'integration-provider', reference.data.externalTransactionId, 'PROCESSED');
    await waitForTransactionStatus(workers[0].port, 'integration-provider', rollback.data.externalTransactionId, 'PROCESSED');
    await waitForBalance(workers[0].port, wallet.id, '100.00');

    await integrationClient.send(new SendMessageCommand({
      QueueUrl: integrationQueueUrls.wagers,
      MessageBody: JSON.stringify({ type: 'invalid-envelope' }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: `invalid-${suffix}`,
    }));
    const deadLetter = await receiveUntil(integrationQueueUrls.deadLetter, (message) => message.reason !== undefined);
    expect(deadLetter.reason).toContain('Expected a WagerTransactionRequested envelope');
  });

  it('retries a transient PostgreSQL failure and relies on SQS redrive for the DLQ', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const messageId = `transient-${suffix}`;
    const functionName = `fail_inbox_${suffix.replaceAll('-', '_')}`;
    const triggerName = `fail_inbox_insert_${suffix.replaceAll('-', '_')}`;
    await integrationOrm.em.getConnection().execute(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message_id = '${messageId}' THEN
          RAISE EXCEPTION 'integration transient failure' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON inbox_messages
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);

    try {
      const envelope = wagerEnvelope(wallet, {
        messageId,
        externalTransactionId: `transient-tx-${suffix}`,
        idempotencyKey: `transient-key-${suffix}`,
        amount: '10.00',
      });
      await sendWager(envelope, wallet.id, 'transient');
      const deadLetter = await receiveUntil(
        integrationQueueUrls.deadLetter,
        (message) => message.messageId === messageId,
      );
      expect(deadLetter.type).toBe('WagerTransactionRequested');
      expect((await getWallet(workers[0].port, wallet.id)).balance.amount).toBe('100.00');
    } finally {
      await integrationOrm.em.getConnection().execute(`DROP TRIGGER IF EXISTS ${triggerName} ON inbox_messages`);
      await integrationOrm.em.getConnection().execute(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('rolls back inbox, transaction, balance, ledger, and outbox together on a late SQL failure', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const messageId = `atomic-${suffix}`;
    const externalTransactionId = `atomic-tx-${suffix}`;
    const functionName = `fail_outbox_${suffix.replaceAll('-', '_')}`;
    const triggerName = `fail_outbox_insert_${suffix.replaceAll('-', '_')}`;
    await integrationOrm.em.getConnection().execute(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'WagerTransactionProcessed'
          AND NEW.payload->'data'->>'externalTransactionId' = '${externalTransactionId}' THEN
          RAISE EXCEPTION 'integration late transaction failure' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);

    try {
      const envelope = wagerEnvelope(wallet, {
        messageId,
        externalTransactionId,
        idempotencyKey: `atomic-key-${suffix}`,
        amount: '10.00',
      });
      await sendWager(envelope, wallet.id, 'atomic');
      const deadLetter = await receiveUntil(
        integrationQueueUrls.deadLetter,
        (message) => message.messageId === messageId,
      );
      expect(deadLetter.type).toBe('WagerTransactionRequested');
      expect((await getWallet(workers[0].port, wallet.id)).balance.amount).toBe('100.00');
      expect((await getLedger(workers[0].port, wallet.id)).items).toHaveLength(1);

      const persistedInbox = await integrationOrm.em.getConnection().execute(
        'SELECT 1 FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
        ['wager-transactions', messageId],
      );
      expect(persistedInbox).toHaveLength(0);
      const persistedTransaction = await integrationOrm.em.getConnection().execute(
        'SELECT 1 FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
        ['integration-provider', externalTransactionId],
      );
      expect(persistedTransaction).toHaveLength(0);
      const persistedEvent = await integrationOrm.em.getConnection().execute(
        `SELECT 1 FROM outbox_messages WHERE payload->'data'->>'externalTransactionId' = ?`,
        [externalTransactionId],
      );
      expect(persistedEvent).toHaveLength(0);
    } finally {
      await integrationOrm.em.getConnection().execute(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_messages`);
      await integrationOrm.em.getConnection().execute(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('keeps persisted financial records append-only and enforces schema arithmetic', async () => {
    const wallet = await createWallet(workers[0].port, '100.00');
    const ledger = await getLedger(workers[0].port, wallet.id);
    const ledgerId = ledger.items[0].id;

    let ledgerWasProtected = false;
    try {
      await integrationOrm.em.getConnection().execute(
        'UPDATE wallet_ledger_entries SET amount = amount WHERE id = ?',
        [ledgerId],
      );
    } catch (error) {
      ledgerWasProtected = error instanceof Error && error.message.includes('append-only');
    }
    expect(ledgerWasProtected).toBe(true);

    let ledgerDeleteWasProtected = false;
    try {
      await integrationOrm.em.getConnection().execute(
        'DELETE FROM wallet_ledger_entries WHERE id = ?',
        [ledgerId],
      );
    } catch (error) {
      ledgerDeleteWasProtected = error instanceof Error && error.message.includes('append-only');
    }
    expect(ledgerDeleteWasProtected).toBe(true);

    let negativeBalanceWasRejected = false;
    try {
      await integrationOrm.em.getConnection().execute(
        'UPDATE wallets SET balance_amount = -1 WHERE id = ?',
        [wallet.id],
      );
    } catch {
      negativeBalanceWasRejected = true;
    }
    expect(negativeBalanceWasRejected).toBe(true);

    const transactionId = crypto.randomUUID();
    await integrationOrm.em.getConnection().execute(
      `INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
      [transactionId, 'schema-check', transactionId, transactionId, 'hash', wallet.id,
        wallet.playerId, 'schema-check', 'schema-check', 'BET', '10.00', 'BRL', 'PENDING'],
    );

    let invalidLedgerMathWasRejected = false;
    try {
      await integrationOrm.em.getConnection().execute(
        `INSERT INTO wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency,
           balance_before_amount, balance_before_currency, balance_after_amount,
           balance_after_currency, created_at)
         VALUES (?, ?, ?, 'CREDIT', 10, 'BRL', 0, 'BRL', 9, 'BRL', now())`,
        [crypto.randomUUID(), wallet.id, transactionId],
      );
    } catch (error) {
      invalidLedgerMathWasRejected = (error as { code?: string }).code === '23514';
    }
    expect(invalidLedgerMathWasRejected).toBe(true);
  });
});

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a worker port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startWorkers(
  count: number,
  overrides: NodeJS.ProcessEnv = {},
  readinessPath = 'ready',
): Promise<Worker[]> {
  return Promise.all(Array.from({ length: count }, async () => {
    const port = await allocatePort();
    const child = Bun.spawn([process.execPath, 'run', 'test/support/integration-worker.ts'], {
      cwd: process.cwd(),
      env: { ...integrationWorkerEnv, ...overrides, PORT: String(port) },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const worker = { port, process: child };
    await waitForReady(worker, readinessPath);
    return worker;
  }));
}

async function stopWorkers(): Promise<void> {
  for (const worker of workers) worker.process.kill('SIGTERM');
  await Promise.all(workers.map((worker) => worker.process.exited));
  workers = [];
}

async function waitForReady(worker: Worker, readinessPath = 'ready'): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && worker.process.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}/health/${readinessPath}`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await wait(250);
  }
  const error = await new Response(worker.process.stderr).text();
  throw new Error(`Integration worker failed to become ready: ${error}`);
}

async function queueUrl(name: string): Promise<string> {
  const response = await integrationClient.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!response.QueueUrl) throw new Error(`Queue ${name} has no URL`);
  return response.QueueUrl;
}

async function createWallet(port: number, amount: string) {
  const response = await fetch(`http://127.0.0.1:${port}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: `integration-${crypto.randomUUID()}`,
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  const body = await response.json();
  if (response.status !== 201) throw new Error(`Wallet creation failed: ${JSON.stringify(body)}`);
  return body as { id: string; playerId: string; balance: { amount: string; currency: string } };
}

function wagerEnvelope(
  wallet: { id: string; playerId: string },
  overrides: {
    messageId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    amount: string;
    kind?: string;
    referenceExternalTransactionId?: string;
  },
) {
  return {
    messageId: overrides.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'integration-provider',
      externalTransactionId: overrides.externalTransactionId,
      idempotencyKey: overrides.idempotencyKey,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind: overrides.kind ?? 'BET',
      money: { amount: overrides.amount, currency: 'BRL' },
      referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    },
  };
}

function legacyPayload(wallet: { id: string; playerId: string }, externalTransactionId: string, amount: string) {
  return {
    transactionId: crypto.randomUUID(),
    providerId: 'integration-provider',
    externalTransactionId,
    idempotencyKey: externalTransactionId,
    payloadHash: `hash-${externalTransactionId}`,
    playerId: wallet.playerId,
    roundId: 'integration-round',
    gameId: 'integration-game',
    amount,
    currency: 'BRL',
  };
}

async function sendLegacy(port: number, route: string, payload: Record<string, string>) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', integrationWorkerEnv.HMAC_SECRET ?? 'super-secret-provider-key')
    .update(body)
    .digest('hex');
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    body,
  });
}

async function sendWager(envelope: ReturnType<typeof wagerEnvelope>, walletId: string, dedup: string) {
  await integrationClient.send(new SendMessageCommand({
    QueueUrl: integrationQueueUrls.wagers,
    MessageBody: JSON.stringify(envelope),
    MessageGroupId: walletId,
    MessageDeduplicationId: `${dedup}-${suffix}`,
  }));
}

async function submitBet(port: number, wallet: { id: string; playerId: string }, id: string, amount: string) {
  return submitTransaction(port, wallet, { id, kind: 'BET', amount });
}

async function submitTransaction(
  port: number,
  wallet: { id: string; playerId: string },
  transaction: {
    id: string;
    kind: string;
    amount: string;
    currency?: string;
    referenceExternalTransactionId?: string;
  },
) {
  return fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': transaction.id },
    body: JSON.stringify({
      providerId: 'integration-provider',
      externalTransactionId: transaction.id,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind: transaction.kind,
      money: { amount: transaction.amount, currency: transaction.currency ?? 'BRL' },
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    }),
  });
}

async function getWallet(port: number, id: string) {
  const response = await fetch(`http://127.0.0.1:${port}/wallets/${id}`);
  if (!response.ok) throw new Error(`Wallet lookup failed with ${response.status}`);
  return response.json();
}

async function getLedger(port: number, id: string) {
  const response = await fetch(`http://127.0.0.1:${port}/wallets/${id}/ledger?limit=100`);
  if (!response.ok) throw new Error(`Ledger lookup failed with ${response.status}`);
  return response.json() as Promise<{ items: Array<{ id: string; direction: string }> }>;
}

async function waitForBalance(port: number, walletId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const wallet = await getWallet(port, walletId);
      if (wallet.balance.amount === expected) return;
    } catch {}
    await wait(200);
  }
  throw new Error(`Wallet ${walletId} did not reach expected balance ${expected}`);
}

async function waitForTransactionStatus(port: number, providerId: string, externalId: string, status: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/providers/${providerId}/wagering/transactions/${externalId}`);
    if (response.ok && (await response.json()).status === status) return;
    await wait(200);
  }
  throw new Error(`Transaction ${externalId} did not reach status ${status}`);
}

async function waitForQueueEmpty(queueUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await integrationClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    if (
      result.Attributes?.ApproximateNumberOfMessages === '0' &&
      result.Attributes.ApproximateNumberOfMessagesNotVisible === '0'
    ) return;
    await wait(200);
  }
  throw new Error('SQS queue did not drain after redelivery');
}

async function drainUntil(queue: string, predicate: (event: any) => boolean): Promise<any[]> {
  const matches: any[] = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && matches.length === 0) {
    const result = await integrationClient.send(new ReceiveMessageCommand({
      QueueUrl: queue,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    for (const message of result.Messages ?? []) {
      const event = JSON.parse(message.Body ?? '{}');
      if (predicate(event)) matches.push(event);
      if (message.ReceiptHandle) {
        await integrationClient.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }));
      }
    }
  }
  return matches;
}

async function receiveUntil(queue: string, predicate: (message: any) => boolean): Promise<any> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await integrationClient.send(new ReceiveMessageCommand({
      QueueUrl: queue,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    for (const message of result.Messages ?? []) {
      const body = JSON.parse(message.Body ?? '{}');
      if (predicate(body)) {
        if (message.ReceiptHandle) {
          await integrationClient.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }));
        }
        return body;
      }
    }
  }
  throw new Error('Expected SQS message was not received before timeout');
}
