import http from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { CentralBillingRuntime } = require('./dist');
const { ProductBillingProfileRegistry } = require('../profile-registry/dist/src/registry');
const { ps01TestProfile } = require('../profile-registry/dist/profiles/PS01.test');
const { lk01TestProfile } = require('../profile-registry/dist/profiles/LK01.test');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseJson(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch { throw new Error(`Invalid JSON environment variable: ${name}`); }
}

const environment = process.env.BILLING_ENVIRONMENT ?? 'test';
const admissionTestMode = process.env.BILLING_ADMISSION_TEST_MODE === 'true';
const schema = process.env.BILLING_SCHEMA ?? 'billing_core_staging';
const registry = new ProductBillingProfileRegistry();
registry.register(ps01TestProfile);
registry.register(lk01TestProfile);

const logger = {
  info(event, fields) { console.log(JSON.stringify({ level: 'info', event, ...fields })); },
  warn(event, fields) { console.warn(JSON.stringify({ level: 'warn', event, ...fields })); },
  error(event, fields) { console.error(JSON.stringify({ level: 'error', event, ...fields })); },
};

const runtime = new CentralBillingRuntime({
  environment,
  schema,
  admissionTestMode,
  databaseUrl: required('BILLING_DATABASE_URL'),
  stripeSecretKey: required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  webhookMaxBytes: Number(process.env.BILLING_WEBHOOK_MAX_BYTES ?? '1048576'),
  credentials: parseJson('BILLING_PRODUCT_CREDENTIALS_JSON', []),
  assertionKeys: parseJson('BILLING_ACCOUNT_ASSERTION_KEYS_JSON', []),
  returnUrls: parseJson('BILLING_RETURN_URLS_JSON', {}),
  entitlementSigningKeys: parseJson('BILLING_ENTITLEMENT_SIGNING_KEYS_JSON', []),
  profileRegistry: registry,
  logger,
});

await runtime.initialize();
const port = Number(process.env.BILLING_HTTP_PORT ?? '8787');
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const url = `http://${host}${req.url ?? '/'}`;
    const method = req.method ?? 'GET';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const response = await runtime.handle(new Request(url, init));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const bytes = new Uint8Array(await response.arrayBuffer());
    res.end(Buffer.from(bytes));
  } catch (error) {
    logger.error('billing.http.adapter.failed', { code: 'HTTP_ADAPTER_FAILED' });
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'HTTP_ADAPTER_FAILED' }));
  }
});
const workerId = `billing-${crypto.randomUUID()}`;
let workerBusy = false;
const workerTimer = setInterval(async () => {
  if (workerBusy) return;
  workerBusy = true;
  try {
    for (let index = 0; index < 20; index += 1) {
      const result = await runtime.processOneJob(workerId);
      if (result === 'idle') break;
    }
  } catch {
    logger.error('billing.worker.loop.failed', { code: 'WORKER_LOOP_FAILED' });
  } finally {
    workerBusy = false;
  }
}, 500);
workerTimer.unref();

server.listen(port, '127.0.0.1', () => {
  logger.info('billing.http.listening', { host: '127.0.0.1', port, workerId });
});

async function shutdown(signal) {
  logger.info('billing.runtime.shutdown', { signal });
  clearInterval(workerTimer);
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
