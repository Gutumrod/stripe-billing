// LR2FA-WU-D2 — raw HTTP evidence for the reworked C-11 unknown-product test (STAGE D2 repair).
//
// Independent reproduction of tests/control-read-projection.test.mjs test 12, printing the RAW
// status line and RAW response body for both halves of the proof:
//   1. control   — product still resolvable at request time -> served by the real route
//   2. withdrawn — product genuinely unresolvable at request time -> C-11 typed 404
// so the observed transition is visible rather than asserted in prose.
//
// This is an EVIDENCE runner, not a test: the filename matches no `node --test` collection pattern,
// so `node --test tests/*.test.mjs` is unaffected.
//
// Run: node tests/unknown-product-http-evidence.mjs   (after `npm run build`)
//
// Only the Postgres DRIVER is substituted (in-memory rows), exactly as the suites do; every
// authorization, profile-resolution and error-classification path executed here is production code.

import http from 'node:http';
import crypto from 'node:crypto';
import { BillingDb, CentralBillingRuntime, createBillingHttpHandler, signAccountAssertion } from '../dist/index.js';
import { ProductBillingProfileRegistry } from '../../profile-registry/dist/src/registry.js';
import { ps01TestProfile } from '../../profile-registry/dist/profiles/PS01.test.js';

const GHOST_PRODUCT_ID = 'prd_control_read_unregistered';
const GHOST_CONTROL_TOKEN = 'wstera-control-read-token-ghost-0005';
const GHOST_ASSERTION_KEY_ID = 'ghost-assertion-key';
const ASSERTION_SECRET = 'ps01-control-read-assertion-secret-local';
const ACCOUNT_PRIMARY = 'acc_cr_primary_01';
const ROUTE = '/v1/billing/control/snapshot';

class InMemoryBillingDb extends BillingDb {
  constructor() {
    super('postgres://mock:5432/mock', 'billing_core_staging');
    this.auditEvents = [];
  }
  async ping() {}
  async close() {}
  async ensureCredentialBinding() {}
  async getSubscriptionState() { return null; }
  async getEntitlementProjection() { return null; }
  async audit(input) { this.auditEvents.push({ ...input }); }
}

const registry = new ProductBillingProfileRegistry();
registry.register(ps01TestProfile);
registry.register({ ...ps01TestProfile, productId: GHOST_PRODUCT_ID, productCode: 'GHOST' });

const db = new InMemoryBillingDb();
const runtime = new CentralBillingRuntime({
  environment: 'test',
  schema: 'billing_core_staging',
  admissionTestMode: true,
  databaseUrl: 'postgres://mock:5432/mock',
  stripeSecretKey: ['sk', 'test', 'localSentinelNotACredential'].join('_'),
  stripeWebhookSecret: ['whsec', 'localSentinelNotACredential'].join('_'),
  webhookMaxBytes: 1024 * 1024,
  credentials: [{ keyId: 'ghost-control-key', token: GHOST_CONTROL_TOKEN, productId: GHOST_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['control_read'] }],
  assertionKeys: [{ keyId: GHOST_ASSERTION_KEY_ID, productId: GHOST_PRODUCT_ID, environment: 'test', secret: ASSERTION_SECRET }],
  returnUrls: {},
  entitlementSigningKeys: [],
  profileRegistry: registry,
  logger: { info() {}, warn() {}, error() {} },
  db,
});

await runtime.initialize();
const server = http.createServer(createBillingHttpHandler(runtime));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function hit(operationId) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signAccountAssertion({
    iss: GHOST_PRODUCT_ID, aud: 'wstera-billing-core', key_id: GHOST_ASSERTION_KEY_ID,
    product_id: GHOST_PRODUCT_ID, environment: 'test', account_id: ACCOUNT_PRIMARY,
    action: 'control_billing_snapshot_read', operation_id: operationId,
    nonce: crypto.randomUUID(), iat: now, exp: now + 120,
  }, ASSERTION_SECRET);
  const response = await fetch(
    `${baseUrl}${ROUTE}?account_id=${ACCOUNT_PRIMARY}&operation_id=${operationId}`,
    { headers: { authorization: `Bearer ${GHOST_CONTROL_TOKEN}`, 'x-wstera-account-assertion': assertion } },
  );
  return { status: response.status, text: await response.text() };
}

const before = await hit('op_cr_unknown_product_00');
console.log(`[control  ] product resolvable   -> HTTP ${before.status} ${before.text}`);

let withdrawn = 0;
for (const [key, registered] of registry.profiles) {
  if (registered.productId === GHOST_PRODUCT_ID) { registry.profiles.delete(key); withdrawn += 1; }
}
let registryNow = 'resolvable';
try { registry.getRegistered(GHOST_PRODUCT_ID, 'test', 1); } catch (error) { registryNow = `${error.name}: ${error.message}`; }
console.log(`[withdraw ] entries removed=${withdrawn} registry.getRegistered -> ${registryNow}`);

const after = await hit('op_cr_unknown_product_01');
console.log(`[withdrawn] product unresolvable -> HTTP ${after.status} ${after.text}`);
console.log(`[audit    ] audit rows written=${db.auditEvents.length}`);

await new Promise((resolve) => server.close(resolve));

const parsed = JSON.parse(after.text);
const passed = before.status === 404
  && JSON.parse(before.text).error === 'CONTROL_READ_RESOURCE_NOT_FOUND'
  && after.status === 404
  && parsed.error === 'CONTROL_READ_UNKNOWN_PRODUCT'
  && after.status !== 500
  && db.auditEvents.length === 0;
console.log(`RESULT: ${passed ? 'C-11 BRANCH REACHED AT REQUEST TIME' : 'MISMATCH'}`);
process.exitCode = passed ? 0 : 1;
