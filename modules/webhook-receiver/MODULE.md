# Webhook Receiver Module

**Version:** 0.1.0 (P0, experimental)
**Status:** Reusable embedded module — core implemented, docs stage.

## Architecture

This module is a **reusable embedded module** — not a standalone service or framework.
A Host project that needs validated, provider-agnostic inbound webhook handling embeds
this module into its own codebase and calls the public API from its own code.

The module has one job: receive a raw HTTP request body + headers → parse → verify the
cryptographic signature → validate timestamp freshness → check idempotency → return a
typed `WebhookResult`. It never throws on verification failures; it returns
`{ valid: false, error }` instead.

The module **never** reads env (`process.env` / `env` / `globalThis`). The Host reads its
own env and injects secrets + config via `createWebhookReceiver(config)`.

### Host vs. module responsibilities

| Host must do | Module does |
|---|---|
| Receive the raw HTTP `Request` from the runtime | Parse raw headers into a normalized record |
| Read env / secrets (HMAC secret, tolerance, etc.) and inject `WebhookReceiverConfig` | Enforce payload size limit before any JSON parsing (DoS protection) |
| Own DB stores / pass optional `IdempotencyStore` | Verify the cryptographic signature using the injected verifier |
| Execute domain logic on verified events | Validate timestamp freshness against configured tolerance window |
| Map `WebhookResult` to HTTP responses | Execute idempotency / replay-protection checks |
| Never forward `error.message` internals to external callers | Normalize all failure modes into a structured `WebhookResult` |

## Public API

All exports come from `./core` (barrel). Do not import from sub-files directly.

```ts
import { createWebhookReceiver } from './core';
import { GenericHmacVerifier } from './providers/generic-hmac';
```

### `createWebhookReceiver(config: WebhookReceiverConfig): WebhookReceiver`

Validates the config at construction time. Returns a `WebhookReceiver` bound to the
given config. Throws `WebhookError` with code `WEBHOOK_CONFIG_INVALID` if required
fields are missing or conflicting (e.g. neither `verifier` nor `verifiers` is provided).

### `receiver.verify(request: WebhookRequest, providerName?: string): Promise<WebhookResult>`

The single entry point for processing an inbound webhook. Runs the full verification
pipeline in sequence:

1. **Payload size guard** — rejects oversized bodies before any parsing (`WEBHOOK_OVERSIZED_PAYLOAD`).
2. **Header normalization** — lowercases all header names for consistent lookup.
3. **Provider selection** — picks the verifier by `providerName` (if given), falls back to
   `config.defaultProvider`, then `config.verifier`. Returns `WEBHOOK_UNKNOWN_PROVIDER`
   if no matching verifier is found.
4. **Signature & timestamp verification** — delegates to the selected `WebhookVerifier`.
   Returns `WEBHOOK_MISSING_SIGNATURE`, `WEBHOOK_INVALID_SIGNATURE`,
   `WEBHOOK_MISSING_TIMESTAMP`, or `WEBHOOK_INVALID_TIMESTAMP` as appropriate.
5. **Timestamp window check** — compares the parsed timestamp against `now ± toleranceSeconds`.
   Returns `WEBHOOK_EXPIRED_TIMESTAMP` when outside the window.
6. **Idempotency & replay protection** — if `config.idempotencyStore` is present, checks
   whether this event ID has already been processed. Returns `WEBHOOK_REPLAY_DETECTED`
   on a duplicate.
7. **Store update & result framing** — marks the event ID as processed in the store and
   returns `{ valid: true, eventId, eventType, payload }`.

On any failure the pipeline short-circuits and returns `{ valid: false, error }`.

## Config contract

### `WebhookReceiverConfig`

```ts
interface WebhookReceiverConfig {
  verifier?: WebhookVerifier;                        // single-provider shorthand
  verifiers?: Record<string, WebhookVerifier>;       // multi-provider map (name → verifier)
  defaultProvider?: string;                          // key into verifiers used when providerName is omitted
  payloadMaxBytes?: number;                          // default: 1_048_576 (1 MiB)
  timestampToleranceSeconds?: number;                // default: 300 (5 minutes)
  idempotencyStore?: IdempotencyStore;               // optional replay-protection store
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `verifier` | one of `verifier` / `verifiers` required | — | Single-verifier shorthand; mutually exclusive with `verifiers` |
| `verifiers` | one of `verifier` / `verifiers` required | — | Named verifier map; use with `defaultProvider` |
| `defaultProvider` | no | — | Key into `verifiers` used when `verify()` is called without a `providerName` |
| `payloadMaxBytes` | no | `1_048_576` | Payload size limit in bytes; enforced before JSON parsing |
| `timestampToleranceSeconds` | no | `300` | Accepted clock-skew window in seconds |
| `idempotencyStore` | no | `undefined` | If absent, replay protection is skipped |

**Config injection rule:** the Host reads its own env and builds this config object. The
module core never accesses `process.env`, `env`, or `globalThis` at any point.

## Core types

```ts
interface WebhookRequest {
  rawBody: string | Uint8Array;              // raw, unparsed request body (mandatory)
  headers: Record<string, string | string[] | undefined> | Headers;
  url?: string;                              // optional path (for route-based providers)
  method?: string;                           // e.g. "POST"
  provider?: string;                         // optional explicit provider name
}

interface WebhookResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  payload?: unknown;
  error?: WebhookError;
}

interface WebhookError {
  code: WebhookErrorCode;
  message: string;   // human-readable; MUST NOT contain secrets or raw signature values
  provider?: string; // provider that produced the error, when applicable
}

interface WebhookVerifierInput {
  rawBody: string;
  headers: Record<string, string>;  // already lowercased by the pipeline
}

interface VerificationResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  payload?: unknown;
  timestamp?: number;   // Unix seconds, parsed by the verifier
  providerMetadata?: Record<string, unknown>;
  error?: WebhookError;
}

interface WebhookVerifier {
  readonly providerName: string;
  verify(input: WebhookVerifierInput): Promise<VerificationResult>;
}

interface IdempotencyStore {
  has(key: string): Promise<boolean>;
  set(key: string, ttlSeconds?: number): Promise<void>;
}
```

## Provider architecture

Providers live under `providers/<name>/` and each implement `WebhookVerifier`. Adding a
new provider never requires modifying `core/`.

### `GenericHmacVerifier` (shipped in v0.1)

Located at `providers/generic-hmac/`. Handles any HMAC-over-body scheme (GitHub-style
`sha256=...` signatures, raw hex/base64 HMAC, etc.).

```ts
import { GenericHmacVerifier } from './providers/generic-hmac';

const verifier = new GenericHmacVerifier({
  secret: env.WEBHOOK_SECRET,
  signatureHeader: 'x-hub-signature-256',
  algorithm: 'SHA-256',
  encoding: 'hex',
  prefix: 'sha256=',
  timestampHeader: 'x-webhook-timestamp',
  toleranceSeconds: 300,
  idempotencyHeader: 'x-delivery-id',
  eventIdPath: 'id',
  eventTypePath: 'type',
});
```

#### `GenericHmacConfig` fields

| Field | Required | Default | Description |
|---|---|---|---|
| `secret` | yes | — | HMAC secret key (string). Must never be logged |
| `signatureHeader` | yes | — | Header name containing the signature |
| `timestampHeader` | no | — | Header name containing the request timestamp as a Unix-seconds integer |
| `algorithm` | no | `'SHA-256'` | HMAC algorithm: `'SHA-256'` or `'SHA-512'` |
| `encoding` | no | `'hex'` | Signature encoding: `'hex'` or `'base64'` |
| `prefix` | no | — | Expected prefix to strip before decoding (e.g. `'sha256='`) |
| `toleranceSeconds` | no | `300` | Per-verifier timestamp tolerance; overrides the receiver-level setting for this provider |
| `idempotencyHeader` | no | — | Header whose value is used as the event ID for idempotency checks |
| `eventIdPath` | no | — | Dot-notation JSON path to extract the event ID from the parsed payload (e.g. `'id'`, `'event.id'`) |
| `eventTypePath` | no | — | Dot-notation JSON path to extract the event type from the parsed payload (e.g. `'type'`, `'event.name'`) |

### Contract placeholders (not yet implemented)

`providers/line/`, `providers/stripe/`, and `providers/github/` are included as contract
stubs. Calling `receiver.verify(request, 'line' | 'stripe' | 'github')` currently returns
`WEBHOOK_UNKNOWN_PROVIDER` with message "not yet implemented". Implement these by creating
a file in `providers/<name>/` that exports a class or factory implementing `WebhookVerifier`
— no changes to `core/` are required.

## Error codes

All errors surface as `WebhookError` with one of the following codes:

| Code | When it occurs |
|---|---|
| `WEBHOOK_MISSING_SIGNATURE` | The expected signature header is absent from the request |
| `WEBHOOK_INVALID_SIGNATURE` | Signature header is present but the HMAC comparison fails |
| `WEBHOOK_MISSING_TIMESTAMP` | `timestampHeader` is configured but the header is absent |
| `WEBHOOK_INVALID_TIMESTAMP` | Timestamp header is present but cannot be parsed as a valid time value |
| `WEBHOOK_EXPIRED_TIMESTAMP` | Parsed timestamp is outside the accepted `toleranceSeconds` window |
| `WEBHOOK_MALFORMED_JSON` | Raw body is not valid JSON (parsing fails after signature verification) |
| `WEBHOOK_OVERSIZED_PAYLOAD` | Raw body length exceeds `payloadMaxBytes` before any parsing |
| `WEBHOOK_REPLAY_DETECTED` | Event ID already exists in the `IdempotencyStore` (duplicate delivery) |
| `WEBHOOK_UNKNOWN_PROVIDER` | No verifier found for the requested provider name; or provider is a stub |
| `WEBHOOK_CONFIG_INVALID` | `createWebhookReceiver` called with a malformed or incomplete config |

## Security

1. **Constant-time comparison.** Signature verification uses `crypto.subtle` HMAC verify
   (or `timingSafeEqual` equivalent) to prevent timing-oracle attacks. The computed and
   received MACs are never compared with `===`.

2. **No secret leakage.** `WebhookError.message` must never contain the HMAC secret, raw
   signature header values, or any credential material. `cause` is internal only and must
   not be serialized or forwarded to the Host's response layer.

3. **Payload size guard before JSON.parse.** `payloadMaxBytes` is checked against the raw
   body string length before any parsing. This prevents DoS via large payloads that
   trigger expensive JSON parsing.

4. **Web Crypto only.** All cryptographic operations use `crypto.subtle` from the Web
   Crypto API. No `node:crypto`, `node:fs`, or other Node-specific imports. Runs on
   Cloudflare Workers, Deno, Bun, and any standards-compliant runtime.

5. **No env access.** The module never references `process.env`, `env`, or `globalThis`.
   All config enters through `createWebhookReceiver(config)`. Safe to embed in any runtime
   without side-effect risks.

6. **No mutation of Host input.** The `WebhookRequest` object passed to `verify()` is not
   mutated. Header normalization operates on an internal copy.

## How to integrate

### Steps

1. Copy the module folder into your repo.
2. Import `GenericHmacVerifier` and `createWebhookReceiver` from the module.
3. In your Worker `fetch` handler, read your **own** env and construct the verifier:
   ```ts
   const hmacVerifier = new GenericHmacVerifier({
     secret: env.WEBHOOK_SECRET,
     signatureHeader: 'x-hub-signature-256',
     prefix: 'sha256=',
     eventIdPath: 'id',
     eventTypePath: 'type',
   });
   ```
4. Build a `WebhookReceiverConfig` and call `createWebhookReceiver`:
   ```ts
   const receiver = createWebhookReceiver({
     verifier: hmacVerifier,
     payloadMaxBytes: 1_048_576,
     timestampToleranceSeconds: 300,
   });
   ```
5. In the request handler, read the raw body and pass it to `receiver.verify`:
   ```ts
   const rawBody = await request.text();
   const headers = Object.fromEntries(request.headers);
   const result = await receiver.verify({ rawBody, headers });
   ```
6. Branch on `result.valid` before any business logic:
   ```ts
   if (!result.valid) {
     return Response.json({ error: result.error?.code }, { status: 400 });
   }
   // safe to use result.eventId, result.eventType, result.payload
   ```

See `integration.example.ts` for the full Cloudflare Worker example.

### Integration checklist

- [ ] Copy the module folder into the target repo
- [ ] Read your own env — never pass `env` itself into the module
- [ ] Construct `GenericHmacVerifier` (or custom verifier) from your own env values
- [ ] Build `WebhookReceiverConfig` and call `createWebhookReceiver`
- [ ] Check `result.valid` before executing any business logic
- [ ] Never forward `result.error?.message` or `result.error?.cause` verbatim to external callers — expose only `result.error?.code`
- [ ] Run `npm run typecheck` before deploy

## Versioning

Standard semver — bump the version in `VERSION` on every change. No CHANGELOG or migration
guide until the module has been embedded in ≥ 2 real projects and the contract has stabilized.

## Promote to shared package when

The module has been embedded in ≥ 2–3 projects without changes to `core/` contract
(only config/verifier changes on the Host side) — then extract to an npm package.
