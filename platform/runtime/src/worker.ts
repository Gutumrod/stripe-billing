import { Hono } from 'hono';
import { CentralBillingRuntime } from './runtime';
import { ProductBillingProfileRegistry } from '../../profile-registry/dist/src/registry.js';
import { ps01TestProfile } from '../../profile-registry/dist/profiles/PS01.test.js';
import { ps01RealMoneyTestProfile } from '../../profile-registry/dist/profiles/PS01.real-money.test.js';
import { moduleHubProductProfiles } from '../../profile-registry/dist/profiles/MODULE-HUB.test.js';
import { lk01TestProfile } from '../../profile-registry/dist/profiles/LK01.test.js';
import type { RuntimeLogger } from './types';

export interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
  BILLING_DATABASE_URL?: string;
  BILLING_ENVIRONMENT?: string;
  BILLING_SCHEMA?: string;
  BILLING_ADMISSION_TEST_MODE?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  BILLING_WEBHOOK_MAX_BYTES?: string;
  BILLING_PRODUCT_CREDENTIALS_JSON?: string;
  BILLING_ACCOUNT_ASSERTION_KEYS_JSON?: string;
  BILLING_RETURN_URLS_JSON?: string;
  BILLING_ENTITLEMENT_SIGNING_KEYS_JSON?: string;
  PS01_ANNUAL_LAUNCH_STARTS_AT?: string;
  PS01_ANNUAL_LAUNCH_ENDS_AT?: string;
}

type RuntimeFactory = (env: WorkerEnv) => Promise<CentralBillingRuntime>;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required binding: ${name}`);
  return value;
}

function parseJson<T>(raw: string | undefined, name: string, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`Invalid JSON binding: ${name}`); }
}

function registryFor(env: WorkerEnv, environment: 'test' | 'live'): ProductBillingProfileRegistry {
  const registry = new ProductBillingProfileRegistry();
  if (environment !== 'test') return registry;
  const start = env.PS01_ANNUAL_LAUNCH_STARTS_AT || null;
  const end = env.PS01_ANNUAL_LAUNCH_ENDS_AT || null;
  if ((start === null) !== (end === null)
    || (start !== null && (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end!))))
    || (start !== null && Date.parse(start) >= Date.parse(end!))) {
    throw new Error('PS01 annual launch window must have valid ordered start and end timestamps');
  }
  const ps01 = structuredClone(ps01RealMoneyTestProfile);
  for (const plan of ps01.plans) {
    if (plan.interval === 'year') {
      plan.salesStartsAt = start;
      plan.salesEndsAt = end;
    }
  }
  [ps01TestProfile, ps01, ...moduleHubProductProfiles, lk01TestProfile].forEach((profile) => registry.register(profile));
  return registry;
}

export async function createWorkerRuntime(env: WorkerEnv): Promise<CentralBillingRuntime> {
  const rawEnvironment = env.BILLING_ENVIRONMENT ?? 'test';
  if (rawEnvironment !== 'test' && rawEnvironment !== 'production') throw new Error('BILLING_ENVIRONMENT must be test or production');
  const environment = rawEnvironment === 'production' ? 'live' : 'test';
  const schema = env.BILLING_SCHEMA ?? (environment === 'live' ? 'billing_core' : 'billing_core_staging');
  if (schema !== (environment === 'live' ? 'billing_core' : 'billing_core_staging')) throw new Error('BILLING_SCHEMA does not match runtime environment');
  if (environment === 'live' && env.BILLING_DATABASE_URL) throw new Error('Production runtime must use the HYPERDRIVE binding');
  const logger: RuntimeLogger = {
    info(event, fields) { console.log(JSON.stringify({ level: 'info', event, ...fields })); },
    warn(event, fields) { console.warn(JSON.stringify({ level: 'warn', event, ...fields })); },
    error(event, fields) { console.error(JSON.stringify({ level: 'error', event, ...fields })); },
  };
  return new CentralBillingRuntime({
    environment, schema, admissionTestMode: env.BILLING_ADMISSION_TEST_MODE === 'true',
    databaseUrl: required(environment === 'live' ? env.HYPERDRIVE?.connectionString : env.BILLING_DATABASE_URL ?? env.HYPERDRIVE?.connectionString, 'HYPERDRIVE'),
    stripeSecretKey: required(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'),
    stripeWebhookSecret: required(env.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET'),
    webhookMaxBytes: Number(env.BILLING_WEBHOOK_MAX_BYTES ?? '1048576'),
    credentials: parseJson(env.BILLING_PRODUCT_CREDENTIALS_JSON, 'BILLING_PRODUCT_CREDENTIALS_JSON', []),
    assertionKeys: parseJson(env.BILLING_ACCOUNT_ASSERTION_KEYS_JSON, 'BILLING_ACCOUNT_ASSERTION_KEYS_JSON', []),
    returnUrls: parseJson(env.BILLING_RETURN_URLS_JSON, 'BILLING_RETURN_URLS_JSON', {}),
    entitlementSigningKeys: parseJson(env.BILLING_ENTITLEMENT_SIGNING_KEYS_JSON, 'BILLING_ENTITLEMENT_SIGNING_KEYS_JSON', []),
    profileRegistry: registryFor(env, environment), logger,
  });
}

const defaultRuntimeFactory: RuntimeFactory = createWorkerRuntime;

export function createWorkerApp(factory: RuntimeFactory = defaultRuntimeFactory) {
  const app = new Hono<{ Bindings: WorkerEnv }>();
  app.all('*', async (context) => {
    let runtime: CentralBillingRuntime | undefined;
    try {
      runtime = await factory(context.env);
      await runtime.initialize();
      return await runtime.handle(context.req.raw);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'billing.worker.request.failed', code: 'WORKER_REQUEST_FAILED' }));
      return context.json({ error: 'WORKER_REQUEST_FAILED' }, 500);
    } finally {
      if (runtime) await runtime.close().catch(() => console.error(JSON.stringify({ level: 'error', event: 'billing.worker.close.failed' })));
    }
  });
  return app;
}

export async function runScheduled(runtime: Pick<CentralBillingRuntime, 'initialize' | 'processOneJob' | 'close'>, workerId = `billing-cron-${crypto.randomUUID()}`): Promise<number> {
  let processed = 0;
  try {
    await runtime.initialize();
    for (; processed < 20; processed += 1) {
      const result = await runtime.processOneJob(workerId);
      if (result === 'idle') break;
    }
    return processed;
  } finally {
    await runtime.close();
  }
}

export async function scheduled(controller: { cron: string }, env: WorkerEnv): Promise<void> {
  const runtime = await createWorkerRuntime(env);
  try {
    const count = await runScheduled(runtime);
    console.log(JSON.stringify({ level: 'info', event: 'billing.worker.scheduled.completed', cron: controller.cron, processed: count }));
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'billing.worker.scheduled.failed', cron: controller.cron, code: 'SCHEDULED_RUN_FAILED' }));
    throw new Error('Scheduled billing job failed');
  }
}

const app = createWorkerApp();
export default { fetch: app.fetch, scheduled };
