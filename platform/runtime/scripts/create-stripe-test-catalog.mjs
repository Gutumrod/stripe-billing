import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ps01RealMoneyTestProfile } = require('../../profile-registry/dist/profiles/PS01.real-money.test.js');
const { moduleHubProductProfiles } = require('../../profile-registry/dist/profiles/MODULE-HUB.test.js');

function safeKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (typeof key !== 'string' || !(key.startsWith('sk_test_') || key.startsWith('rk_test_'))) {
    throw new Error('Refusing Stripe catalog creation: STRIPE_SECRET_KEY must use a TEST-mode prefix');
  }
  return key;
}

async function stripePost(key, path, params, idempotencyKey) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': idempotencyKey,
    },
    body: new URLSearchParams(params),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Stripe TEST API ${path} failed with HTTP ${response.status}`);
  return result;
}

function amountEntries(profile, plan, recurringInterval) {
  return Object.entries(plan.pricesByCurrency ?? {}).map(([currency, unitAmount]) => ({
    currency: currency.toLowerCase(), unit_amount: unitAmount,
    ...(recurringInterval ? { 'recurring[interval]': recurringInterval } : {}),
    'metadata[product_id]': profile.productId,
    'metadata[plan_id]': plan.planId,
    'metadata[profile_version]': String(profile.profileVersion),
    'metadata[launch_starts_at]': plan.salesStartsAt ?? '',
    'metadata[launch_ends_at]': plan.salesEndsAt ?? '',
  }));
}

async function createCatalogProduct(key, profile, name, plans) {
  const productId = profile.productId;
  const version = profile.profileVersion;
  const product = await stripePost(key, 'products', {
    name,
    'metadata[wstera_product_id]': productId,
    'metadata[profile_version]': String(version),
  }, `wstera-product-${productId}-v${version}`);
  const prices = [];
  for (const plan of plans) {
    for (const currencyPrice of amountEntries(plan.profile, plan, plan.interval === 'month' ? 'month' : plan.interval === 'year' ? 'year' : null)) {
      const params = { product: product.id, ...currencyPrice };
      const created = await stripePost(key, 'prices', params,
        `wstera-price-${productId}-${plan.planId}-${currencyPrice.currency}-v${version}`);
      prices.push({ plan_id: plan.planId, currency: currencyPrice.currency.toUpperCase(), price_id: created.id });
    }
  }
  return { product_id: productId, stripe_product_id: product.id, prices };
}

async function main() {
  const key = safeKey();
  const startsAt = process.env.PS01_ANNUAL_LAUNCH_STARTS_AT || null;
  const endsAt = process.env.PS01_ANNUAL_LAUNCH_ENDS_AT || null;
  if ((startsAt === null) !== (endsAt === null)
    || (startsAt !== null && (!Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt)) || Date.parse(startsAt) >= Date.parse(endsAt)))) {
    throw new Error('PS01 annual launch window must have valid ordered start and end timestamps');
  }
  const ps01Plans = ps01RealMoneyTestProfile.plans.map((plan) => ({
    ...plan,
    ...(plan.interval === 'year' ? { salesStartsAt: startsAt, salesEndsAt: endsAt } : {}),
    profile: ps01RealMoneyTestProfile,
  }));
  const ps01 = await createCatalogProduct(key, ps01RealMoneyTestProfile, 'PS01', ps01Plans);
  const moduleResults = [];
  for (const profile of moduleHubProductProfiles) {
    const plan = profile.plans[0];
    moduleResults.push(await createCatalogProduct(key, profile, profile.displayName, [{ ...plan, profile }]));
  }
  process.stdout.write(`${JSON.stringify({ mode: 'test', ps01, module_hub: moduleResults }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Stripe TEST catalog creation failed'}\n`);
  process.exitCode = 1;
});
