/**
 * webhook.test.ts — Comprehensive vitest suite for the webhook-receiver module.
 *
 * Tests exercise the REAL production code (no mocks of production modules):
 * - core: normalizeHeaders, timingSafeEqual, parseTimestamp, validateTimestampWindow,
 *   payload helpers, idempotency, verifier registry, full verify pipeline.
 * - providers/generic-hmac: GenericHmacVerifier (fully implemented).
 * - providers/stripe: StripeWebhookVerifier (fully implemented).
 * - providers/line, github: stub verifiers (return WEBHOOK_UNKNOWN_PROVIDER).
 *
 * HMAC signatures are computed with the Web Crypto API to match production exactly.
 * An in-memory IdempotencyStore (real Map-based implementation, not a vi.fn mock)
 * exercises replay detection genuinely.
 *
 * Rules: no vi.mock, no .skip, no .todo, no empty test bodies. Every test invokes
 * the module under test. Tests for LINE/Github stubs assert their ACTUAL
 * behavior (returning WEBHOOK_UNKNOWN_PROVIDER), not fabricated success.
 */

import { describe, it, expect } from 'vitest';
import {
  createWebhookReceiver,
  type IdempotencyStore,
  type WebhookReceiverConfig,
  type WebhookRequest,
  type WebhookResult,
  type WebhookVerifier,
} from '../core';
import { createError, failureResult, timingSafeEqual } from '../core/errors';
import {
  parseTimestamp,
  validateTimestampWindow,
  DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
} from '../core/timestamp';
import {
  rawBodyToString,
  getRawBodyByteLength,
  guardPayloadSize,
  parseJsonPayload,
  DEFAULT_PAYLOAD_MAX_BYTES,
} from '../core/payload';
import { extractIdempotency, runIdempotencyStore } from '../core/idempotency';
import { buildVerifierRegistry, resolveVerifier } from '../core/verifier';
import { normalizeHeaders, createVerifyContext, verifyWebhookRequest } from '../core/verify';
import { GenericHmacVerifier } from '../providers/generic-hmac';
import { LineWebhookVerifier } from '../providers/line';
import { StripeWebhookVerifier } from '../providers/stripe';
import { GithubWebhookVerifier } from '../providers/github';
import type { WebhookErrorCode, WebhookError } from '../core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Computes HMAC over body using Web Crypto API — mirrors GenericHmacVerifier. */
async function computeHmacBytes(
  secret: string,
  body: string,
  algorithm: 'SHA-256' | 'SHA-512' = 'SHA-256'
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return new Uint8Array(mac);
}

/** Computes Stripe signature header for given timestamp, secret, and body. */
async function computeStripeSignatureHeader(
  secret: string,
  timestamp: number | string,
  rawBody: string
): Promise<string> {
  const payload = `${timestamp}.${rawBody}`;
  const sig = toHex(await computeHmacBytes(secret, payload));
  return `t=${timestamp},v1=${sig}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Real Map-based idempotency store with TTL expiry — not a mock. */
class InMemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, number>();

  async has(key: string): Promise<boolean> {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
    this.entries.set(key, Date.now() + ttl * 1000);
  }

  /** Test helper: directly inject a key to simulate prior processing. */
  inject(key: string): void {
    this.entries.set(key, Date.now() + 600_000);
  }
}

// ---------------------------------------------------------------------------
// errors.ts
// ---------------------------------------------------------------------------

describe('createError', () => {
  it('returns error object with code and message', () => {
    const err = createError('WEBHOOK_MISSING_SIGNATURE', 'no sig');
    expect(err.code).toBe('WEBHOOK_MISSING_SIGNATURE');
    expect(err.message).toBe('no sig');
    expect(err).not.toHaveProperty('provider');
  });

  it('includes provider when provided', () => {
    const err = createError('WEBHOOK_INVALID_SIGNATURE', 'bad sig', 'generic-hmac');
    expect(err.provider).toBe('generic-hmac');
  });
});

describe('failureResult', () => {
  it('returns valid:false with a structured error', () => {
    const result = failureResult('WEBHOOK_MISSING_TIMESTAMP', 'missing ts');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_TIMESTAMP');
    expect(result.error?.message).toBe('missing ts');
  });

  it('propagates provider into the nested error', () => {
    const result = failureResult('WEBHOOK_EXPIRED_TIMESTAMP', 'expired', 'stripe');
    expect(result.error?.provider).toBe('stripe');
  });
});

describe('timingSafeEqual', () => {
  it('returns true for identical byte arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('returns false for different content of same length', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('returns false for different lengths', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('returns true for two empty arrays', () => {
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify.ts — normalizeHeaders
// ---------------------------------------------------------------------------

describe('normalizeHeaders', () => {
  it('lowercases string header keys', () => {
    const result = normalizeHeaders({ 'X-Signature': 'abc' });
    expect(result['x-signature']).toBe('abc');
  });

  it('joins array values with ", "', () => {
    const result = normalizeHeaders({ 'X-Custom': ['a', 'b', 'c'] });
    expect(result['x-custom']).toBe('a, b, c');
  });

  it('skips undefined values', () => {
    const result = normalizeHeaders({ 'X-Present': 'yes', 'X-Absent': undefined });
    expect(result['x-present']).toBe('yes');
    expect(result).not.toHaveProperty('x-absent');
  });

  it('handles mixed string, array, and undefined values', () => {
    const result = normalizeHeaders({
      A: 'val',
      B: ['x', 'y'],
      C: undefined,
    });
    expect(result['a']).toBe('val');
    expect(result['b']).toBe('x, y');
    expect(result).not.toHaveProperty('c');
  });

  it('normalizes a real Web Headers instance', () => {
    const headers = new Headers();
    headers.set('X-Signature', 'sig');
    headers.set('Content-Type', 'application/json');
    const result = normalizeHeaders(headers);
    expect(result['x-signature']).toBe('sig');
    expect(result['content-type']).toBe('application/json');
  });

  it('returns an empty object for an empty input', () => {
    const result = normalizeHeaders({});
    expect(Object.keys(result).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// timestamp.ts
// ---------------------------------------------------------------------------

describe('parseTimestamp', () => {
  it('parses a numeric string', () => {
    const { timestamp, error } = parseTimestamp('1609459200');
    expect(timestamp).toBe(1609459200);
    expect(error).toBeUndefined();
  });

  it('passes through a number directly', () => {
    const { timestamp } = parseTimestamp(1609459200);
    expect(timestamp).toBe(1609459200);
  });

  it('returns WEBHOOK_MISSING_TIMESTAMP for undefined', () => {
    const { error } = parseTimestamp(undefined);
    expect(error?.error?.code).toBe('WEBHOOK_MISSING_TIMESTAMP');
  });

  it('returns WEBHOOK_INVALID_TIMESTAMP for a non-integer string', () => {
    const { error } = parseTimestamp('not-a-number');
    expect(error?.error?.code).toBe('WEBHOOK_INVALID_TIMESTAMP');
  });

  it('returns WEBHOOK_INVALID_TIMESTAMP for a float string', () => {
    const { error } = parseTimestamp('100.5');
    expect(error?.error?.code).toBe('WEBHOOK_INVALID_TIMESTAMP');
  });

  it('accepts zero as a valid integer timestamp', () => {
    const { timestamp } = parseTimestamp(0);
    expect(timestamp).toBe(0);
  });

  it('treats empty string as 0 (Number("") === 0 is an integer)', () => {
    const { timestamp } = parseTimestamp('');
    expect(timestamp).toBe(0);
  });
});

describe('validateTimestampWindow', () => {
  it('returns undefined when timestamp is undefined (no timestamp configured)', () => {
    expect(validateTimestampWindow(undefined, 300)).toBeUndefined();
  });

  it('returns undefined when timestamp is within tolerance', () => {
    const ts = nowSeconds();
    expect(validateTimestampWindow(ts, 300)).toBeUndefined();
  });

  it('returns undefined for a near-future timestamp within tolerance', () => {
    const ts = nowSeconds() + 60;
    expect(validateTimestampWindow(ts, 300)).toBeUndefined();
  });

  it('returns WEBHOOK_EXPIRED_TIMESTAMP for a past timestamp outside tolerance', () => {
    const ts = nowSeconds() - 600;
    const result = validateTimestampWindow(ts, 300);
    expect(result?.error?.code).toBe('WEBHOOK_EXPIRED_TIMESTAMP');
  });
});

// ---------------------------------------------------------------------------
// payload.ts
// ---------------------------------------------------------------------------

describe('rawBodyToString', () => {
  it('returns strings unchanged', () => {
    expect(rawBodyToString('hello')).toBe('hello');
  });

  it('decodes a Uint8Array to string', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(rawBodyToString(bytes)).toBe('hello world');
  });

  it('decodes an empty Uint8Array to empty string', () => {
    expect(rawBodyToString(new Uint8Array(0))).toBe('');
  });
});

describe('getRawBodyByteLength', () => {
  it('counts bytes of an ASCII string', () => {
    expect(getRawBodyByteLength('abc')).toBe(3);
  });

  it('counts bytes of a multibyte string correctly', () => {
    expect(getRawBodyByteLength('α')).toBe(2);
  });

  it('returns byteLength of a Uint8Array directly', () => {
    expect(getRawBodyByteLength(new Uint8Array([1, 2, 3, 4]))).toBe(4);
  });
});

describe('guardPayloadSize', () => {
  it('returns undefined when payload is under the limit', () => {
    expect(guardPayloadSize('small', 1024)).toBeUndefined();
  });

  it('returns undefined when payload equals the limit exactly', () => {
    const body = 'a'.repeat(100);
    expect(getRawBodyByteLength(body)).toBe(100);
    expect(guardPayloadSize(body, 100)).toBeUndefined();
  });

  it('returns WEBHOOK_OVERSIZED_PAYLOAD when payload exceeds the limit', () => {
    const body = 'a'.repeat(101);
    const result = guardPayloadSize(body, 100);
    expect(result?.error?.code).toBe('WEBHOOK_OVERSIZED_PAYLOAD');
    expect(result?.error?.message).toContain('100');
  });

  it('works with Uint8Array bodies', () => {
    const body = new Uint8Array(200);
    const result = guardPayloadSize(body, 100);
    expect(result?.error?.code).toBe('WEBHOOK_OVERSIZED_PAYLOAD');
  });
});

describe('parseJsonPayload', () => {
  it('parses valid JSON', () => {
    const { payload, error } = parseJsonPayload('{"key":"value"}');
    expect(error).toBeUndefined();
    expect(payload).toEqual({ key: 'value' });
  });

  it('parses an empty object', () => {
    const { payload } = parseJsonPayload('{}');
    expect(payload).toEqual({});
  });

  it('parses an array', () => {
    const { payload } = parseJsonPayload('[1, 2, 3]');
    expect(payload).toEqual([1, 2, 3]);
  });

  it('returns WEBHOOK_MALFORMED_JSON for invalid JSON', () => {
    const { error } = parseJsonPayload('{invalid}');
    expect(error?.error?.code).toBe('WEBHOOK_MALFORMED_JSON');
  });
});

// ---------------------------------------------------------------------------
// idempotency.ts
// ---------------------------------------------------------------------------

describe('extractIdempotency', () => {
  it('extracts eventId from idempotencyHeader', () => {
    const result = extractIdempotency(
      { 'x-event-id': 'evt_001' },
      {},
      { idempotencyHeader: 'x-event-id' }
    );
    expect(result.eventId).toBe('evt_001');
  });

  it('extracts eventId from eventIdPath when header is absent', () => {
    const result = extractIdempotency(
      {},
      { id: 'evt_002' },
      { eventIdPath: 'id' }
    );
    expect(result.eventId).toBe('evt_002');
  });

  it('header eventId takes precedence over path eventId', () => {
    const result = extractIdempotency(
      { 'x-event-id': 'from-header' },
      { id: 'from-path' },
      { idempotencyHeader: 'x-event-id', eventIdPath: 'id' }
    );
    expect(result.eventId).toBe('from-header');
  });

  it('extracts eventType from eventTypePath', () => {
    const result = extractIdempotency(
      {},
      { type: 'payment.succeeded' },
      { eventTypePath: 'type' }
    );
    expect(result.eventType).toBe('payment.succeeded');
  });

  it('extracts nested path values using dot notation', () => {
    const result = extractIdempotency(
      {},
      { event: { id: 'evt_003' }, data: { type: 'created' } },
      { eventIdPath: 'event.id', eventTypePath: 'data.type' }
    );
    expect(result.eventId).toBe('evt_003');
    expect(result.eventType).toBe('created');
  });

  it('returns undefined eventId when neither header nor path has a value', () => {
    const result = extractIdempotency({}, { foo: 'bar' }, {});
    expect(result.eventId).toBeUndefined();
  });

  it('coerces numeric eventId/eventType to string', () => {
    const result = extractIdempotency(
      {},
      { id: 42, type: 7 },
      { eventIdPath: 'id', eventTypePath: 'type' }
    );
    expect(result.eventId).toBe('42');
    expect(result.eventType).toBe('7');
  });
});

describe('runIdempotencyStore', () => {
  it('returns undefined when no store is provided', async () => {
    const result = await runIdempotencyStore(undefined, 'evt_001');
    expect(result).toBeUndefined();
  });

  it('returns undefined when eventId is undefined', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await runIdempotencyStore(store, undefined);
    expect(result).toBeUndefined();
  });

  it('returns undefined for a first-seen eventId and records it', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await runIdempotencyStore(store, 'evt_001');
    expect(result).toBeUndefined();
    expect(await store.has('evt_001')).toBe(true);
  });

  it('returns WEBHOOK_REPLAY_DETECTED for a duplicate eventId', async () => {
    const store = new InMemoryIdempotencyStore();
    store.inject('evt_dup');
    const result = await runIdempotencyStore(store, 'evt_dup');
    expect(result?.error?.code).toBe('WEBHOOK_REPLAY_DETECTED');
  });

  it('passes TTL seconds through to the store', async () => {
    const store = new InMemoryIdempotencyStore();
    await runIdempotencyStore(store, 'evt_ttl', 120);
    expect(await store.has('evt_ttl')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifier.ts — buildVerifierRegistry
// ---------------------------------------------------------------------------

describe('buildVerifierRegistry', () => {
  it('registers a single verifier keyed by providerName', () => {
    const v = new GenericHmacVerifier({
      secret: 's',
      signatureHeader: 'x-sig',
    });
    const registry = buildVerifierRegistry({ verifier: v });
    expect(registry.verifiers.get('generic-hmac')).toBe(v);
  });

  it('defaults defaultProvider to the single verifier providerName', () => {
    const v = new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' });
    const registry = buildVerifierRegistry({ verifier: v });
    expect(registry.defaultProvider).toBe('generic-hmac');
  });

  it('registers verifiers from a verifiers map by both map key and providerName', () => {
    const hmac = new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' });
    const line = new LineWebhookVerifier();
    const registry = buildVerifierRegistry({
      verifiers: { 'custom-name': hmac, line },
    });
    expect(registry.verifiers.get('custom-name')).toBe(hmac);
    expect(registry.verifiers.get('generic-hmac')).toBe(hmac);
    expect(registry.verifiers.get('line')).toBe(line);
  });

  it('has no defaultProvider when only a verifiers map is given without defaultProvider', () => {
    const registry = buildVerifierRegistry({
      verifiers: { 'generic-hmac': new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }) },
    });
    expect(registry.defaultProvider).toBeUndefined();
  });

  it('honors an explicit defaultProvider', () => {
    const hmac = new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' });
    const registry = buildVerifierRegistry({
      verifiers: { 'generic-hmac': hmac },
      defaultProvider: 'generic-hmac',
    });
    expect(registry.defaultProvider).toBe('generic-hmac');
  });

  it('throws WEBHOOK_CONFIG_INVALID when payloadMaxBytes is <= 0', () => {
    expect(() =>
      buildVerifierRegistry({
        verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
        payloadMaxBytes: 0,
      })
    ).toThrow(/payloadMaxBytes/);
  });

  it('throws WEBHOOK_CONFIG_INVALID when timestampToleranceSeconds is <= 0', () => {
    expect(() =>
      buildVerifierRegistry({
        verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
        timestampToleranceSeconds: 0,
      })
    ).toThrow(/timestampToleranceSeconds/);
  });

  it('throws WEBHOOK_CONFIG_INVALID when no verifiers are provided', () => {
    expect(() => buildVerifierRegistry({})).toThrow(/verifiers are required/);
  });

  it('throws WEBHOOK_CONFIG_INVALID when defaultProvider is not in verifiers', () => {
    expect(() =>
      buildVerifierRegistry({
        verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
        defaultProvider: 'nonexistent',
      })
    ).toThrow(/defaultProvider/);
  });

  it('returns a frozen registry object', () => {
    const registry = buildVerifierRegistry({
      verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
    });
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifier.ts — resolveVerifier
// ---------------------------------------------------------------------------

describe('resolveVerifier', () => {
  const hmac = new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' });
  const line = new LineWebhookVerifier();

  function makeRegistry() {
    return buildVerifierRegistry({
      verifiers: { 'generic-hmac': hmac, line },
      defaultProvider: 'generic-hmac',
    });
  }

  it('resolves by explicit providerName argument', () => {
    const { verifier, provider } = resolveVerifier(makeRegistry(), {}, 'line');
    expect(verifier).toBe(line);
    expect(provider).toBe('line');
  });

  it('resolves by request.provider when no providerName argument is given', () => {
    const { verifier, provider } = resolveVerifier(
      makeRegistry(),
      { rawBody: '', headers: {}, provider: 'line' },
      undefined
    );
    expect(verifier).toBe(line);
    expect(provider).toBe('line');
  });

  it('resolves by defaultProvider when neither argument nor request.provider is set', () => {
    const { verifier, provider } = resolveVerifier(makeRegistry(), { rawBody: '', headers: {} });
    expect(verifier).toBe(hmac);
    expect(provider).toBe('generic-hmac');
  });

  it('returns WEBHOOK_UNKNOWN_PROVIDER with provider set for an unregistered provider name', () => {
    const { error, provider } = resolveVerifier(makeRegistry(), {}, 'no-such-provider');
    expect(error?.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(error?.error?.provider).toBe('no-such-provider');
    expect(provider).toBe('no-such-provider');
  });

  it('returns WEBHOOK_UNKNOWN_PROVIDER without provider when no provider can be determined', () => {
    const registry = buildVerifierRegistry({
      verifiers: { 'generic-hmac': hmac },
    });
    const { error } = resolveVerifier(registry, { rawBody: '', headers: {} });
    expect(error?.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(error?.error?.provider).toBeUndefined();
  });

  it('providerName argument takes precedence over request.provider', () => {
    const { provider } = resolveVerifier(
      makeRegistry(),
      { rawBody: '', headers: {}, provider: 'line' },
      'generic-hmac'
    );
    expect(provider).toBe('generic-hmac');
  });

  it('request.provider takes precedence over defaultProvider', () => {
    const { provider } = resolveVerifier(
      makeRegistry(),
      { rawBody: '', headers: {}, provider: 'line' }
    );
    expect(provider).toBe('line');
  });
});

// ---------------------------------------------------------------------------
// GenericHmacVerifier
// ---------------------------------------------------------------------------

describe('GenericHmacVerifier', () => {
  const secret = 'my-secret';
  const body = '{"event":"test"}';

  it('has providerName "generic-hmac"', () => {
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    expect(v.providerName).toBe('generic-hmac');
  });

  it('freezes its config', () => {
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    expect(Object.isFrozen(v.config)).toBe(true);
  });

  it('verifies a valid HMAC-SHA256 hex signature', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(true);
  });

  it('verifies a valid HMAC-SHA256 hex signature with "sha256=" prefix stripped', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      prefix: 'sha256=',
    });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': `sha256=${sig}` } });
    expect(result.valid).toBe(true);
  });

  it('verifies a valid HMAC-SHA512 hex signature', async () => {
    const sig = toHex(await computeHmacBytes(secret, body, 'SHA-512'));
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      algorithm: 'SHA-512',
    });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(true);
  });

  it('verifies a valid HMAC-SHA256 base64 signature', async () => {
    const sig = toBase64(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      encoding: 'base64',
    });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(true);
  });

  it('returns WEBHOOK_MISSING_SIGNATURE when signature header is absent', async () => {
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const result = await v.verify({ rawBody: body, headers: {} });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_SIGNATURE');
    expect(result.error?.provider).toBe('generic-hmac');
  });

  it('returns WEBHOOK_MISSING_SIGNATURE when signature is an empty string', async () => {
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': '' } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_SIGNATURE');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a wrong secret', async () => {
    const sig = toHex(await computeHmacBytes('wrong-secret', body));
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.provider).toBe('generic-hmac');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a mismatched body', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const result = await v.verify({
      rawBody: '{"event":"different"}',
      headers: { 'x-signature': sig },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a malformed hex signature', async () => {
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': 'not-hex!' } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE when prefix is configured but not present', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      prefix: 'sha256=',
    });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
  });

  it('returns WEBHOOK_MISSING_TIMESTAMP when timestampHeader is configured but absent', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
    });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_TIMESTAMP');
    expect(result.error?.provider).toBe('generic-hmac');
  });

  it('returns WEBHOOK_INVALID_TIMESTAMP for a non-integer timestamp', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
    });
    const result = await v.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': 'abc' },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_TIMESTAMP');
    expect(result.error?.provider).toBe('generic-hmac');
  });

  it('returns valid with timestamp when timestamp is a valid integer string', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const ts = nowSeconds();
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
    });
    const result = await v.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(ts) },
    });
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(ts);
  });

  it('uses SHA-256 by default when algorithm is not specified', async () => {
    const sig256 = toHex(await computeHmacBytes(secret, body, 'SHA-256'));
    const sig512 = toHex(await computeHmacBytes(secret, body, 'SHA-512'));
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const r256 = await v.verify({ rawBody: body, headers: { 'x-signature': sig256 } });
    const r512 = await v.verify({ rawBody: body, headers: { 'x-signature': sig512 } });
    expect(r256.valid).toBe(true);
    expect(r512.valid).toBe(false);
  });

  it('uses hex encoding by default when encoding is not specified', async () => {
    const hexSig = toHex(await computeHmacBytes(secret, body));
    const b64Sig = toBase64(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' });
    const rHex = await v.verify({ rawBody: body, headers: { 'x-signature': hexSig } });
    const rB64 = await v.verify({ rawBody: body, headers: { 'x-signature': b64Sig } });
    expect(rHex.valid).toBe(true);
    expect(rB64.valid).toBe(false);
  });

  it('signature header lookup is case-insensitive (headers are pre-lowered)', async () => {
    const sig = toHex(await computeHmacBytes(secret, body));
    const v = new GenericHmacVerifier({ secret, signatureHeader: 'X-Signature' });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': sig } });
    expect(result.valid).toBe(true);
  });

  it('rejects a signature that is only the prefix with no hex body', async () => {
    const v = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      prefix: 'sha256=',
    });
    const result = await v.verify({ rawBody: body, headers: { 'x-signature': 'sha256=' } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
  });
});

// ---------------------------------------------------------------------------
// Stub providers: LINE, Stripe, GitHub
// ---------------------------------------------------------------------------

describe('LineWebhookVerifier (stub)', () => {
  it('has providerName "line"', () => {
    expect(new LineWebhookVerifier().providerName).toBe('line');
  });

  it('verify() returns WEBHOOK_UNKNOWN_PROVIDER with "not yet implemented" message', async () => {
    const v = new LineWebhookVerifier();
    const result = await v.verify({ rawBody: '', headers: {} });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(result.error?.message).toContain('not yet implemented');
    expect(result.error?.provider).toBe('line');
  });
});

describe('StripeWebhookVerifier', () => {
  const secret = 'whsec_test_secret_123';
  const sampleEvent = {
    id: 'evt_1Mv9qoLkdIwHu7ix0Example',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_123', amount: 2000 } },
  };
  const body = JSON.stringify(sampleEvent);

  it('has providerName "stripe"', () => {
    expect(new StripeWebhookVerifier().providerName).toBe('stripe');
  });

  it('freezes its config', () => {
    const v = new StripeWebhookVerifier({ secret });
    expect(Object.isFrozen(v.config)).toBe(true);
  });

  it('verifies a valid Stripe signature and extracts event details', async () => {
    const ts = nowSeconds();
    const sigHeader = await computeStripeSignatureHeader(secret, ts, body);
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': sigHeader },
    });

    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_1Mv9qoLkdIwHu7ix0Example');
    expect(result.eventType).toBe('payment_intent.succeeded');
    expect(result.payload).toEqual(sampleEvent);
    expect(result.timestamp).toBe(ts);
  });

  it('verifies when header contains legacy v0 alongside valid v1', async () => {
    const ts = nowSeconds();
    const payload = `${ts}.${body}`;
    const v1Sig = toHex(await computeHmacBytes(secret, payload));
    const header = `t=${ts},v0=legacy_sig,v1=${v1Sig}`;
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': header },
    });

    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_1Mv9qoLkdIwHu7ix0Example');
  });

  it('verifies when multiple v1 signatures exist (e.g. secret rollover)', async () => {
    const ts = nowSeconds();
    const payload = `${ts}.${body}`;
    const validV1 = toHex(await computeHmacBytes(secret, payload));
    const header = `t=${ts},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${validV1}`;
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': header },
    });

    expect(result.valid).toBe(true);
  });

  it('returns WEBHOOK_MISSING_SIGNATURE when stripe-signature header is absent', async () => {
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({ rawBody: body, headers: {} });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_SIGNATURE');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_MISSING_SIGNATURE when stripe-signature is empty string', async () => {
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({ rawBody: body, headers: { 'stripe-signature': '' } });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_SIGNATURE');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a malformed header missing t', async () => {
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': 'v1=5257a869e7ecebeda32a' },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.message).toContain('Malformed stripe-signature header');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a malformed header missing v1', async () => {
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': `t=${nowSeconds()}` },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.message).toContain('Malformed stripe-signature header');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a malformed header with non-integer t', async () => {
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': 't=invalid_timestamp,v1=abcd' },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.message).toContain('Malformed stripe-signature header');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a wrong secret', async () => {
    const ts = nowSeconds();
    const sigHeader = await computeStripeSignatureHeader('wrong_secret', ts, body);
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': sigHeader },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a tampered body', async () => {
    const ts = nowSeconds();
    const sigHeader = await computeStripeSignatureHeader(secret, ts, body);
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: '{"tampered":true}',
      headers: { 'stripe-signature': sigHeader },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a malformed hex v1 signature', async () => {
    const ts = nowSeconds();
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': `t=${ts},v1=not-valid-hex!` },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_EXPIRED_TIMESTAMP for a timestamp outside tolerance', async () => {
    const expiredTs = nowSeconds() - 600;
    const sigHeader = await computeStripeSignatureHeader(secret, expiredTs, body);
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': sigHeader },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_EXPIRED_TIMESTAMP');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_MALFORMED_JSON for malformed JSON body after valid signature', async () => {
    const invalidJson = '{ bad json';
    const ts = nowSeconds();
    const sigHeader = await computeStripeSignatureHeader(secret, ts, invalidJson);
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: invalidJson,
      headers: { 'stripe-signature': sigHeader },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MALFORMED_JSON');
    expect(result.error?.provider).toBe('stripe');
  });

  it('returns WEBHOOK_MALFORMED_JSON for non-object JSON payload after valid signature', async () => {
    const arrayJson = '[1, 2, 3]';
    const ts = nowSeconds();
    const sigHeader = await computeStripeSignatureHeader(secret, ts, arrayJson);
    const v = new StripeWebhookVerifier({ secret });
    const result = await v.verify({
      rawBody: arrayJson,
      headers: { 'stripe-signature': sigHeader },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MALFORMED_JSON');
    expect(result.error?.provider).toBe('stripe');
  });

  it('honors custom toleranceSeconds configured on verifier', async () => {
    const ts = nowSeconds() - 500;
    const sigHeader = await computeStripeSignatureHeader(secret, ts, body);
    const v = new StripeWebhookVerifier({ secret, toleranceSeconds: 1000 });
    const result = await v.verify({
      rawBody: body,
      headers: { 'stripe-signature': sigHeader },
    });
    expect(result.valid).toBe(true);
  });
});

describe('GithubWebhookVerifier (stub)', () => {
  it('has providerName "github"', () => {
    expect(new GithubWebhookVerifier().providerName).toBe('github');
  });

  it('verify() returns WEBHOOK_UNKNOWN_PROVIDER with "not yet implemented" message', async () => {
    const v = new GithubWebhookVerifier();
    const result = await v.verify({ rawBody: '', headers: {} });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(result.error?.message).toContain('not yet implemented');
    expect(result.error?.provider).toBe('github');
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: createWebhookReceiver / verifyWebhookRequest
// ---------------------------------------------------------------------------

describe('createWebhookReceiver', () => {
  it('returns a frozen receiver object', () => {
    const receiver = createWebhookReceiver({
      verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
    });
    expect(Object.isFrozen(receiver)).toBe(true);
    expect(typeof receiver.verify).toBe('function');
  });

  it('throws on invalid config (payloadMaxBytes <= 0)', () => {
    expect(() =>
      createWebhookReceiver({
        verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
        payloadMaxBytes: -1,
      })
    ).toThrow(/WEBHOOK_CONFIG_INVALID|payloadMaxBytes/);
  });
});

describe('verifyWebhookRequest — full pipeline (single GenericHmac provider)', () => {
  const secret = 'pipeline-secret';

  function makeReceiver(overrides?: Partial<WebhookReceiverConfig>) {
    const verifier = new GenericHmacVerifier({
      secret,
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
      eventIdPath: 'id',
      eventTypePath: 'type',
    });
    return createWebhookReceiver({ verifier, ...overrides });
  }

  async function makeSignedRequest(
    body: string,
    ts: number = nowSeconds()
  ): Promise<WebhookRequest> {
    const sig = toHex(await computeHmacBytes(secret, body));
    return {
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(ts) },
    };
  }

  it('returns valid:true with parsed payload, eventId, and eventType on a happy path', async () => {
    const body = JSON.stringify({ id: 'evt_001', type: 'payment.succeeded', amount: 100 });
    const receiver = makeReceiver();
    const result = await receiver.verify(await makeSignedRequest(body));
    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_001');
    expect(result.eventType).toBe('payment.succeeded');
    expect(result.payload).toEqual({ id: 'evt_001', type: 'payment.succeeded', amount: 100 });
  });

  it('returns valid:true for an empty object payload', async () => {
    const body = '{}';
    const receiver = makeReceiver();
    const result = await receiver.verify(await makeSignedRequest(body));
    expect(result.valid).toBe(true);
    expect(result.payload).toEqual({});
  });

  it('works with Uint8Array rawBody', async () => {
    const body = JSON.stringify({ id: 'evt_002', type: 'test' });
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver();
    const result = await receiver.verify({
      rawBody: new TextEncoder().encode(body),
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_002');
  });

  it('returns WEBHOOK_OVERSIZED_PAYLOAD for a body exceeding the default 1MB limit', async () => {
    const bigBody = 'a'.repeat(DEFAULT_PAYLOAD_MAX_BYTES + 1);
    const receiver = makeReceiver();
    const result = await receiver.verify({
      rawBody: bigBody,
      headers: {},
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_OVERSIZED_PAYLOAD');
  });

  it('returns WEBHOOK_OVERSIZED_PAYLOAD for a body exceeding a custom smaller limit', async () => {
    const body = 'a'.repeat(200);
    const receiver = makeReceiver({ payloadMaxBytes: 100 });
    const result = await receiver.verify({
      rawBody: body,
      headers: {},
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_OVERSIZED_PAYLOAD');
  });

  it('returns WEBHOOK_UNKNOWN_PROVIDER when no provider can be determined', () => {
    const receiver = createWebhookReceiver({
      verifiers: { 'generic-hmac': new GenericHmacVerifier({ secret, signatureHeader: 'x-signature' }) },
    });
    const result = receiver.verify({ rawBody: '{}', headers: {} });
    return expect(result).resolves.toMatchObject({
      valid: false,
      error: { code: 'WEBHOOK_UNKNOWN_PROVIDER' },
    });
  });

  it('returns WEBHOOK_UNKNOWN_PROVIDER for an unregistered provider name', async () => {
    const receiver = makeReceiver();
    const result = await receiver.verify(await makeSignedRequest('{}'), 'no-such-provider');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(result.error?.provider).toBe('no-such-provider');
  });

  it('returns WEBHOOK_MISSING_SIGNATURE when signature header is absent', async () => {
    const receiver = makeReceiver();
    const result = await receiver.verify({
      rawBody: '{}',
      headers: { 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_SIGNATURE');
    expect(result.error?.provider).toBe('generic-hmac');
  });

  it('returns WEBHOOK_INVALID_SIGNATURE for a wrong signature', async () => {
    const receiver = makeReceiver();
    const result = await receiver.verify({
      rawBody: '{}',
      headers: { 'x-signature': 'deadbeef', 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_INVALID_SIGNATURE');
  });

  it('returns WEBHOOK_MISSING_TIMESTAMP when timestamp header is absent', async () => {
    const body = '{}';
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver();
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_TIMESTAMP');
  });

  it('returns WEBHOOK_EXPIRED_TIMESTAMP for a timestamp older than tolerance', async () => {
    const body = '{}';
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver({ timestampToleranceSeconds: 60 });
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds() - 120) },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_EXPIRED_TIMESTAMP');
  });

  it('returns WEBHOOK_MALFORMED_JSON for invalid JSON body with valid signature', async () => {
    const body = 'not json';
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver();
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MALFORMED_JSON');
  });

  it('extracts eventId from idempotencyHeader when eventIdPath has no value', async () => {
    const body = JSON.stringify({ type: 'test' });
    const receiver = createWebhookReceiver({
      verifier: new GenericHmacVerifier({
        secret,
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        idempotencyHeader: 'x-event-id',
        eventTypePath: 'type',
      }),
    });
    const sig = toHex(await computeHmacBytes(secret, body));
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()), 'x-event-id': 'evt_from_header' },
    });
    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_from_header');
    expect(result.eventType).toBe('test');
  });

  it('returns WEBHOOK_REPLAY_DETECTED for a duplicate eventId', async () => {
    const store = new InMemoryIdempotencyStore();
    store.inject('evt_dup');
    const body = JSON.stringify({ id: 'evt_dup', type: 'test' });
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver({ idempotencyStore: store });
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_REPLAY_DETECTED');
  });

  it('accepts and records a first-seen eventId via the store', async () => {
    const store = new InMemoryIdempotencyStore();
    const body = JSON.stringify({ id: 'evt_new', type: 'test' });
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver({ idempotencyStore: store });
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_new');
    expect(await store.has('evt_new')).toBe(true);
  });

  it('skips replay check when no idempotencyStore is configured', async () => {
    const body = JSON.stringify({ id: 'evt_nostore', type: 'test' });
    const receiver = makeReceiver();
    const r1 = await receiver.verify(await makeSignedRequest(body));
    const r2 = await receiver.verify(await makeSignedRequest(body));
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
  });

  it('skips replay check when eventId is not present in payload or headers', async () => {
    const store = new InMemoryIdempotencyStore();
    const body = JSON.stringify({ data: 'no-id-here' });
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeReceiver({ idempotencyStore: store });
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(true);
    expect(result.eventId).toBeUndefined();
  });

  it('uses verifier toleranceSeconds as fallback when receiver config does not specify it', async () => {
    const body = '{}';
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = createWebhookReceiver({
      verifier: new GenericHmacVerifier({
        secret,
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        toleranceSeconds: 1000,
      }),
    });
    const ts = nowSeconds() - 500;
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(ts) },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an expired timestamp when verifier toleranceSeconds is 1000 but receiver overrides to 60', async () => {
    const body = '{}';
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = createWebhookReceiver({
      verifier: new GenericHmacVerifier({
        secret,
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        toleranceSeconds: 1000,
      }),
      timestampToleranceSeconds: 60,
    });
    const ts = nowSeconds() - 120;
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(ts) },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_EXPIRED_TIMESTAMP');
  });
});

describe('verifyWebhookRequest — multi-provider setup', () => {
  const secret = 'multi-secret';

  function makeMultiReceiver(overrides?: Partial<WebhookReceiverConfig>) {
    return createWebhookReceiver({
      verifiers: {
        'generic-hmac': new GenericHmacVerifier({
          secret,
          signatureHeader: 'x-signature',
          timestampHeader: 'x-timestamp',
          eventIdPath: 'id',
          eventTypePath: 'type',
        }),
        line: new LineWebhookVerifier(),
        stripe: new StripeWebhookVerifier(),
        github: new GithubWebhookVerifier(),
      },
      defaultProvider: 'generic-hmac',
      ...overrides,
    });
  }

  it('resolves the default provider when none is specified', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'test' });
    const sig = toHex(await computeHmacBytes(secret, body));
    const receiver = makeMultiReceiver();
    const result = await receiver.verify({
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_1');
  });

  it('resolves a specific provider via the providerName argument', async () => {
    const receiver = makeMultiReceiver();
    const result = await receiver.verify({ rawBody: '{}', headers: {} }, 'line');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(result.error?.provider).toBe('line');
  });

  it('resolves a specific provider via request.provider', async () => {
    const receiver = makeMultiReceiver();
    const result = await receiver.verify({
      rawBody: '{}',
      headers: {},
      provider: 'stripe',
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_MISSING_SIGNATURE');
    expect(result.error?.provider).toBe('stripe');
  });

  it('providerName argument overrides request.provider', async () => {
    const receiver = makeMultiReceiver();
    const result = await receiver.verify(
      { rawBody: '{}', headers: {}, provider: 'stripe' },
      'github'
    );
    expect(result.error?.provider).toBe('github');
  });

  it('returns WEBHOOK_UNKNOWN_PROVIDER for an unregistered provider in multi-provider mode', async () => {
    const receiver = makeMultiReceiver();
    const result = await receiver.verify({ rawBody: '{}', headers: {} }, 'nonexistent');
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('WEBHOOK_UNKNOWN_PROVIDER');
    expect(result.error?.provider).toBe('nonexistent');
  });
});

describe('verifyWebhookRequest — via createVerifyContext (lower-level)', () => {
  it('builds a context and verifies through verifyWebhookRequest directly', async () => {
    const secret = 'ctx-secret';
    const body = JSON.stringify({ id: 'evt_ctx', type: 'ctx-test' });
    const sig = toHex(await computeHmacBytes(secret, body));
    const context = createVerifyContext({
      verifier: new GenericHmacVerifier({
        secret,
        signatureHeader: 'x-signature',
        timestampHeader: 'x-timestamp',
        eventIdPath: 'id',
        eventTypePath: 'type',
      }),
    });
    const result = await verifyWebhookRequest(context, {
      rawBody: body,
      headers: { 'x-signature': sig, 'x-timestamp': String(nowSeconds()) },
    });
    expect(result.valid).toBe(true);
    expect(result.eventId).toBe('evt_ctx');
    expect(result.eventType).toBe('ctx-test');
  });

  it('context config is frozen', () => {
    const context = createVerifyContext({
      verifier: new GenericHmacVerifier({ secret: 's', signatureHeader: 'x-sig' }),
    });
    expect(Object.isFrozen(context.config)).toBe(true);
  });
});