# Audit Log Module

**Version:** 0.1.0 (P0, experimental)
**Status:** Reusable embedded module — core + InMemory and Postgres adapters implemented.

## Architecture

This module is a **reusable embedded module** — not a standalone service or framework.
A Host project that needs append-only, tamper-evident audit logging embeds this module
into its own codebase and calls the public API from its own code.

The module has one job: accept an `AuditLogConfig` that the Host constructs → validate
the event → redact sensitive fields → deep-clone an immutable snapshot → delegate storage
to the injected `AuditStore` adapter → return a typed result object. It never throws on
validation, redaction, or storage failures; it returns `{ success: false, error }` instead.

The module **never** reads env (`process.env` / `env` / `globalThis`). The Host reads its
own env and injects the adapter + config via `createAuditLog(config)`.

### Host vs. module responsibilities

| Host must do | Module does |
|---|---|
| Read env / secrets (DB credentials, custom sensitive field names) | Accept config through `createAuditLog(config)` |
| Construct a store adapter (`createInMemoryAuditStore` or `createPostgresAuditStore`) | Validate config at construction time — throws `CONFIG_INVALID` if malformed |
| Build `AuditLogConfig` and call `createAuditLog` | Validate each audit event (actor, action, entity required; timestamp format if supplied) |
| Call `audit.record(event)` after domain actions | Automatically redact sensitive fields in `before`, `after`, and `metadata` |
| Call `audit.query(filters)` to retrieve audit history | Deep-clone immutable snapshots — never mutates the Host's input objects |
| Handle `{ success: false, error }` results in its own response layer | Generate UUID record IDs via Web Crypto and ISO 8601 timestamps |
| Enforce access control to the audit query endpoint | Enforce append-only storage semantics (no update or delete methods) |
| Run `AUDIT_LOG_DDL` to provision the Postgres table | Delegate all I/O to the injected `AuditStore` adapter |

## Public API

All exports come from `./core` (barrel). Do not import from sub-files directly.

```ts
import { createAuditLog } from './core';
import type {
  AuditLogConfig, AuditEvent, QueryFilters,
  AuditLogClient, RecordResult, QueryResult,
  AuditRecord, AuditActor, AuditEntity, AuditError, AuditErrorCode,
  AuditStore, RedactionConfig,
} from './core';

import { createInMemoryAuditStore } from './adapters/memory';
import { createPostgresAuditStore, AUDIT_LOG_DDL } from './adapters/postgres';
```

### `createAuditLog(config: AuditLogConfig): AuditLogClient`

Validates the config at construction time. **Throws** `AuditError` with code `CONFIG_INVALID`
if any field is malformed. On success returns an `AuditLogClient` bound to the given config.

**Config validation rules (all checked synchronously at construction):**
- `store` must be present and implement the `AuditStore` interface (`append` and `query` functions).
- `redaction.mask`, if provided, must be a string.
- `redaction.customSensitiveFields`, if provided, must be an array of non-empty strings.
- `getCurrentTimestamp`, if provided, must be a function.

### `AuditLogClient` methods

All methods are async. `record()` and `query()` **never throw** on validation, redaction, or
storage failures — they return a typed result object with `success: boolean` and an optional
`error: AuditError`. Only `createAuditLog()` throws (at construction, for bad config).

#### `record(event: AuditEvent): Promise<RecordResult>`

Pipeline: **Validate event → Redact sensitive fields in `before`, `after`, `metadata` →
Deep-clone immutable snapshot → Generate UUID + ISO 8601 timestamp → Append to `AuditStore`
→ Return `RecordResult`**.

On **validation failure** returns `{ success: false, error: { code: 'EVENT_INVALID' } }`.
On **redaction failure** returns `{ success: false, error: { code: 'REDACTION_FAILED' } }`.
On **store failure** returns `{ success: false, error: { code: 'STORE_FAILED' } }`.
On **success** returns `{ success: true, recordId, timestamp }`.

The caller's `AuditEvent` input is **never mutated**. The recorded `before`, `after`, and
`metadata` are immutable deep-cloned snapshots — any mutation to the Host's local objects
after `record()` returns has zero effect on stored data.

#### `query(filters: QueryFilters): Promise<QueryResult>`

Delegates query execution to `config.store.query(filters)` after validating the filters.

On **filter validation failure** returns `{ success: false, error: { code: 'QUERY_FAILED' } }`.
On **store failure** returns `{ success: false, error: { code: 'QUERY_FAILED' } }`.
On **success** returns `{ success: true, records, total }`.

#### `close(): Promise<void>`

Delegates to `config.store.close?.()` if the adapter defines it. Use to release DB
connections or flush pending writes. The method is optional on the `AuditLogClient` interface
(`close?(): Promise<void>`); always use `?.` when calling it against the interface type.

## Config contract

### `AuditLogConfig`

```ts
interface AuditLogConfig {
  store: AuditStore;                  // required — injected by Host
  redaction?: RedactionConfig;        // optional — defaults to built-in sensitive field list
  getCurrentTimestamp?: () => string; // optional — custom clock (useful for deterministic tests)
}

interface RedactionConfig {
  customSensitiveFields?: readonly string[]; // merged with built-in list; case-insensitive
  mask?: string;                             // replacement string; default: "[REDACTED]"
}
```

| Field | Required | Validation rule |
|---|---|---|
| `store` | yes | must implement `AuditStore` (`append` and `query` functions required) |
| `redaction.customSensitiveFields` | no | array of non-empty strings |
| `redaction.mask` | no | any string; default is `"[REDACTED]"` |
| `getCurrentTimestamp` | no | function returning an ISO 8601 string |

### `AuditEvent` (input to `record()`)

```ts
type AuditEvent = {
  actor: AuditActor;                    // required — who performed the action
  action: string;                       // required — non-empty (e.g. "document.published")
  entity: AuditEntity;                  // required — which object was affected
  before?: unknown;                     // optional — state before the action
  after?: unknown;                      // optional — state after the action
  metadata?: Record<string, unknown>;   // optional — contextual data (IP, user-agent, etc.)
  timestamp?: string;                   // optional — ISO 8601; auto-generated if omitted
};

type AuditActor = {
  type: string;  // required — e.g. "user", "system", "admin", "cron", "api_key"
  id?: string;   // optional — e.g. "usr_123", "service_payment"
};

type AuditEntity = {
  type: string;  // required — e.g. "ticket", "invoice", "document"
  id: string;    // required — e.g. "TKT-1002", "inv_88492"
};
```

**Validation rules:**
- `actor` is required; `actor.type` must be a non-empty string; `actor.id` is optional.
- `action` must be a non-empty string.
- `entity` is required; both `entity.type` and `entity.id` must be non-empty strings.
- `timestamp`, if supplied, must be a valid ISO 8601 string (round-trips through `new Date().toISOString()`).
- `metadata` must be a plain object if provided.

### `QueryFilters` (input to `query()`)

```ts
type QueryFilters = {
  actor?: { id?: string; type?: string };
  action?: string;
  entity?: { type?: string; id?: string };
  dateRange?: { from?: string; to?: string }; // ISO 8601 strings, inclusive
  limit?: number;  // positive integer, default 50, max 1000
  offset?: number; // positive integer, omit to start from the beginning (default: 0)
};
```

All filter fields are optional and combined with AND semantics. Passing no filters returns
the most recent records up to `limit`. Results from the Postgres adapter are ordered by
`timestamp DESC`; the InMemory adapter preserves insertion order and applies offset + limit.

### `RecordResult` / `QueryResult`

```ts
type RecordResult = {
  success: boolean;
  recordId?: string;            // UUID v4, present on success
  timestamp?: string;           // ISO 8601, present on success
  error?: AuditError;           // present on failure
};

type QueryResult = {
  success: boolean;
  records?: readonly AuditRecord[]; // present on success
  total?: number;                   // total matching records before pagination, present on success
  error?: AuditError;               // present on failure
};
```

## Adapters

### InMemory — `createInMemoryAuditStore`

```ts
import { createInMemoryAuditStore } from './adapters/memory';

const store = createInMemoryAuditStore();
```

- Stores records in a private in-memory array. Data is lost when the process restarts.
- Suitable for development, testing, and demos. Not suitable for production.
- `append(record)` pushes a deep-cloned copy of the record — internal state cannot be mutated from outside.
- `query(filters)` filters in-memory with exact-match semantics and returns deep-cloned copies.
- No `close()` method.

### Postgres — `createPostgresAuditStore`

```ts
import { createPostgresAuditStore, AUDIT_LOG_DDL } from './adapters/postgres';

const store = createPostgresAuditStore({
  query: async (sql, params) => {
    // Wire up your Postgres client here (neon, pg pool, Supabase RPC, etc.)
    const result = await pool.query(sql, params);
    return { rows: result.rows, count: result.rowCount ?? undefined };
  },
  tableName: 'audit_logs', // optional; default: "audit_logs"
});
```

The Host provides a generic `query` executor — the adapter is decoupled from any specific
Postgres client library. Results are returned ordered by `timestamp DESC`.

**`AUDIT_LOG_DDL`** is a SQL string exported from `./adapters/postgres` that creates the
`audit_logs` table, performance indexes, and revokes `UPDATE` and `DELETE` from `PUBLIC`.
Run this once during DB provisioning:

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

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs (timestamp DESC);

REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
```

The `REVOKE` statement enforces append-only at the database layer — even a privileged
application user cannot update or delete rows via SQL.

### `PostgresAuditStoreOptions`

```ts
interface PostgresAuditStoreOptions {
  query: <T = unknown>(sql: string, params: unknown[]) => Promise<{ rows: T[]; count?: number }>;
  tableName?: string; // default: "audit_logs"
}
```

### Custom adapters

To use a different storage backend, implement the `AuditStore` interface:

```ts
interface AuditStore {
  append(record: AuditRecord): Promise<void>;
  query(filters: QueryFilters): Promise<{ records: AuditRecord[]; total: number }>;
  close?(): Promise<void>; // optional — called by audit.close()
}
```

## Redaction engine

Sensitive field redaction runs automatically on every `record()` call before data reaches
the store adapter. The caller's original objects are never mutated.

**Built-in sensitive fields (case-insensitive):**
`password`, `token`, `secret`, `authorization`, `apiKey` / `apikey`,
`creditCard` / `creditcard`, `ssn`, `privateKey` / `privatekey`

**Behavior:**
- Recursively traverses nested objects and arrays in `before`, `after`, and `metadata`.
- If an object key matches any sensitive field (case-insensitive): the value is replaced wholesale with the mask string (default `"[REDACTED]"`), regardless of whether the value is a primitive or a nested object.
- Non-sensitive keys are traversed recursively without modification.
- Primitives, `null`, non-plain objects (`Date`, `RegExp`), and functions pass through unchanged.
- Circular references are handled safely without stack overflow (tracked via `WeakSet`).
- Host extends the list via `redaction.customSensitiveFields` — merged with the built-in list, lowercased for matching.
- Host overrides the mask string via `redaction.mask`.

## Append-only guarantee

Audit history is strictly append-only and immutable:
- `AuditLogClient` exposes only `record()` and `query()` — there are no update or delete methods.
- `AuditStore` exposes only `append()` and `query()` — no mutation methods.
- The Postgres adapter's DDL revokes `UPDATE` and `DELETE` on the `audit_logs` table from `PUBLIC`.
- Stored records are deep-cloned snapshots — the Host cannot corrupt stored data by mutating domain objects after calling `record()`.

## Error codes

All errors surface as `AuditError`:

```ts
interface AuditError {
  code: AuditErrorCode;
  message: string;  // human-readable; MUST NOT contain secrets, credentials, or unredacted data
  cause?: unknown;  // internal only — never serialize to external callers
}
```

| Code | When it occurs | Delivery |
|---|---|---|
| `CONFIG_INVALID` | `createAuditLog` receives a malformed config: missing `store`, bad `mask` type, non-string field name in `customSensitiveFields`, non-function `getCurrentTimestamp` | **Thrown** at construction |
| `EVENT_INVALID` | `record()` receives a missing or malformed actor, action, entity, or invalid timestamp string | Returned in `RecordResult.error` |
| `REDACTION_FAILED` | Exception thrown during recursive redaction (e.g. unhandled custom property getter crash) | Returned in `RecordResult.error` |
| `STORE_FAILED` | `store.append()` throws during a `record()` call | Returned in `RecordResult.error` |
| `QUERY_FAILED` | Filter validation fails, or `store.query()` throws during a `query()` call | Returned in `QueryResult.error` |
| `PROVIDER_ERROR` | Unclassified adapter database or connection failure | Returned in result object `error` |

Error messages never contain secrets or unredacted data. `cause` holds the raw internal
error for debugging and must never be forwarded to external callers or logged at a level
visible to untrusted parties.

## Security

1. **Automatic secret redaction.** Every `record()` call redacts `before`, `after`, and
   `metadata` before any data reaches the store. Built-in field list covers the most common
   credential types; the Host extends it via `customSensitiveFields`.

2. **Immutable snapshots.** The Host's input objects are deep-cloned before storage. Mutating
   a domain object after calling `record()` cannot corrupt the audit trail.

3. **Append-only.** There are no update or delete API methods on `AuditLogClient` or
   `AuditStore`. The Postgres adapter revokes those permissions at the DB layer as a
   second line of defence.

4. **No env access.** The module never references `process.env`, `env`, or `globalThis`.
   All configuration enters through `createAuditLog(config)`. Safe to embed in any runtime
   (Cloudflare Workers, Node.js, Bun, Deno) without side-effect risks.

5. **No secret leak in errors.** `AuditError.message` must never contain credentials, PII,
   or internal state. `cause` is internal only and must not be serialized into HTTP responses.

6. **No `node:*` imports.** Uses only Web Crypto (`crypto.randomUUID()`) — no `node:crypto`,
   `node:fs`, or other Node.js built-ins. Runs unmodified on Cloudflare Workers.

7. **No Host input mutation.** `record()` never modifies the `AuditEvent` the Host passes in.

## How to integrate

### Steps

1. Copy the module folder into your repo.
2. **Postgres only:** run `AUDIT_LOG_DDL` against your database once to create the
   `audit_logs` table, indexes, and append-only permissions.
3. Import `createAuditLog` from `./core` and your chosen adapter from `./adapters/memory`
   or `./adapters/postgres`.
4. Construct the store adapter from your **own** env:
   ```ts
   // Development / testing:
   const store = createInMemoryAuditStore();

   // Production (Postgres):
   const store = createPostgresAuditStore({
     query: async (sql, params) => {
       const result = await pool.query(sql, params);
       return { rows: result.rows, count: result.rowCount ?? undefined };
     },
   });
   ```
5. Build an `AuditLogConfig` and call `createAuditLog`. Wrap in try/catch to handle
   `CONFIG_INVALID` at startup:
   ```ts
   const audit = createAuditLog({
     store,
     redaction: {
       customSensitiveFields: ['taxId', 'licenseNumber'],
     },
   });
   ```
6. Call `audit.record(event)` after each domain action you want to track.
7. Call `audit.query(filters)` to retrieve paginated audit history.
8. Always check `result.success` before accessing the payload.
9. Call `await audit.close?.()` on shutdown to release Postgres connections.

### Quick reference

```ts
// record an event
const result = await audit.record({
  actor: { id: 'usr_123', type: 'user' },
  action: 'invoice.approved',
  entity: { type: 'invoice', id: 'inv_88492' },
  before: { status: 'pending' },
  after: { status: 'approved' },
  metadata: { ip: '203.0.113.1' },
});
if (result.success) {
  console.log(result.recordId, result.timestamp);
} else {
  console.error(result.error?.code, result.error?.message);
}

// query by entity
const logs = await audit.query({
  entity: { type: 'invoice', id: 'inv_88492' },
  limit: 20,
});
if (logs.success) {
  console.log(logs.records, logs.total);
} else {
  console.error(logs.error?.code);
}

// query with date range and action filter
const recent = await audit.query({
  action: 'invoice.approved',
  dateRange: {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  },
});
```

See `integration.example.ts` for the full Cloudflare Worker example.

### Integration checklist

- [ ] Copy the module folder into the target repo
- [ ] Run `AUDIT_LOG_DDL` against your Postgres instance to create the table and indexes (Postgres adapter only)
- [ ] Construct the store adapter from your own env — the module never reads env itself
- [ ] Add domain-specific sensitive field names to `customSensitiveFields`
- [ ] Wrap `createAuditLog(config)` in try/catch at startup — `CONFIG_INVALID` means a misconfigured deploy
- [ ] Check `result.success` on every `record()` and `query()` call before accessing the payload
- [ ] Never forward `result.error?.cause` to external callers — it is internal state only
- [ ] Never serialize `AuditError.cause` in HTTP responses or external logs
- [ ] Call `await audit.close?.()` on Worker shutdown when using the Postgres adapter
- [ ] Run `npm run typecheck` before deploy

## Versioning

Standard semver — bump the version in `VERSION` on every change. No CHANGELOG or migration
guide until the module has been embedded in ≥ 2 real projects and the contract has stabilized.

## Promote to shared package when

The module has been embedded in ≥ 2–3 projects without changes to `core/` contract
(only adapter or config changes on the Host side) — then extract to an npm package.
