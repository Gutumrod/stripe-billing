import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerApp, createWorkerRuntime, runScheduled } from '../dist/worker.js';

test('Hono Worker forwards HTTP to billing runtime and closes it', async () => {
  const calls = [];
  const app = createWorkerApp(async () => ({
    async initialize() { calls.push('initialize'); },
    async handle(request) { calls.push(new URL(request.url).pathname); return Response.json({ ok: true }); },
    async close() { calls.push('close'); },
  }));
  const response = await app.request('/healthz', {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['initialize', '/healthz', 'close']);
});

test('scheduled drains due jobs with a bounded batch and closes runtime', async () => {
  const calls = [];
  let jobs = 0;
  const processed = await runScheduled({
    async initialize() { calls.push('initialize'); },
    async processOneJob(workerId) { calls.push(workerId); return jobs++ < 2 ? 'completed' : 'idle'; },
    async close() { calls.push('close'); },
  }, 'test-cron-worker');
  assert.equal(processed, 2);
  assert.deepEqual(calls, ['initialize', 'test-cron-worker', 'test-cron-worker', 'test-cron-worker', 'close']);
});

test('scheduled closes runtime when initialization fails', async () => {
  let closed = false;
  await assert.rejects(runScheduled({
    async initialize() { throw new Error('db unavailable'); },
    async processOneJob() { return 'idle'; },
    async close() { closed = true; },
  }));
  assert.equal(closed, true);
});

test('production Worker rejects direct database URLs and requires Hyperdrive', async () => {
  await assert.rejects(createWorkerRuntime({
    BILLING_ENVIRONMENT: 'production', BILLING_DATABASE_URL: 'postgres://localhost/forbidden',
    STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  }), /must use the HYPERDRIVE binding/);
});
