import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { ps01TestProfile } = require('../dist/profiles/PS01.test');
const { lk01TestProfile } = require('../dist/profiles/LK01.test');

const secret = process.env.WSTERA_STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
if (!secret) throw new Error('Set WSTERA_STRIPE_TEST_SECRET_KEY for this process only.');
if (!secret.startsWith('sk_test_')) throw new Error('Refusing to run: Stripe Test secret required; live keys are prohibited.');

const base = 'https://api.stripe.com/v1';
const runId = process.env.WSTERA_BILLING_TEST_RUN_ID || `wstera-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;

async function stripe(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${secret}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${base}${path}`, { method, headers, body: body ? new URLSearchParams(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Stripe ${method} ${path} failed: ${payload?.error?.type || response.status} ${payload?.error?.code || ''} ${payload?.error?.message || ''}`.trim());
  if (payload.livemode === true) throw new Error('Safety violation: provider returned livemode=true');
  return payload;
}
function price(profile, planId) {
  const value = profile.providerMappings.stripe.test.stripePriceIds[planId];
  if (!value) throw new Error(`Missing Test Price mapping for ${profile.productCode}/${planId}`);
  return value;
}

const customers = [
  { label: 'C1', accountId: `${runId}-c1`, profile: ps01TestProfile, planId: 'founding-c2' },
  { label: 'C2', accountId: `${runId}-c2`, profile: lk01TestProfile, planId: 'pro' },
  { label: 'C3', accountId: `${runId}-c3`, profile: lk01TestProfile, planId: 'business' },
];

async function createCustomer(spec) {
  return stripe('/customers', {
    method: 'POST',
    idempotencyKey: `${runId}-${spec.label}-customer`,
    body: {
      name: `WSTERA Billing ${runId} ${spec.label}`,
      payment_method: 'pm_card_visa',
      'invoice_settings[default_payment_method]': 'pm_card_visa',
      'metadata[test_run_id]': runId,
      'metadata[account_id]': spec.accountId,
      'metadata[wstera_product_code]': spec.profile.productCode,
    },
  });
}
async function subscribe(spec, customer, scenario) {
  const sub = await stripe('/subscriptions', {
    method: 'POST',
    idempotencyKey: `${runId}-${scenario}-${spec.label}-subscribe`,
    body: {
      customer: customer.id,
      'items[0][price]': price(spec.profile, spec.planId),
      'metadata[test_run_id]': runId,
      'metadata[scenario]': scenario,
      'metadata[account_id]': spec.accountId,
      'metadata[wstera_product_id]': spec.profile.productId,
      'metadata[wstera_product_code]': spec.profile.productCode,
      'metadata[profile_version]': String(spec.profile.profileVersion),
      'metadata[plan_id]': spec.planId,
    },
  });
  const refetched = await stripe(`/subscriptions/${sub.id}`);
  if (!['active', 'trialing'].includes(refetched.status)) throw new Error(`${scenario}/${spec.label}: expected active/trialing, got ${refetched.status}`);
  if (refetched.metadata.wstera_product_code !== spec.profile.productCode) throw new Error(`${scenario}/${spec.label}: product metadata mismatch`);
  return refetched;
}

async function cancel(spec, subscription, scenario) {
  const cancelled = await stripe(`/subscriptions/${subscription.id}`, { method: 'DELETE' });
  const refetched = await stripe(`/subscriptions/${subscription.id}`);
  if (refetched.status !== 'canceled') throw new Error(`${scenario}/${spec.label}: cancel refetch=${refetched.status}`);
  return cancelled;
}
async function scenarioSequential(specs, customerMap) {
  const subs = [];
  for (const spec of specs) subs.push(await subscribe(spec, customerMap.get(spec.label), 'sequential'));
  for (let i = 0; i < specs.length; i += 1) await cancel(specs[i], subs[i], 'sequential');
  return 'PASS';
}

async function scenarioConcurrentAll(specs, customerMap) {
  const subs = await Promise.all(specs.map((spec) => subscribe(spec, customerMap.get(spec.label), 'concurrent-all')));
  await Promise.all(specs.map((spec, i) => cancel(spec, subs[i], 'concurrent-all')));
  return 'PASS';
}

async function scenarioCancelOnlyC2(specs, customerMap) {
  const subs = await Promise.all(specs.map((spec) => subscribe(spec, customerMap.get(spec.label), 'cancel-c2')));
  await cancel(specs[1], subs[1], 'cancel-c2');
  const c1 = await stripe(`/subscriptions/${subs[0].id}`);
  const c3 = await stripe(`/subscriptions/${subs[2].id}`);
  if (!['active', 'trialing'].includes(c1.status) || !['active', 'trialing'].includes(c3.status)) throw new Error('C1/C3 changed when only C2 cancelled');
  await Promise.all([cancel(specs[0], subs[0], 'cancel-c2-cleanup'), cancel(specs[2], subs[2], 'cancel-c2-cleanup')]);
  return 'PASS';
}
async function scenarioCancelC1C2(specs, customerMap) {
  const subs = await Promise.all(specs.map((spec) => subscribe(spec, customerMap.get(spec.label), 'cancel-c1-c2')));
  await Promise.all([
    cancel(specs[0], subs[0], 'cancel-c1-c2'),
    cancel(specs[1], subs[1], 'cancel-c1-c2'),
  ]);
  const c3 = await stripe(`/subscriptions/${subs[2].id}`);
  if (!['active', 'trialing'].includes(c3.status)) throw new Error(`C3 changed unexpectedly: ${c3.status}`);
  await cancel(specs[2], subs[2], 'cancel-c1-c2-cleanup');
  return 'PASS';
}

async function deleteCustomer(customer) {
  try { await stripe(`/customers/${customer.id}`, { method: 'DELETE' }); }
  catch (error) { console.error(`cleanup customer ${customer.id}: ${error.message}`); }
}

const account = await stripe('/account');
console.log(JSON.stringify({ event: 'preflight', runId, accountId: account.id, livemode: account.livemode, country: account.country }, null, 2));

const created = await Promise.all(customers.map(async (spec) => [spec.label, await createCustomer(spec)]));
const customerMap = new Map(created);
const results = {};
try {
  results.sequential = await scenarioSequential(customers, customerMap);
  results.concurrentAll = await scenarioConcurrentAll(customers, customerMap);
  results.cancelOnlyC2 = await scenarioCancelOnlyC2(customers, customerMap);
  results.cancelC1C2 = await scenarioCancelC1C2(customers, customerMap);
  console.log(JSON.stringify({ event: 'result', runId, results }, null, 2));
} finally {
  await Promise.all([...customerMap.values()].map(deleteCustomer));
}
