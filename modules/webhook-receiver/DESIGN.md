# Webhook Receiver Module — DESIGN.md

**Version:** 0.1.0 (P0, experimental)  
**Status:** Design (Stage 1 — Architect). This file is the single source of truth for downstream agents (Stage 2 implementer, Stage 3 tester, Stage 4 reviewer).  
**Language / runtime:** TypeScript, ES2022, strict mode, `moduleResolution: Bundler`. Must run on Cloudflare Workers (no `node:*` imports; Web Crypto API `crypto.subtle` only).

---

## 1. Purpose

A reusable **Webhook Receiver module** that standardizes how a Host Project receives, parses, validates, and verifies inbound webhooks from external providers. It defines a single execution pipeline:

```
parse request & limit size → resolve verifier → verify signature → validate timestamp → check replay / idempotency → return verified event
```

The Webhook Receiver is the **inbound counterpart** to the Notification module (which is outbound). The module **does NOT perform business actions** (no order processing, subscription updates, or notifications).

### Host responsibilities vs module responsibilities

| Host does | Module does |
|---|---|
| Receives raw HTTP Request in Cloudflare Worker / server handler | Parses headers & enforces raw payload byte size limits |
| Reads `process.env` / `env` secrets and injects `WebhookReceiverConfig` | Verifies cryptographic signatures using injected verifiers/secrets |
| Owns database stores & passes optional `IdempotencyStore` | Validates timestamp freshness & executes idempotency key checks |
| Executes domain business logic on verified event payloads | Normalizes errors into structured `WebhookResult` with safe error codes |

---

## 2. Public API (exact signatures)

All public verification methods are `async` to support Web Crypto API operations. All components are exported from the module's public entry point (`core/index.ts`).

```ts
// core/index.ts
export function createWebhookReceiver(config: WebhookReceiverConfig): WebhookReceiver;

export interface WebhookReceiver {
  /**
   * Primary entry point to verify an incoming webhook request.
   * Parses, checks payload size limit, verifies signature & timestamp,
   * checks replay/idempotency, and extracts verified event data.
   */
  verify(request: WebhookRequest, providerName?: string): Promise<WebhookResult>;
}
```

### 2.1 `createWebhookReceiver(config)`

- **Input:** A typed `WebhookReceiverConfig` (see §8).
- **Behavior:**
  - Validates configuration parameters at creation time.
  - Throws `WEBHOOK_CONFIG_INVALID` if mandatory verifiers are missing or numeric bounds (like `payloadMaxBytes <= 0`) are violated.
  - Freezes the receiver instance configuration.
- **Returns:** An immutable `WebhookReceiver` client exposing `.verify(request, providerName?)`.

### 2.2 `receiver.verify(request, providerName?)`

- **Input:** A `WebhookRequest` object representing the incoming HTTP call (see §3.1), and an optional `providerName` override.
- **Pipeline Execution Steps:**
  1. **Payload Size Guard:** Checks byte length of `rawBody`. If byte length exceeds `payloadMaxBytes` (default 1 MB), returns `{ valid: false, error: WEBHOOK_OVERSIZED_PAYLOAD }` immediately before parsing JSON.
  2. **Header Normalization:** Normalizes request header names to lowercase string records.
  3. **Provider Selection:** Resolves the target `WebhookVerifier` using `providerName`, `request.provider`, or `config.defaultProvider`. If unresolvable, returns `{ valid: false, error: WEBHOOK_UNKNOWN_PROVIDER }`.
  4. **Signature & Timestamp Verification:** Delegates cryptographic signature and header timestamp parsing to the resolved `WebhookVerifier`.
  5. **Timestamp Window Check:** Validates timestamp freshness against `timestampToleranceSeconds` (default 300s). Rejects expired or futuristic timestamps with `WEBHOOK_EXPIRED_TIMESTAMP` or `WEBHOOK_INVALID_TIMESTAMP`.
  6. **Idempotency & Replay Protection:** If an `IdempotencyStore` is configured and an `eventId` is extracted, checks `store.has(eventId)`. If present, returns `{ valid: false, error: WEBHOOK_REPLAY_DETECTED }`.
  7. **Store Update & Result Framing:** If valid and store is configured, calls `store.set(eventId)`. Returns `{ valid: true, eventId, eventType, payload }`.

---

## 3. Core Types & Interfaces

All types are exported from `core/types.ts`.

### 3.1 `WebhookRequest`

```ts
export interface WebhookRequest {
  /** Raw unparsed request body as string or Uint8Array. Mandatory for signature checks. */
  rawBody: string | Uint8Array;
  /** Request headers object or Web Standard Headers object. */
  headers: Record<string, string | string[] | undefined> | Headers;
  /** Optional URL path for providers requiring route path verification. */
  url?: string;
  /** Optional HTTP method (e.g. "POST"). */
  method?: string;
  /** Optional explicit provider name identifier. */
  provider?: string;
}
```

### 3.2 `WebhookResult`

```ts
export type WebhookResult = {
  /** True if signature, timestamp, size limit, and replay checks pass. */
  valid: boolean;
  /** Extracted unique event ID / idempotency key from provider. */
  eventId?: string;
  /** Extracted event type name (e.g. "payment.succeeded", "ping"). */
  eventType?: string;
  /** Parsed JSON payload or decoded body content. */
  payload?: unknown;
  /** Structured error details if valid is false. */
  error?: WebhookError;
};
```

### 3.3 `WebhookEvent`

```ts
export interface WebhookEvent {
  id: string;
  type: string;
  payload: unknown;
  timestamp?: number;
  provider: string;
  signature?: string;
  rawBody: string;
  headers: Record<string, string>;
}
```

### 3.4 `WebhookVerifier` & `VerificationResult`

```ts
export interface WebhookVerifierInput {
  /** Raw body payload exactly as received. */
  rawBody: string;
  /** Normalized lowercase request headers. */
  headers: Record<string, string>;
  /** Pre-extracted timestamp in seconds (if parsed from headers). */
  timestamp?: number;
}

export interface VerificationResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  payload?: unknown;
  timestamp?: number;
  providerMetadata?: Record<string, unknown>;
  error?: WebhookError;
}

export interface WebhookVerifier {
  /** Unique provider identifier (e.g. "generic-hmac", "line", "stripe", "github"). */
  readonly providerName: string;
  /** Cryptographically verifies the raw payload and headers. */
  verify(input: WebhookVerifierInput): Promise<VerificationResult>;
}
```

### 3.5 `IdempotencyStore` Contract

```ts
export interface IdempotencyStore {
  /** Returns true if the eventId has already been processed. */
  has(key: string): Promise<boolean>;
  /** Records an eventId in the dedup store with optional TTL. */
  set(key: string, ttlSeconds?: number): Promise<void>;
}
```

---

## 4. v0.1 Generic HMAC-SHA256 Verifier & Provider Architecture

### 4.1 `GenericHmacConfig` & `GenericHmacVerifier`

The primary adapter shipped in v0.1 is the `GenericHmacVerifier` located in `providers/generic-hmac/`.

```ts
export interface GenericHmacConfig {
  /** Secret key used for HMAC computation. Must never be logged. */
  secret: string;
  /** Header name containing signature (e.g. "x-signature", "x-hub-signature-256"). */
  signatureHeader: string;
  /** Optional header name containing timestamp (e.g. "x-timestamp"). */
  timestampHeader?: string;
  /** Hash algorithm to use. Default 'SHA-256'. */
  algorithm?: 'SHA-256' | 'SHA-512';
  /** Signature encoding format in header. Default 'hex'. */
  encoding?: 'hex' | 'base64';
  /** Optional signature prefix (e.g. "sha256=" or "v1="). */
  prefix?: string;
  /** Maximum allowable age of webhook in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Optional header name containing event ID for idempotency. */
  idempotencyHeader?: string;
  /** Dot-notation JSON path to extract eventId from payload (e.g. "id" or "event_id"). */
  eventIdPath?: string;
  /** Dot-notation JSON path to extract eventType from payload (e.g. "type" or "event"). */
  eventTypePath?: string;
}
```

### 4.2 Web Crypto API Cryptographic Computation

To maintain 100% compatibility with Cloudflare Workers and Web standards:
- **No `node:crypto` imports are permitted.**
- Key import:
  ```ts
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.secret),
    { name: 'HMAC', hash: config.algorithm ?? 'SHA-256' },
    false,
    ['sign']
  );
  ```
- Signature calculation:
  ```ts
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  ```
- Comparison: HMAC signatures are compared using timing-safe buffer comparison (see §6.1).

### 4.3 Provider Registration & Selection Architecture

To ensure the core stays independent of provider implementations, verifiers are registered via `WebhookReceiverConfig`:

```
WebhookReceiver (Core)
   ├── WebhookVerifier Registry (Map<string, WebhookVerifier>)
   │      ├── generic-hmac (v0.1)
   │      ├── line         (v0.x contract placeholder)
   │      ├── stripe       (v0.x contract placeholder)
   │      └── github       (v0.x contract placeholder)
```

Adding a new provider (e.g. Stripe or LINE) requires creating a file in `providers/<name>/` implementing `WebhookVerifier` without modifying `core/verify.ts`.

---

## 5. Replay Protection & Idempotency

### 5.1 Timestamp Tolerance & Replay Protection

1. **Header / Payload Extraction:** Timestamp is retrieved from the specified `timestampHeader` or extracted from provider-specific header formats (e.g. `t=1600000000` in Stripe format).
2. **Current Time Reference:** Current unix epoch time is measured in seconds (`Math.floor(Date.now() / 1000)`).
3. **Tolerance Enforcement:**
   - Difference calculation: `age = Math.abs(currentEpochSeconds - requestTimestampSeconds)`.
   - If `age > toleranceSeconds`, `verify()` returns `{ valid: false, error: WEBHOOK_EXPIRED_TIMESTAMP }`.
   - Protects against replay attacks using captured valid request payloads.

### 5.2 Idempotency Handling

1. **Event Identifier Extraction:**
   - Extracted from `idempotencyHeader` if present.
   - Or extracted via `eventIdPath` from parsed JSON payload.
2. **Store Interaction Pipeline:**
   - If `idempotencyStore` is provided in `WebhookReceiverConfig`:
     - Core executes `await store.has(eventId)`.
     - If `has` returns `true`, pipeline rejects with `WEBHOOK_REPLAY_DETECTED`.
     - If `has` returns `false` and signature/timestamp are valid, core executes `await store.set(eventId, ttlSeconds)`.
3. **v0.1 Scope:** Core only depends on `IdempotencyStore` interface. Host supplies store implementation (e.g. KV / Redis / Memory). No default DB store is packaged in v0.1 core.

---

## 6. Security Requirements

### 6.1 Constant-Time Comparison

Direct string comparison (`===`) leaks timing information through early exits. All signature verifications must use constant-time byte comparisons:

```ts
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let c = 0;
  for (let i = 0; i < a.byteLength; i++) {
    c |= a[i] ^ b[i];
  }
  return c === 0;
}
```

### 6.2 Secret Safety & Error Masking

1. **Zero Secret Leakage:** Secrets, raw HMAC keys, or verification internals must **NEVER** be printed in `console.log`, attached to `WebhookError` messages, or returned in `WebhookResult`.
2. **Error Message Standard:** Error messages state the failure reason generically (e.g. `"Invalid webhook signature"`), omitting received signature bytes or computed hashes.

### 6.3 Payload Size Protection

1. **Pre-execution Check:** Byte size is evaluated prior to string decoding or `JSON.parse()`.
2. **Memory Safety:** If `byteLength > payloadMaxBytes`, execution halts immediately to prevent memory exhaustion / DoS attacks.

---

## 7. Structured Errors

All error responses return structured `WebhookError` objects.

```ts
export interface WebhookError {
  code: WebhookErrorCode;
  message: string;
  provider?: string;
}

export type WebhookErrorCode =
  | 'WEBHOOK_MISSING_SIGNATURE'
  | 'WEBHOOK_INVALID_SIGNATURE'
  | 'WEBHOOK_MISSING_TIMESTAMP'
  | 'WEBHOOK_INVALID_TIMESTAMP'
  | 'WEBHOOK_EXPIRED_TIMESTAMP'
  | 'WEBHOOK_MALFORMED_JSON'
  | 'WEBHOOK_OVERSIZED_PAYLOAD'
  | 'WEBHOOK_REPLAY_DETECTED'
  | 'WEBHOOK_UNKNOWN_PROVIDER'
  | 'WEBHOOK_CONFIG_INVALID';
```

### 7.1 Error Code Semantics

| Error Code | Trigger Condition | Example Message |
|---|---|---|
| `WEBHOOK_MISSING_SIGNATURE` | Expected signature header is missing | `"Missing required signature header: x-signature"` |
| `WEBHOOK_INVALID_SIGNATURE` | Signature HMAC mismatch | `"Invalid cryptographic signature"` |
| `WEBHOOK_MISSING_TIMESTAMP` | Timestamp header expected but missing | `"Missing required timestamp header"` |
| `WEBHOOK_INVALID_TIMESTAMP` | Timestamp string cannot be parsed into integer | `"Invalid timestamp format in header"` |
| `WEBHOOK_EXPIRED_TIMESTAMP` | Timestamp age exceeds `toleranceSeconds` | `"Webhook timestamp expired or outside tolerance window"` |
| `WEBHOOK_MALFORMED_JSON` | Body parsing fails invalid JSON syntax | `"Failed to parse JSON body"` |
| `WEBHOOK_OVERSIZED_PAYLOAD` | Raw body byte length exceeds `payloadMaxBytes` | `"Payload size exceeds maximum allowed limit of 1048576 bytes"` |
| `WEBHOOK_REPLAY_DETECTED` | Event ID already exists in `IdempotencyStore` | `"Replay detected: event ID has already been processed"` |
| `WEBHOOK_UNKNOWN_PROVIDER` | No matching verifier found for requested provider | `"No verifier registered for provider: unknown-service"` |
| `WEBHOOK_CONFIG_INVALID` | Invalid config options passed to factory | `"Invalid WebhookReceiverConfig: defaultProvider not found in verifiers"` |

---

## 8. Module Config Contract

```ts
export interface WebhookReceiverConfig {
  /** Primary verifier instance (convenience for single-provider setup). */
  verifier?: WebhookVerifier;
  /** Dictionary of verifiers keyed by provider name (for multi-provider setup). */
  verifiers?: Record<string, WebhookVerifier>;
  /** Default provider name to use if request doesn't specify one. */
  defaultProvider?: string;
  /** Max raw body size in bytes. Default: 1,048,576 (1 MB). */
  payloadMaxBytes?: number;
  /** Max acceptable timestamp skew/age in seconds. Default: 300 (5 minutes). */
  timestampToleranceSeconds?: number;
  /** Optional idempotency store for replay deduplication. */
  idempotencyStore?: IdempotencyStore;
}
```

- **Config Injection Rule:** Host reads process environment or secret stores and injects `WebhookReceiverConfig`. Core **NEVER** accesses `process.env`, `env`, or `globalThis`.

---

## 9. File Structure & Responsibilities

```
webhook-receiver/
├── core/
│   ├── types.ts          ← Domain interfaces, WebhookRequest, WebhookResult, WebhookError
│   ├── verifier.ts       ← Verifier registry & resolution logic
│   ├── verify.ts         ← Core pipeline execution (verify() orchestrator)
│   ├── payload.ts        ← Payload byte length guard & JSON parser
│   ├── timestamp.ts      ← Timestamp parser & tolerance window validator
│   ├── idempotency.ts    ← Idempotency key extraction & store runner
│   ├── errors.ts         ← WebhookError factory & timingSafeEqual utility
│   └── index.ts          ← Entry point re-exporting public API & factory
├── providers/
│   ├── generic-hmac/
│   │   ├── index.ts      ← Export GenericHmacVerifier
│   │   └── hmac.ts       ← Web Crypto HMAC verification logic
│   ├── line/             ← Contract placeholder for future LINE adapter
│   │   └── index.ts
│   ├── stripe/           ← Contract placeholder for future Stripe adapter
│   │   └── index.ts
│   └── github/           ← Contract placeholder for future GitHub adapter
│       └── index.ts
├── tests/
│   ├── verify.test.ts          ← Core verification pipeline integration unit tests
│   ├── generic-hmac.test.ts    ← HMAC SHA-256 / SHA-512 calculation & header matching tests
│   ├── timestamp.test.ts       ← Timestamp tolerance window & drift tests
│   ├── payload.test.ts         ← Size limit enforcement & JSON parsing tests
│   ├── idempotency.test.ts     ← Idempotency extraction & store interface mock tests
│   └── security.test.ts        ← Timing safety, secret leakage, & prototype isolation tests
├── integration.example.ts      ← Reference Cloudflare Worker integration sample
├── MODULE.md                   ← Module documentation & usage guide
├── VERSION                     ← "0.1.0"
├── package.json                ← Dependencies & Vitest runner config
└── tsconfig.json               ← TypeScript compiler options
```

### 9.1 File Responsibilities

- **`core/types.ts`**: Pure type declarations only. No logic or runtime imports.
- **`core/verifier.ts`**: Manages verifier map lookup, fallback selection, and validation.
- **`core/verify.ts`**: Main `verify()` pipeline orchestrating payload check, verifier execution, timestamp check, and idempotency dedup.
- **`core/payload.ts`**: Byte calculation helper and strict JSON parsing.
- **`core/timestamp.ts`**: Timestamp tolerance window comparison helper.
- **`core/idempotency.ts`**: Extracts idempotency key and interfaces with `IdempotencyStore`.
- **`core/errors.ts`**: Defines error creation helpers and `timingSafeEqual`.
- **`core/index.ts`**: Public API barrel re-exporting `createWebhookReceiver` and public types.
- **`providers/generic-hmac/hmac.ts`**: Implements `WebhookVerifier` using Web Crypto `crypto.subtle`.

---

## 10. Test Plan Outline (Stage 3 Tester)

Vitest test suites must validate the following behaviors:

1. **`verify.test.ts`**
   - End-to-end success path returns `{ valid: true, eventId, eventType, payload }`.
   - Unknown provider name returns `WEBHOOK_UNKNOWN_PROVIDER`.
   - Missing required verifier in config throws `WEBHOOK_CONFIG_INVALID`.

2. **`generic-hmac.test.ts`**
   - Valid HMAC signature returns `valid: true`.
   - Invalid HMAC signature returns `WEBHOOK_INVALID_SIGNATURE`.
   - Missing signature header returns `WEBHOOK_MISSING_SIGNATURE`.
   - Supports hex and base64 signature encoding formats.
   - Prefix matching (e.g. `sha256=...` or `v1=...`) operates correctly.

3. **`timestamp.test.ts`**
   - Fresh timestamp within tolerance window passes verification.
   - Expired timestamp (> 300s old) returns `WEBHOOK_EXPIRED_TIMESTAMP`.
   - Future timestamp outside tolerance window returns `WEBHOOK_EXPIRED_TIMESTAMP`.
   - Missing timestamp header returns `WEBHOOK_MISSING_TIMESTAMP`.

4. **`payload.test.ts`**
   - Payload under size limit processes successfully.
   - Payload exceeding `payloadMaxBytes` immediately rejects with `WEBHOOK_OVERSIZED_PAYLOAD` without parsing JSON.
   - Malformed JSON string returns `WEBHOOK_MALFORMED_JSON`.

5. **`idempotency.test.ts`**
   - Extracts `eventId` from header or body dot-path.
   - First-time event calls `store.has()` (false) and `store.set()`, returning `valid: true`.
   - Duplicate event calls `store.has()` (true), returning `WEBHOOK_REPLAY_DETECTED`.

6. **`security.test.ts`**
   - `timingSafeEqual` returns `false` on length mismatch and byte mismatch.
   - Secret keys are never present in error messages or stringified errors.
   - Header normalization handles uppercase/lowercase headers safely without prototype mutation.

---

## 11. `package.json` and `tsconfig.json` Setup

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["core", "providers", "tests", "integration.example.ts"]
}
```

### `package.json`

```json
{
  "name": "webhook-receiver",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Reusable Webhook Receiver module — receives, verifies, and standardizes inbound webhooks using Web Crypto API. Host injects config, module verifies cryptographically without reading env.",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "5.6.3",
    "vitest": "2.1.4"
  }
}
```

---

## 12. `integration.example.ts` (Reference Usage)

Reference Cloudflare Worker host integration showing how a Host reads its environment, initializes a generic HMAC verifier, and verifies incoming webhooks.

```ts
import { createWebhookReceiver } from './core';
import { GenericHmacVerifier } from './providers/generic-hmac';

interface Env {
  WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Host reads its own env and instantiates the verifier
    const hmacVerifier = new GenericHmacVerifier({
      secret: env.WEBHOOK_SECRET,
      signatureHeader: 'x-hub-signature-256',
      timestampHeader: 'x-webhook-timestamp',
      prefix: 'sha256=',
      toleranceSeconds: 300,
      eventIdPath: 'id',
      eventTypePath: 'type',
    });

    const receiver = createWebhookReceiver({
      verifier: hmacVerifier,
      payloadMaxBytes: 1_048_576, // 1 MB limit
    });

    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const result = await receiver.verify({
      rawBody,
      headers,
    });

    if (!result.valid) {
      console.error('Webhook verification failed:', result.error?.code, result.error?.message);
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Host executes domain logic on verified event
    console.log('Received verified event:', result.eventId, result.eventType);
    
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};
```

---

## 13. Explicit Non-Goals (do NOT build)

- ❌ **No business logic:** No order status changes, subscription handling, ticket updates, or customer domain logic.
- ❌ **No database implementation:** No pre-packaged SQLite/Postgres/Redis drivers. Core only consumes the `IdempotencyStore` interface.
- ❌ **No outbound actions:** No LINE reply API calls, Stripe API mutations, or email notifications (outbound is Notification module's responsibility).
- ❌ **No `node:*` module imports:** No `node:crypto`, `node:http`, or Node-specific dependencies. Must run purely on Web standard APIs (`crypto.subtle`).
- ❌ **No direct env access:** Core module never reads `process.env`, `env`, or global execution context.
- ❌ **No hard-coded provider enum in core:** Provider verifiers are pluggable adapters registered via configuration.

---

## 14. Acceptance Criteria (Stage 4 Reviewer Checklist)

1. `DESIGN.md` exists at `D:\AI-Workspace\projects\modules-hub\modules\webhook-receiver\DESIGN.md`.
2. Module public API matches `createWebhookReceiver` and `receiver.verify()` contracts in §2.
3. Cryptographic operations use Web Crypto API (`crypto.subtle`) with zero `node:*` imports.
4. Payload size limit guard halts processing BEFORE parsing JSON or performing cryptographic checks when body exceeds `payloadMaxBytes`.
5. HMAC signature verification uses timing-safe byte comparison (`timingSafeEqual`).
6. Replay protection enforces configurable timestamp tolerance window (`timestampToleranceSeconds`).
7. Idempotency interface `IdempotencyStore` is defined and integrated without tying core to a specific DB.
8. Errors are returned as structured `WebhookError` objects using standard codes in §7, never leaking secrets or internal signature details.
9. Provider directory structure (`providers/`) supports adding adapters (HMAC, LINE, Stripe, GitHub) without modifying core files.
10. `package.json` and `tsconfig.json` match project standards (ES2022, Bundler, Vitest 2.1.4, TS 5.6.3).
