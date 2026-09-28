import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

test('Stripe catalog script refuses any non-TEST key before making provider calls', () => {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['scripts/create-stripe-test-catalog.mjs'], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: { ...process.env, STRIPE_SECRET_KEY: 'invalid-key-for-guard-test' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must use a TEST-mode prefix/);
  assert.doesNotMatch(result.stdout + result.stderr, /stripe_product_id/);
});
