import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const here = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = resolve(here, '..');
const repoRoot = resolve(runtimeRoot, '../..');
const migrations = [
  resolve(repoRoot, 'docs/platform/billing-core/migrations/0001_billing_core_schema.sql'),
  resolve(repoRoot, 'docs/platform/billing-core/migrations/0002_multi_product_billing_runtime.sql'),
  resolve(repoRoot, 'docs/platform/billing-core/migrations/0003_one_time_purchase_refunds.sql'),
];
const user = 'postgres';
const database = 'wstera_billing_test';

async function workerLocalSmoke(databaseUrl) {
  const cli = resolve(runtimeRoot, 'node_modules/wrangler/bin/wrangler.js');
  const args = [cli, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8788', '--var', 'BILLING_DATABASE_URL:' + databaseUrl,
    '--var', 'BILLING_ENVIRONMENT:test', '--var', 'BILLING_SCHEMA:billing_core_staging',
    '--var', 'BILLING_ADMISSION_TEST_MODE:true', '--var', 'STRIPE_SECRET_KEY:sk_test_local_only',
    '--var', 'STRIPE_WEBHOOK_SECRET:whsec_local_only'];
  const child = spawn(process.execPath, args, { cwd: runtimeRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    const deadline = Date.now() + 45_000;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('wrangler dev exited before health check');
      try { response = await fetch('http://127.0.0.1:8788/healthz'); if (response.ok) break; } catch { /* wait for local Worker */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    if (!response?.ok) throw new Error('wrangler dev local health check did not return 2xx');
    const body = await response.json();
    if (body.ok !== true) throw new Error('wrangler dev local health response did not confirm runtime readiness');
    process.stdout.write('wrangler dev --local: /healthz 200 against disposable localhost PostgreSQL\n');
  } catch (error) {
    process.stderr.write(`wrangler dev local smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(output.slice(-4000));
    throw error;
  } finally {
    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolvePromise) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('exit', resolvePromise);
        killer.once('error', resolvePromise);
      });
    } else child.kill();
    if (child.exitCode === null) await new Promise((resolvePromise) => child.once('exit', resolvePromise));
  }
}

function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function main() {
  const port = await findFreePort();
  const password = randomBytes(24).toString('base64url');
  const databaseDir = await mkdtemp(join(tmpdir(), 'wstera-sb01-postgres-'));
  const postgres = new EmbeddedPostgres({ databaseDir, user, password, port, persistent: false, authMethod: 'password' });
  let started = false;
  try {
    await postgres.initialise();
    await postgres.start();
    started = true;
    await postgres.createDatabase(database);
    const client = new pg.Client({ host: '127.0.0.1', port, user, password, database });
    await client.connect();
    try {
      await client.query('CREATE ROLE anon NOLOGIN');
      await client.query('CREATE ROLE authenticated NOLOGIN');
      for (const migration of migrations) {
        await client.query(await readFile(migration, 'utf8'));
      }
    } finally { await client.end(); }
    const databaseUrl = `${['postgres:', '', ''].join('/')}${user}:${password}@127.0.0.1:${port}/${database}`;
    if (process.argv.includes('--worker-smoke')) await workerLocalSmoke(databaseUrl);
    const integrationFiles = [
      'tests/outbox-lease-reconcile-crash-window-real-db.test.mjs',
      'tests/sb01-lr2e-isolation-real-db.test.mjs',
      'tests/webhook-durable-claim-jsonb-real-db.test.mjs',
    ];
    const files = process.argv.includes('--all')
      ? (await readdir(join(runtimeRoot, 'tests'))).filter((file) => file.endsWith('.test.mjs')).map((file) => `tests/${file}`)
      : integrationFiles;
    if (!process.argv.includes('--skip-tests')) {
      const result = await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
          cwd: runtimeRoot, stdio: 'inherit', env: { ...process.env, BILLING_DATABASE_URL: databaseUrl },
        });
        child.once('error', reject);
        child.once('exit', (code) => resolvePromise(code ?? 1));
      });
      if (result !== 0) process.exitCode = Number(result);
    }
  } finally {
    if (started) await postgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
