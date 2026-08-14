# Audit Log Module — DESIGN.md

**Version:** 0.1.0 (P0, experimental)  
**Status:** Design (Stage 1 — Architect). This file is the single source of truth for downstream agents (Stage 2 implementer, Stage 3 tester, Stage 4 reviewer).  
**Language / runtime:** TypeScript, ES2022, strict mode, `moduleResolution: Bundler`. Must run on Cloudflare Workers (no `node:*` imports; Web Crypto API only if crypto is needed).

---

## 1. Purpose

A reusable **Audit Log module** that records audit events capturing:
> *Who* (actor) did *what* (action) to *which data* (entity) and *when* (timestamp), along with previous state (*before*), updated state (*after*), and contextual *metadata*.

It defines a single pipeline:

```text
Host Action → AuditLogCore (Validate → Redact → Immutable Snapshot) → AuditStore Adapter (InMemory / Supabase Postgres)
```

The module **must NOT read global env itself**. The Host reads env and injects config via the public API. The module has **no business-specific logic** (no booking, ticket, shop, order, or customer specifics).

### Host responsibilities vs module responsibilities

| Host does | Module does |
|---|---|
| Reads `process.env` / `env` / `globalThis` | Never touches env — receives config as an argument |
| Manages DB connections, Supabase keys, or env parameters | Accepts an injected `AuditStore` adapter instance in `AuditLogConfig` |
| Defines host-specific sensitive fields (e.g. `ssn`, `taxId`) | Provides built-in redaction (`password`, `token`, `secret`, `authorization`, `apiKey`, `creditCard`) plus host custom fields |
| Invokes `audit.record(...)` upon performing domain actions | Validates, redacts, deep-clones immutable snapshots, auto-generates ISO 8601 timestamps & UUIDs, and appends to store |
| Invokes `audit.query(...)` for audit queries | Delegates filtering (`actor`, `action`, `entity`, `dateRange`, pagination) to the store adapter |
| Decides authorization & access control for audit logs | Enforces append-only storage semantics (no edit/delete methods in module API) |

---

## 2. Public API (exact signatures)

All public methods are exposed on the `AuditLogClient` interface returned by `createAuditLog(config)`, exported from the module's public entry point (`core/index.ts`).

```ts
// core/audit.ts
export function createAuditLog(config: AuditLogConfig): AuditLogClient;

// AuditLogClient (all operational methods async)
export interface AuditLogClient {
  record(event: AuditEvent): Promise<RecordResult>;
  query(filters: QueryFilters): Promise<QueryResult>;
  close?(): Promise<void>;
}
```

### 2.1 `createAuditLog(config)`

- Input: an `AuditLogConfig` object (see §4) that the Host constructed.
- Returns an `AuditLogClient` bound to the injected store adapter and redaction rules.
- **Never reads `process.env`, `env`, or `globalThis`.** It reads only the `config` argument.
- Throws an `AuditError` (`CONFIG_INVALID`) at **construction time** if the config is malformed (e.g. missing `store`, invalid custom redaction field names, invalid mask). This catches configuration bugs immediately at startup.

### 2.2 `record(event)`

- Input: an `AuditEvent` object (see §3).
- Pipeline: **Validate input event → Redact sensitive fields in `before`, `after`, `metadata` → Deep-clone immutable snapshots → Generate ID & ISO 8601 timestamp → Append to `AuditStore` → Return `RecordResult`**.
- Returns a `RecordResult` (see §3). On success `success: true` with `recordId` and `timestamp`. On failure `success: false` with a structured `error` (see §6).
- **Never throws** for validation, redaction, or storage failures — it returns a `RecordResult` with `success: false` and a structured `error`. (The only throw occurs at construction time for a malformed config.)
- **Does NOT mutate** the caller's input `AuditEvent` object. The recorded `before`, `after`, and `metadata` are immutable deep-cloned snapshots.

### 2.3 `query(filters)`

- Input: a `QueryFilters` object (see §3).
- Returns a `QueryResult` (`{ success: boolean; records?: readonly AuditRecord[]; total?: number; error?: AuditError }`).
- Delegates query execution to `config.store.query(filters)`.
- On adapter failure, returns `success: false` with a structured `error` (`QUERY_FAILED` or `PROVIDER_ERROR`).

### 2.4 `close()`

- Optional cleanup method.
- Delegates to `config.store.close?.()` if defined on the adapter (e.g. closing database client pools or flushing pending writes).

---

## 3. Core contract types (exact)

```ts
export type AuditActor = {
  /** Optional ID of the acting user/service (e.g. "usr_123", "service_payment") */
  id?: string;
  /** Type of actor (e.g. "user", "system", "admin", "cron", "api_key") */
  type: string;
};

export type AuditEntity = {
  /** Entity domain type (e.g. "ticket", "invoice", "user_profile", "document") */
  type: string;
  /** Entity unique identifier (e.g. "TKT-1002", "inv_88492") */
  id: string;
};

export type AuditEvent = {
  /** Who performed the action */
  actor: AuditActor;
  /** Action performed (e.g. "status.changed", "user.created", "permission.revoked") */
  action: string;
  /** Target entity affected by this action */
  entity: AuditEntity;
  /** State prior to action execution (optional) */
  before?: unknown;
  /** State following action execution (optional) */
  after?: unknown;
  /** Arbitrary contextual metadata (optional) */
  metadata?: Record<string, unknown>;
  /** Timestamp in ISO 8601 string format (optional; derived if omitted) */
  timestamp?: string;
};

export type AuditRecord = {
  /** Unique record identifier (v4 UUID) */
  id: string;
  /** Actor information */
  actor: AuditActor;
  /** Action string */
  action: string;
  /** Entity information */
  entity: AuditEntity;
  /** State prior to action, redacted & deep-cloned (optional) */
  before?: unknown;
  /** State following action, redacted & deep-cloned (optional) */
  after?: unknown;
  /** Contextual metadata, redacted & deep-cloned (optional) */
  metadata?: Record<string, unknown>;
  /** Guaranteed UTC timestamp in ISO 8601 format (e.g. "2026-08-10T07:00:00.000Z") */
  timestamp: string;
};

export type RecordResult = {
  success: boolean;
  recordId?: string;
  timestamp?: string;
  error?: AuditError;
};

export type DateRangeFilter = {
  /** Start of date range (inclusive, ISO 8601 string) */
  from?: string;
  /** End of date range (inclusive, ISO 8601 string) */
  to?: string;
};

export type QueryFilters = {
  actor?: {
    id?: string;
    type?: string;
  };
  action?: string;
  entity?: {
    type?: string;
    id?: string;
  };
  dateRange?: DateRangeFilter;
  /** Maximum number of records to return (default: 50, max: 1000) */
  limit?: number;
  /** Offset for pagination (default: 0) */
  offset?: number;
};

export type QueryResult = {
  success: boolean;
  records?: readonly AuditRecord[];
  total?: number;
  error?: AuditError;
};
```

### 3.1 `AuditEvent` rules

- `actor` is **required**. Must be an object with non-empty string `type`. `id` is optional.
- `action` is **required**. Must be a non-empty string.
- `entity` is **required**. Must be an object with non-empty string `type` and non-empty string `id`.
- `before` and `after` are optional `unknown` values (JSON-serializable objects, primitives, or arrays).
- `metadata` is an optional key-value map (`Record<string, unknown>`).
- `timestamp` is optional. If supplied, it must be a valid ISO 8601 date string. If omitted, `AuditLogCore` supplies current UTC timestamp in ISO 8601 format.

---

## 4. `AuditLogConfig` type (exact)

```ts
export interface RedactionConfig {
  /** Additional field names to redact in addition to built-in list. */
  customSensitiveFields?: readonly string[];
  /** Mask string replacement. Default: "[REDACTED]" */
  mask?: string;
}

export interface AuditLogConfig {
  /** The storage adapter (InMemory, Postgres, etc.). Core never talks to DB directly. */
  store: AuditStore;
  /** Redaction engine options. */
  redaction?: RedactionConfig;
  /** Optional custom clock function (primarily for deterministic unit testing). */
  getCurrentTimestamp?: () => string;
}
```

### 4.1 Config rules

- `store` is **required**. Missing store → throws `CONFIG_INVALID` at construction.
- `redaction` is optional:
  - `customSensitiveFields`: array of field names (case-insensitive key matching).
  - `mask`: default is `"[REDACTED]"`. Must be a string.
- `getCurrentTimestamp` is optional. Default uses `new Date().toISOString()`.

---

## 5. Design decisions (exact — downstream agents implement from this)

### 5.1 Redaction Engine Rules (`core/redact.ts`)

Data recorded in `before`, `after`, and `metadata` may contain credentials, PII, or secrets. Redaction runs **automatically** on every record call before persisting to storage.

1. **Built-in sensitive field names (case-insensitive):**
   - `password`
   - `token`
   - `secret`
   - `authorization`
   - `apiKey` / `apikey`
   - `creditCard` / `creditcard`
   - `ssn`
   - `privateKey` / `privatekey`

2. **Host customizable fields:**
   - Host provides `customSensitiveFields` via `AuditLogConfig.redaction`.
   - The engine merges built-in fields with `customSensitiveFields` into a unified normalization set (lowercased for case-insensitive matching).

3. **Traversing & Masking Behavior:**
   - Redaction recursively inspects nested objects, dictionaries, and arrays within `before`, `after`, and `metadata`.
   - If an object key matches any sensitive field (case-insensitive exact string match):
     - Primitive values (string, number, boolean, null, undefined) are replaced with the mask string (e.g. `"[REDACTED]"`).
     - Nested object/array values assigned to a sensitive key are replaced wholesale with the mask string (e.g. `"[REDACTED]"`).
   - If an object key is non-sensitive:
     - Its value is recursively traversed and redacted.
   - Arrays are traversed element by element.
   - Non-plain objects (Date, RegExp) and primitives are passed through safely.
   - Circular references must be handled safely (e.g. using a `WeakSet` during traversal) without throwing unhandled stack overflow errors.

4. **Mask Replacement:**
   - Default mask string is `"[REDACTED]"`.
   - Can be overridden by Host via `config.redaction.mask`.

### 5.2 Deep-cloning & Immutability Snapshot (`core/clone.ts`)

Audit history must capture the state **at the moment `record()` was called**.

- `AuditLogCore` performs a deep clone during redaction of `before`, `after`, and `metadata`.
- The caller's input object (`AuditEvent`) is **never mutated**.
- Any modification made by the caller to their local domain objects after invoking `audit.record()` will **have zero effect** on the stored `AuditRecord`.
- Verification test requirement: mutating an object passed as `before` or `after` immediately after `record()` must not affect the query result.

### 5.3 Append-Only Guarantee (`core/audit.ts` & `adapters/`)

- Audit records are strictly append-only.
- The `AuditLogClient` public interface exposes only `record(...)` and `query(...)`. There are **no methods for update, delete, or truncate**.
- The `AuditStore` adapter contract exposes only `append(...)` and `query(...)`.
- Adapters enforce append-only guarantees at the storage layer (e.g., PostgreSQL table permissions with `REVOKE UPDATE, DELETE ON audit_logs`).

### 5.4 ID and Timestamp Generation (`core/audit.ts`)

- `id`: Derived using `crypto.randomUUID()` from the Web Crypto API. **NO `node:crypto` import.** Compatible with Cloudflare Workers.
- `timestamp`: If `event.timestamp` is supplied and valid ISO 8601, use it. Otherwise, generate timestamp using `config.getCurrentTimestamp?.() ?? new Date().toISOString()`.

### 5.5 Security & Secret Safety Requirements

1. **No business domain code:** Core uses generic terms (`actor`, `action`, `entity`, `before`, `after`, `metadata`).
2. **Secret leakage prevention in errors:** Error messages and `AuditError` objects must **NEVER** contain sensitive values, credentials, or unredacted object content.
3. **No global env reading:** Core never references `process.env`, `env`, or `globalThis`.
4. **Cloudflare Worker compatibility:** Pure ES2022 TypeScript, zero Node.js built-in dependencies (`no node:fs`, `no node:crypto`).

---

## 6. Structured errors

All errors returned by the module are instances of `AuditError`:

```ts
export interface AuditError {
  code: AuditErrorCode;
  message: string;   // human-readable, MUST NOT contain sensitive values or secrets
  cause?: unknown;   // internal error for debugging (never serialized to Host)
}

export type AuditErrorCode =
  | 'CONFIG_INVALID'
  | 'EVENT_INVALID'
  | 'REDACTION_FAILED'
  | 'STORE_FAILED'
  | 'QUERY_FAILED'
  | 'PROVIDER_ERROR';
```

### 6.1 Code semantics

| Code | When returned / thrown | Notes |
|---|---|---|
| `CONFIG_INVALID` | `createAuditLog` receives a malformed config (missing store, invalid mask) | Construction-time throw |
| `EVENT_INVALID` | `record()` receives missing actor, action, or entity (`type` / `id` missing or empty) | Returned in `RecordResult.error` |
| `REDACTION_FAILED` | Exception during redaction recursion (e.g. unhandled custom getter crash) | Returned in `RecordResult.error` |
| `STORE_FAILED` | `store.append()` throws an error | Returned in `RecordResult.error` |
| `QUERY_FAILED` | `store.query()` throws an error or filter validation fails | Returned in `QueryResult.error` |
| `PROVIDER_ERROR` | Adapter database failure or connection error | Returned in result object `error` |

### 6.2 Error safety rules

- **Error messages must NEVER contain secrets or unredacted data.**
- Example safe message: `"Invalid event: missing required field 'entity.id'"`.
- Unsafe message (FORBIDDEN): `"Failed to save event with password 'secret123'"`.

---

## 7. `AuditStore` adapter interface (exact)

The core talks **only** to this interface. It has no direct knowledge of database schemas, SQL drivers, or Supabase clients.

```ts
export interface AuditStoreQueryResult {
  records: AuditRecord[];
  total: number;
}

export interface AuditStore {
  /** Append a single redacted audit record to storage. */
  append(record: AuditRecord): Promise<void>;

  /** Query audit records matching filters. */
  query(filters: QueryFilters): Promise<AuditStoreQueryResult>;

  /** Optional connection cleanup / teardown. */
  close?(): Promise<void>;
}
```

### 7.1 `InMemoryAuditStore` (v0.1 reference & testing adapter)

Factory: `createInMemoryAuditStore(): AuditStore`

- Stores records in an internal private array (`AuditRecord[]`).
- `append(record)` pushes a deep-cloned copy of `record` to the internal array.
- `query(filters)` filters in-memory by:
  - `actor.id` and `actor.type` (exact match if specified)
  - `action` (exact match if specified)
  - `entity.type` and `entity.id` (exact match if specified)
  - `dateRange.from` (timestamp >= from) and `dateRange.to` (timestamp <= to)
  - `offset` (default 0) and `limit` (default 50, capped at 1000)
- Returns deep-cloned copies of matching `AuditRecord`s so host callers cannot mutate internal state.

### 7.2 `PostgresAuditStore` (Supabase / Postgres adapter plan)

Factory: `createPostgresAuditStore(options: PostgresAuditStoreOptions): AuditStore`

- Options accepts a generic query runner / SQL executor function or Supabase client injected by Host:
  ```ts
  export interface PostgresAuditStoreOptions {
    /** SQL query executor provided by Host (e.g. postgres pool, neon, or supabase rpc) */
    query: <T = unknown>(sql: string, params: unknown[]) => Promise<{ rows: T[]; count?: number }>;
    /** Table name in postgres (default: "audit_logs") */
    tableName?: string;
  }
  ```

#### Database Schema DDL (PostgreSQL)

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  actor_id TEXT,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before JSONB,
  after JSONB,
  metadata JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs (timestamp DESC);

-- Enforce Append-Only at Database Layer
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
```

---

## 8. File structure (exact)

```text
modules/audit-log/
├── core/
│   ├── types.ts          ← All public & internal types (AuditEvent, AuditRecord, AuditLogConfig, QueryFilters, QueryResult, RecordResult, AuditError, AuditStore)
│   ├── validate.ts       ← Input validation for AuditEvent & QueryFilters
│   ├── redact.ts         ← Recursive sensitive field redaction engine
│   ├── clone.ts          ← Safe deep-cloning & immutability helpers
│   ├── audit.ts          ← AuditLogClient implementation & createAuditLog() factory
│   └── index.ts          ← Public barrel: exports createAuditLog, AuditLogClient, and types
├── adapters/
│   ├── memory.ts         ← InMemory AuditStore implementation (reference & unit testing)
│   └── postgres.ts       ← Supabase / Postgres AuditStore implementation
├── tests/
│   ├── validate.test.ts  ← Unit tests for event & filter validation
│   ├── redact.test.ts    ← Unit tests for redaction engine & secret safety
│   ├── memory.test.ts    ← Unit tests for InMemory store (append & query filters)
│   └── audit.test.ts     ← Integration/unit tests for AuditLogClient, immutability, & error handling
├── integration.example.ts← Generic Cloudflare Worker Host integration example
├── MODULE.md             ← Module documentation (written by Stage 2 implementer)
├── VERSION               ← Plain text file containing "0.1.0"
├── package.json          ← Package manifest (vitest, typescript)
└── tsconfig.json         ← TypeScript configuration (ES2022, strict, Bundler)
```

### 8.1 File responsibilities

- **`core/types.ts`**: Pure type definitions. No implementation code.
- **`core/validate.ts`**: Pure functions `validateEvent(event)` and `validateFilters(filters)`.
- **`core/redact.ts`**: `redactObject(data, options)` implementing recursive traversal & field masking.
- **`core/clone.ts`**: `deepClone(data)` providing isolation guarantees.
- **`core/audit.ts`**: Orchestrates validate → redact → clone → store.append. Implements `createAuditLog(config)`.
- **`core/index.ts`**: Entry point barrel file re-exporting public functions and types.
- **`adapters/memory.ts`**: `createInMemoryAuditStore()`.
- **`adapters/postgres.ts`**: `createPostgresAuditStore(options)` for Supabase / PostgreSQL.
- **`tests/`**: Vitest test suites.
- **`integration.example.ts`**: Reference host integration example for Cloudflare Workers.
- **`MODULE.md`**: Architectural & usage overview documentation.
- **`VERSION`**: `0.1.0`.

---

## 9. Test requirements (for Stage 3 tester)

Vitest unit tests must cover at minimum:

1. **`validate.test.ts`**
   - Valid `AuditEvent` passes validation.
   - Missing `actor` or `actor.type` → `EVENT_INVALID`.
   - Missing `action` → `EVENT_INVALID`.
   - Missing `entity` or `entity.type`/`entity.id` → `EVENT_INVALID`.
   - Malformed timestamp string → `EVENT_INVALID`.

2. **`redact.test.ts`**
   - Built-in fields (`password`, `token`, `secret`, `authorization`, `apiKey`, `creditCard`, `ssn`, `privateKey`) redacted to `"[REDACTED]"`.
   - Case-insensitive field matching (`PASSWORD`, `ApiKey`, `creditcard`).
   - Host `customSensitiveFields` correctly redacted.
   - Custom mask string applied when provided in config.
   - Deeply nested objects redacted correctly.
   - Array elements containing objects redacted correctly.
   - Primitive non-sensitive fields untouched.
   - Circular reference objects handled safely without stack overflow.
   - Error messages verify zero secret leakage.

3. **`memory.test.ts`**
   - `append()` stores records accurately.
   - `query()` filter by `actor.id` and `actor.type`.
   - `query()` filter by `action`.
   - `query()` filter by `entity.type` and `entity.id`.
   - `query()` filter by `dateRange` (`from` and `to`).
   - Pagination (`limit` and `offset`) returns correct subset and count.
   - Returned records from query are independent copies (mutating query result does not mutate store state).

4. **`audit.test.ts`**
   - `createAuditLog` without `store` throws `CONFIG_INVALID`.
   - `record()` success returns `success: true`, valid `recordId` (UUID v4), and ISO 8601 `timestamp`.
   - Immutability check: Mutating `before`/`after`/`metadata` objects on host side *after* calling `record()` has **no effect** on stored data.
   - Automatic timestamp generation when `event.timestamp` is omitted.
   - Store failure during `append()` returns `RecordResult` with `success: false` and `STORE_FAILED` (does NOT throw unhandled error).
   - `query()` delegates accurately to underlying store adapter.

---

## 10. `integration.example.ts` (reference shape)

A generic Cloudflare Worker Host example demonstrating Host reading env and injecting the adapter + config.

```ts
import { createAuditLog, AuditEvent } from './core';
import { createInMemoryAuditStore } from './adapters/memory';

// Host environment signature
interface Env {
  ENVIRONMENT: string;
  CUSTOM_SECRET_HEADER?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Host initializes the storage adapter
    const store = createInMemoryAuditStore();

    // 2. Host initializes the Audit Log client with config & custom redaction
    const audit = createAuditLog({
      store,
      redaction: {
        customSensitiveFields: ['customSecretHeader', 'internalToken'],
        mask: '[CONFIDENTIAL]',
      },
    });

    // 3. Example domain action execution
    const beforeState = { status: 'draft', internalToken: 'tok_abc123' };
    const afterState = { status: 'published', internalToken: 'tok_abc123' };

    const result = await audit.record({
      actor: {
        id: 'usr_9981',
        type: 'user',
      },
      action: 'document.published',
      entity: {
        type: 'document',
        id: 'doc_4412',
      },
      before: beforeState,
      after: afterState,
      metadata: {
        ip: request.headers.get('cf-connecting-ip') ?? '127.0.0.1',
        customSecretHeader: env.CUSTOM_SECRET_HEADER,
      },
    });

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), { status: 500 });
    }

    // 4. Query example
    const logs = await audit.query({
      entity: { type: 'document', id: 'doc_4412' },
      limit: 10,
    });

    return new Response(JSON.stringify({ recordId: result.recordId, logs: logs.records }), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
```

---

## 11. `package.json` and `tsconfig.json`

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
  "include": ["core", "adapters", "tests", "integration.example.ts"]
}
```

### `package.json`

```json
{
  "name": "audit-log-module",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Reusable Audit Log module — Host injects config & adapter, core handles validation, redaction, immutability, and queries.",
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

## 12. Explicit non-goals (do NOT build)

- ❌ **No analytics / dashboards / metrics visualization:** Out of scope for audit log core.
- ❌ **No automated alerting / SIEM integrations / Webhooks:** Out of scope for v0.1.
- ❌ **No full event sourcing engine:** Audit Log records change history; it is not an event-sourcing replay framework.
- ❌ **No global env reading:** Core never reads `process.env`, `env`, or `globalThis`.
- ❌ **No business domain assumptions:** Core has zero knowledge of booking, ticket, shop, order, or customer concepts.
- ❌ **No Node.js core module dependencies:** No `node:fs`, `node:crypto`, or `node:path`. Web Crypto API only (`crypto.randomUUID()`).
- ❌ **No DB migration runner in v0.1:** Adapter provides SQL DDL schema for host setup; module does not run migrations automatically.
- ❌ **No update or delete APIs:** History is strictly append-only.

---

## 13. Acceptance criteria (for Stage 4 reviewer)

1. `DESIGN.md` exists at `D:\AI-Workspace\projects\modules-hub\modules\audit-log\DESIGN.md` matching this exact structure and depth.
2. Public API exposes `createAuditLog(config)` returning an `AuditLogClient` with `record()`, `query()`, and optional `close()`.
3. Types `AuditEvent`, `AuditRecord`, `AuditLogConfig`, `QueryFilters`, `QueryResult`, `RecordResult`, `AuditError`, and `AuditStore` match §3, §4, §6, and §7 exactly.
4. Automatic redaction engine handles built-in sensitive fields (`password`, `token`, `secret`, `authorization`, `apiKey`, `creditCard`, `ssn`, `privateKey`) and host `customSensitiveFields` recursively across `before`, `after`, and `metadata`.
5. Immutable snapshot guarantees enforced: recorded `before`/`after`/`metadata` are deep-cloned; host object mutation after `record()` does not affect stored records.
6. History is strictly append-only with zero update/delete API methods.
7. Error handling returns structured `{ code, message }` with exact codes from §6 and guarantees zero secret leakage.
8. Core communicates exclusively with the `AuditStore` interface — zero database-specific code in `core/`.
9. Module never reads `process.env` / `env` / `globalThis`.
10. `npm run typecheck` and `npm test` scripts configured with ES2022, strict mode, Bundler module resolution, TypeScript 5.6.3, and Vitest 2.1.4.
11. Cloudflare Workers compatible — zero `node:*` imports.
