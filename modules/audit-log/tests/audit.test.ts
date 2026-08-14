import { describe, it, expect } from 'vitest';
import { createAuditLog } from '../core';
import type {
  AuditLogConfig,
  AuditEvent,
  AuditRecord,
  AuditStore,
  AuditError,
  AuditErrorCode,
  QueryFilters,
  RecordResult,
  QueryResult,
  PostgresAuditStoreOptions,
  RedactionConfig,
} from '../core';
import { redactObject } from '../core/redact';
import { deepClone } from '../core/clone';
import { createInMemoryAuditStore } from '../adapters/memory';
import { createPostgresAuditStore, AUDIT_LOG_DDL } from '../adapters/postgres';

// ---------------------------------------------------------------------------
// Helpers — fake stores & fixtures
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FakeStore = AuditStore & {
  appended: AuditRecord[];
  appendCalls: number;
  queryCalls: number;
};

function makeFakeStore(overrides: Partial<AuditStore> = {}): FakeStore {
  const store: FakeStore = {
    appended: [],
    appendCalls: 0,
    queryCalls: 0,
    async append(record: AuditRecord): Promise<void> {
      store.appendCalls++;
      store.appended.push(record);
    },
    async query(filters: QueryFilters): Promise<{ records: AuditRecord[]; total: number }> {
      store.queryCalls++;
      return { records: [...store.appended], total: store.appended.length };
    },
  };
  return Object.assign(store, overrides);
}

/** A fake store that records how many times append/query were called. */
function makeInstrumentedStore(appendImpl?: (r: AuditRecord) => Promise<void>): FakeStore {
  const store: FakeStore = {
    appended: [],
    appendCalls: 0,
    queryCalls: 0,
    async append(record: AuditRecord): Promise<void> {
      store.appendCalls++;
      store.appended.push(record);
      if (appendImpl) await appendImpl(record);
    },
    async query(filters: QueryFilters): Promise<{ records: AuditRecord[]; total: number }> {
      store.queryCalls++;
      return { records: [...store.appended], total: store.appended.length };
    },
  };
  return store;
}

function baseEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    actor: { id: 'usr_123', type: 'user' },
    action: 'status.changed',
    entity: { type: 'ticket', id: 'TKT-1002' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. createAuditLog — config validation
// ---------------------------------------------------------------------------

describe('createAuditLog — config validation', () => {
  it('throws CONFIG_INVALID when config is not an object', () => {
    expect(() => createAuditLog(null as unknown as AuditLogConfig)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('throws CONFIG_INVALID when store is missing', () => {
    expect(() => createAuditLog({} as AuditLogConfig)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('throws CONFIG_INVALID when store is missing append', () => {
    const store = { query: () => Promise.resolve({ records: [], total: 0 }) } as unknown as AuditStore;
    expect(() => createAuditLog({ store })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('throws CONFIG_INVALID when store is missing query', () => {
    const store = { append: () => Promise.resolve() } as unknown as AuditStore;
    expect(() => createAuditLog({ store })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('throws CONFIG_INVALID when redaction.mask is not a string', () => {
    const store = makeFakeStore();
    expect(() =>
      createAuditLog({ store, redaction: { mask: 123 as unknown as string } }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('throws CONFIG_INVALID when customSensitiveFields is not an array', () => {
    const store = makeFakeStore();
    expect(() =>
      createAuditLog({ store, redaction: { customSensitiveFields: 'password' as unknown as string[] } }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('throws CONFIG_INVALID when customSensitiveFields contains a non-string element', () => {
    const store = makeFakeStore();
    expect(() =>
      createAuditLog({ store, redaction: { customSensitiveFields: ['email', 42 as unknown as string] } }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('throws CONFIG_INVALID when customSensitiveFields contains an empty-string element', () => {
    const store = makeFakeStore();
    expect(() =>
      createAuditLog({ store, redaction: { customSensitiveFields: ['email', '  '] } }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('throws CONFIG_INVALID when getCurrentTimestamp is not a function', () => {
    const store = makeFakeStore();
    expect(() =>
      createAuditLog({ store, getCurrentTimestamp: '2026-01-01T00:00:00.000Z' as unknown as () => string }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('does NOT throw for a valid minimal config', () => {
    const store = makeFakeStore();
    expect(() => createAuditLog({ store })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. record — audit entry contract (happy path)
// ---------------------------------------------------------------------------

describe('record — audit entry contract (happy path)', () => {
  it('returns { success: true, recordId, timestamp }', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent());
    expect(result.success).toBe(true);
    expect(result.recordId).toBeDefined();
    expect(result.timestamp).toBeDefined();
  });

  it('recordId is a non-empty string matching UUID format', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent());
    expect(typeof result.recordId).toBe('string');
    expect(result.recordId!).toMatch(UUID_RE);
  });

  it('returned timestamp is the injected getCurrentTimestamp value when provided', async () => {
    const store = makeFakeStore();
    const fixed = '2026-08-10T07:00:00.000Z';
    const audit = createAuditLog({ store, getCurrentTimestamp: () => fixed });
    const result = await audit.record(baseEvent());
    expect(result.timestamp).toBe(fixed);
  });

  it('returned timestamp is a valid ISO 8601 string when derived from Date', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent());
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    expect(new Date(result.timestamp!).toISOString()).toBe(result.timestamp);
  });

  it('event.timestamp is honored when explicitly provided', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const ts = '2025-12-31T23:59:59.000Z';
    const result = await audit.record(baseEvent({ timestamp: ts }));
    expect(result.timestamp).toBe(ts);
  });

  it('stored record preserves actor.type and actor.id', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ actor: { id: 'usr_999', type: 'admin' } }));
    expect(store.appended[0].actor).toEqual({ id: 'usr_999', type: 'admin' });
  });

  it('stored record preserves action', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ action: 'user.created' }));
    expect(store.appended[0].action).toBe('user.created');
  });

  it('stored record preserves entity.type and entity.id', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ entity: { type: 'invoice', id: 'inv_88492' } }));
    expect(store.appended[0].entity).toEqual({ type: 'invoice', id: 'inv_88492' });
  });

  it('stored record preserves before', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const before = { status: 'draft', title: 'hello' };
    await audit.record(baseEvent({ before }));
    expect(store.appended[0].before).toEqual(before);
  });

  it('stored record preserves after', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const after = { status: 'published', title: 'hello' };
    await audit.record(baseEvent({ after }));
    expect(store.appended[0].after).toEqual(after);
  });

  it('stored record preserves metadata', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const metadata = { ip: '127.0.0.1', requestId: 'req_1' };
    await audit.record(baseEvent({ metadata }));
    expect(store.appended[0].metadata).toEqual(metadata);
  });

  it('record without before/after/metadata omits them (undefined)', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent());
    expect(store.appended[0].before).toBeUndefined();
    expect(store.appended[0].after).toBeUndefined();
    expect(store.appended[0].metadata).toBeUndefined();
  });

  it('actor.id is optional and works without it', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ actor: { type: 'system' } }));
    expect(result.success).toBe(true);
    expect(store.appended[0].actor).toEqual({ type: 'system' });
    expect(store.appended[0].actor.id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. record — validation failures (failure paths)
// ---------------------------------------------------------------------------

describe('record — validation failures', () => {
  it('returns EVENT_INVALID when event is not an object', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record('not-an-object' as unknown as AuditEvent);
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when actor is missing', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record({ action: 'x', entity: { type: 't', id: 'i' } } as unknown as AuditEvent);
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when actor is not an object', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ actor: 'user' as unknown as { type: string } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when actor.type is missing/empty', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ actor: { type: '' } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when actor.type is not a string', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ actor: { type: 123 as unknown as string } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when actor.id is a non-string', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ actor: { type: 'user', id: 456 as unknown as string } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when action is missing/empty', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ action: '' }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when action is not a string', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ action: 99 as unknown as string }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when entity is missing', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record({ actor: { type: 'user' }, action: 'x' } as unknown as AuditEvent);
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when entity.type is missing/empty', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ entity: { type: '', id: 'x' } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when entity.id is missing/empty', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ entity: { type: 't', id: '' } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when entity is not an object', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ entity: 'foo' as unknown as { type: string; id: string } }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when timestamp is not valid ISO', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ timestamp: '2026-08-10 07:00:00' }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when timestamp is a non-string', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ timestamp: 12345 as unknown as string }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('returns EVENT_INVALID when metadata is not an object', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent({ metadata: 'string' as unknown as Record<string, unknown> }));
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('does NOT call store.append on validation failure', async () => {
    const store = makeInstrumentedStore();
    const audit = createAuditLog({ store });
    await audit.record({ action: 'x' } as unknown as AuditEvent);
    expect(store.appendCalls).toBe(0);
    expect(store.appended.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. record — redaction (security paths)
// ---------------------------------------------------------------------------

describe('record — redaction', () => {
  it('redacts before.password with default mask [REDACTED]', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ before: { password: 'secret123', name: 'bob' } }));
    expect((store.appended[0].before as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((store.appended[0].before as Record<string, unknown>).name).toBe('bob');
  });

  it('redacts nested sensitive fields (after.user.apiKey)', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ after: { user: { apiKey: 'key_abc', name: 'alice' } } }));
    const after = store.appended[0].after as Record<string, unknown>;
    expect((after.user as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((after.user as Record<string, unknown>).name).toBe('alice');
  });

  it('honors custom mask when configured', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store, redaction: { mask: '[CONFIDENTIAL]' } });
    await audit.record(baseEvent({ before: { password: 'pw' } }));
    expect((store.appended[0].before as Record<string, unknown>).password).toBe('[CONFIDENTIAL]');
  });

  it('redacts customSensitiveFields (email, ipAddress)', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store, redaction: { customSensitiveFields: ['email', 'ipAddress'] } });
    await audit.record(baseEvent({ before: { email: 'a@b.com', ipAddress: '1.2.3.4', name: 'bob' } }));
    const before = store.appended[0].before as Record<string, unknown>;
    expect(before.email).toBe('[REDACTED]');
    expect(before.ipAddress).toBe('[REDACTED]');
    expect(before.name).toBe('bob');
  });

  it('redacts all built-in sensitive fields', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const before = {
      password: 'p',
      token: 't',
      secret: 's',
      authorization: 'a',
      apiKey: 'ak',
      apikey: 'ak2',
      creditCard: 'cc',
      creditcard: 'cc2',
      ssn: '123',
      privateKey: 'pk',
      privatekey: 'pk2',
    };
    await audit.record(baseEvent({ before }));
    const stored = store.appended[0].before as Record<string, unknown>;
    for (const key of Object.keys(before)) {
      expect(stored[key]).toBe('[REDACTED]');
    }
  });

  it('redaction is case-insensitive (Password, TOKEN, ApiKey)', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ before: { Password: 'p', TOKEN: 't', ApiKey: 'ak' } }));
    const stored = store.appended[0].before as Record<string, unknown>;
    expect(stored.Password).toBe('[REDACTED]');
    expect(stored.TOKEN).toBe('[REDACTED]');
    expect(stored.ApiKey).toBe('[REDACTED]');
  });

  it('redacts sensitive values inside arrays', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ before: [{ password: 'p' }, { name: 'ok' }] }));
    const arr = store.appended[0].before as Record<string, unknown>[];
    expect(arr[0].password).toBe('[REDACTED]');
    expect(arr[1].name).toBe('ok');
  });

  it('preserves non-sensitive fields unchanged', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ before: { name: 'bob', count: 5, active: true, nested: { x: 1 } } }));
    const stored = store.appended[0].before as Record<string, unknown>;
    expect(stored.name).toBe('bob');
    expect(stored.count).toBe(5);
    expect(stored.active).toBe(true);
    expect((stored.nested as Record<string, unknown>).x).toBe(1);
  });

  it('applies redaction to before, after, AND metadata', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(
      baseEvent({
        before: { password: 'p' },
        after: { password: 'p2' },
        metadata: { password: 'pm' },
      }),
    );
    expect((store.appended[0].before as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((store.appended[0].after as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((store.appended[0].metadata as Record<string, unknown>).password).toBe('[REDACTED]');
  });

  it('does NOT mutate the original event object', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const before = { password: 'p', name: 'bob' };
    const event = baseEvent({ before });
    await audit.record(event);
    expect(before.password).toBe('p');
    expect(before.name).toBe('bob');
  });

  it('redacted value is a deep clone — mutating returned record does not affect original event', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const before = { password: 'p', nested: { x: 1 } };
    await audit.record(baseEvent({ before }));
    const storedBefore = store.appended[0].before as Record<string, unknown>;
    (storedBefore.nested as Record<string, unknown>).x = 999;
    expect(before.nested.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. record — store failures & error codes
// ---------------------------------------------------------------------------

describe('record — store failures & error codes', () => {
  it('returns STORE_FAILED when store.append throws', async () => {
    const store = makeFakeStore({
      append: () => Promise.reject(new Error('connection lost')),
    });
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent());
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('STORE_FAILED');
  });

  it('STORE_FAILED error preserves cause', async () => {
    const cause = new Error('db down');
    const store = makeFakeStore({ append: () => Promise.reject(cause) });
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent());
    expect(result.error!.cause).toBe(cause);
  });

  it('returns REDACTION_FAILED when redaction throws', async () => {
    // An object with a getter that throws will cause redactObject to throw
    // when it tries to read the property value during traversal.
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const before = {};
    Object.defineProperty(before, 'password', {
      get() {
        throw new Error('getter explosion');
      },
      enumerable: true,
    });
    const result = await audit.record(baseEvent({ before }));
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('REDACTION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// 6. query — happy paths
// ---------------------------------------------------------------------------

describe('query — happy paths', () => {
  it('returns all records with no filters', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ action: 'a1' }));
    await audit.record(baseEvent({ action: 'a2' }));
    const result = await audit.query({});
    expect(result.success).toBe(true);
    expect(result.records!.length).toBe(2);
  });

  it('returns total count', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent());
    await audit.record(baseEvent());
    await audit.record(baseEvent());
    const result = await audit.query({});
    expect(result.total).toBe(3);
  });

  it('returned records match recorded entries', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ action: 'created' }));
    const result = await audit.query({});
    expect(result.records![0].action).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// 7. query — filter matching
// ---------------------------------------------------------------------------

describe('query — filter matching', () => {
  it('filters by actor.id', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ actor: { id: 'usr_1', type: 'user' } }));
    await audit.record(baseEvent({ actor: { id: 'usr_2', type: 'user' } }));
    const result = await audit.query({ actor: { id: 'usr_1' } });
    expect(result.records!.length).toBe(1);
    expect(result.records![0].actor.id).toBe('usr_1');
  });

  it('filters by actor.type', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ actor: { type: 'user' } }));
    await audit.record(baseEvent({ actor: { type: 'admin' } }));
    const result = await audit.query({ actor: { type: 'admin' } });
    expect(result.records!.length).toBe(1);
    expect(result.records![0].actor.type).toBe('admin');
  });

  it('filters by action', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ action: 'created' }));
    await audit.record(baseEvent({ action: 'deleted' }));
    const result = await audit.query({ action: 'deleted' });
    expect(result.records!.length).toBe(1);
    expect(result.records![0].action).toBe('deleted');
  });

  it('filters by entity.type', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ entity: { type: 'ticket', id: 'T1' } }));
    await audit.record(baseEvent({ entity: { type: 'invoice', id: 'I1' } }));
    const result = await audit.query({ entity: { type: 'invoice' } });
    expect(result.records!.length).toBe(1);
    expect(result.records![0].entity.type).toBe('invoice');
  });

  it('filters by entity.id', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ entity: { type: 't', id: 'E1' } }));
    await audit.record(baseEvent({ entity: { type: 't', id: 'E2' } }));
    const result = await audit.query({ entity: { id: 'E2' } });
    expect(result.records!.length).toBe(1);
    expect(result.records![0].entity.id).toBe('E2');
  });

  it('filters by dateRange.from (inclusive boundary)', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ timestamp: '2026-01-01T00:00:00.000Z' }));
    await audit.record(baseEvent({ timestamp: '2026-06-01T00:00:00.000Z' }));
    await audit.record(baseEvent({ timestamp: '2026-12-01T00:00:00.000Z' }));
    const result = await audit.query({ dateRange: { from: '2026-06-01T00:00:00.000Z' } });
    expect(result.records!.length).toBe(2);
  });

  it('filters by dateRange.to (inclusive boundary)', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ timestamp: '2026-01-01T00:00:00.000Z' }));
    await audit.record(baseEvent({ timestamp: '2026-06-01T00:00:00.000Z' }));
    await audit.record(baseEvent({ timestamp: '2026-12-01T00:00:00.000Z' }));
    const result = await audit.query({ dateRange: { to: '2026-06-01T00:00:00.000Z' } });
    expect(result.records!.length).toBe(2);
  });

  it('combines multiple filters with AND behavior', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    await audit.record(baseEvent({ actor: { id: 'u1', type: 'user' }, action: 'created', entity: { type: 'doc', id: 'd1' } }));
    await audit.record(baseEvent({ actor: { id: 'u1', type: 'user' }, action: 'deleted', entity: { type: 'doc', id: 'd1' } }));
    await audit.record(baseEvent({ actor: { id: 'u2', type: 'user' }, action: 'created', entity: { type: 'doc', id: 'd1' } }));
    const result = await audit.query({ actor: { id: 'u1' }, action: 'created' });
    expect(result.records!.length).toBe(1);
    expect(result.records![0].actor.id).toBe('u1');
    expect(result.records![0].action).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// 8. query — pagination
// ---------------------------------------------------------------------------

describe('query — pagination', () => {
  it('default limit caps results at 50', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    for (let i = 0; i < 55; i++) {
      await audit.record(baseEvent({ action: `a_${i}` }));
    }
    const result = await audit.query({});
    expect(result.records!.length).toBe(50);
  });

  it('honors limit when fewer than 50', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    for (let i = 0; i < 10; i++) {
      await audit.record(baseEvent({ action: `a_${i}` }));
    }
    const result = await audit.query({ limit: 5 });
    expect(result.records!.length).toBe(5);
  });

  it('offset pagination works', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    for (let i = 0; i < 10; i++) {
      await audit.record(baseEvent({ action: `a_${i}` }));
    }
    const page1 = await audit.query({ limit: 5 });
    const page2 = await audit.query({ limit: 5, offset: 5 });
    expect(page1.records!.length).toBe(5);
    expect(page2.records!.length).toBe(5);
    const page1Actions = page1.records!.map((r) => r.action);
    const page2Actions = page2.records!.map((r) => r.action);
    expect(page1Actions).not.toEqual(page2Actions);
  });

  it('clamps limit to MAX_LIMIT 1000', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    // The validator rejects limit > 1000, but limit === 1000 should pass
    const result = await audit.query({ limit: 1000 });
    expect(result.success).toBe(true);
  });

  it('total reflects ALL matches regardless of limit', async () => {
    const store = createInMemoryAuditStore();
    const audit = createAuditLog({ store });
    for (let i = 0; i < 15; i++) {
      await audit.record(baseEvent());
    }
    const result = await audit.query({ limit: 5 });
    expect(result.records!.length).toBe(5);
    expect(result.total).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 9. query — validation failures
// ---------------------------------------------------------------------------

describe('query — validation failures', () => {
  it('returns QUERY_FAILED when filters is not an object', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query('bad' as unknown as QueryFilters);
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when limit is not a positive integer', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ limit: 'ten' as unknown as number });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when limit is 0', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ limit: 0 });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when limit is negative', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ limit: -5 });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when limit is a float', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ limit: 5.5 });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when limit > 1000', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ limit: 1001 });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when offset is not a positive integer', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ offset: -1 });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when dateRange.from is invalid ISO', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ dateRange: { from: 'not-a-date' } });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('returns QUERY_FAILED when dateRange.to is invalid ISO', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ dateRange: { to: '2026-13-99' } });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('does NOT call store.query on invalid filters', async () => {
    const store = makeInstrumentedStore();
    const audit = createAuditLog({ store });
    await audit.query({ limit: -1 });
    expect(store.queryCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. query — store failure
// ---------------------------------------------------------------------------

describe('query — store failure', () => {
  it('returns QUERY_FAILED when store.query throws', async () => {
    const store = makeFakeStore({
      query: () => Promise.reject(new Error('db unreachable')),
    });
    const audit = createAuditLog({ store });
    const result = await audit.query({});
    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('QUERY_FAILED preserves cause', async () => {
    const cause = new Error('connection timeout');
    const store = makeFakeStore({ query: () => Promise.reject(cause) });
    const audit = createAuditLog({ store });
    const result = await audit.query({});
    expect(result.error!.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// 11. close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('calls store.close when present', async () => {
    let closed = false;
    const store = makeFakeStore({ close: async () => { closed = true; } });
    const audit = createAuditLog({ store });
    await audit.close!();
    expect(closed).toBe(true);
  });

  it('works when store has no close (undefined)', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    await expect(audit.close!()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. redactObject (core/redact.ts) — direct engine tests
// ---------------------------------------------------------------------------

describe('redactObject', () => {
  it('redacts password', () => {
    const result = redactObject({ password: 'p', name: 'bob' });
    expect((result as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((result as Record<string, unknown>).name).toBe('bob');
  });

  it('redacts nested fields', () => {
    const result = redactObject({ a: { b: { password: 'p' } } });
    const nested = (result as Record<string, unknown>).a as Record<string, unknown>;
    const inner = nested.b as Record<string, unknown>;
    expect(inner.password).toBe('[REDACTED]');
  });

  it('redacts within arrays', () => {
    const result = redactObject([{ password: 'p' }, { x: 1 }]);
    const arr = result as Record<string, unknown>[];
    expect(arr[0].password).toBe('[REDACTED]');
    expect(arr[1].x).toBe(1);
  });

  it('uses custom mask', () => {
    const result = redactObject({ password: 'p' }, { mask: '***' });
    expect((result as Record<string, unknown>).password).toBe('***');
  });

  it('uses custom sensitive fields', () => {
    const result = redactObject({ email: 'a@b.com', name: 'x' }, { customSensitiveFields: ['email'] });
    expect((result as Record<string, unknown>).email).toBe('[REDACTED]');
    expect((result as Record<string, unknown>).name).toBe('x');
  });

  it('matches case-insensitively', () => {
    const result = redactObject({ PASSWORD: 'p', Token: 't' });
    expect((result as Record<string, unknown>).PASSWORD).toBe('[REDACTED]');
    expect((result as Record<string, unknown>).Token).toBe('[REDACTED]');
  });

  it('does not mutate input', () => {
    const input = { password: 'p', name: 'bob' };
    redactObject(input);
    expect(input.password).toBe('p');
    expect(input.name).toBe('bob');
  });

  it('handles Date, RegExp, Map, Set without throwing', () => {
    const date = new Date();
    const re = /abc/;
    const map = new Map([['key', 'val']]);
    const set = new Set([1, 2, 3]);
    expect(() => redactObject({ date, re, map, set })).not.toThrow();
    const result = redactObject({ date, re, map, set }) as Record<string, unknown>;
    // Non-plain objects pass through as-is
    expect(result.date).toBe(date);
    expect(result.re).toBe(re);
    expect(result.map).toBe(map);
    expect(result.set).toBe(set);
  });

  it('returns a deep copy (not the same reference) for plain objects', () => {
    const input = { a: { b: 1 } };
    const result = redactObject(input);
    expect(result).not.toBe(input);
    expect((result as Record<string, unknown>).a).not.toBe(input.a);
  });

  it('passes through null, undefined, and primitives', () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject(42)).toBe(42);
    expect(redactObject('hello')).toBe('hello');
    expect(redactObject(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. deepClone (core/clone.ts)
// ---------------------------------------------------------------------------

describe('deepClone', () => {
  it('deep clones nested objects', () => {
    const input = { a: { b: { c: 1 } } };
    const clone = deepClone(input);
    expect(clone).toEqual(input);
    expect(clone).not.toBe(input);
    expect(clone.a).not.toBe(input.a);
    expect(clone.a.b).not.toBe(input.a.b);
  });

  it('clones arrays', () => {
    const input = { arr: [1, { x: 2 }, [3]] };
    const clone = deepClone(input);
    expect(clone).toEqual(input);
    expect(clone.arr).not.toBe(input.arr);
    expect((clone.arr as unknown[])[1]).not.toBe(input.arr[1]);
  });

  it('handles circular references without infinite loop', () => {
    const input: Record<string, unknown> = { name: 'root' };
    input.self = input;
    const clone = deepClone(input);
    expect(clone).not.toBe(input);
    expect(clone.self).toBe(clone);
  });

  it('clones Date, RegExp, Map, Set', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const re = /abc/gi;
    const map = new Map([['k', 'v']]);
    const set = new Set([1, 2]);
    const input = { date, re, map, set };
    const clone = deepClone(input);
    expect(clone.date).not.toBe(date);
    expect(clone.date.getTime()).toBe(date.getTime());
    expect(clone.re).not.toBe(re);
    expect(clone.re.source).toBe(re.source);
    expect(clone.re.flags).toBe(re.flags);
    expect(clone.map).not.toBe(map);
    expect(clone.map.get('k')).toBe('v');
    expect(clone.set).not.toBe(set);
    expect([...clone.set]).toEqual([...set]);
  });

  it('returns primitives as-is', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('str')).toBe('str');
    expect(deepClone(null)).toBeNull();
    expect(deepClone(undefined)).toBeUndefined();
    expect(deepClone(true)).toBe(true);
  });

  it('cloned output does not share reference with input', () => {
    const input = { nested: { x: 1 } };
    const clone = deepClone(input);
    (clone.nested as Record<string, unknown>).x = 999;
    expect(input.nested.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. createInMemoryAuditStore (adapters/memory.ts)
// ---------------------------------------------------------------------------

describe('createInMemoryAuditStore', () => {
  it('append then query returns the record', async () => {
    const store = createInMemoryAuditStore();
    const record: AuditRecord = {
      id: 'r1',
      actor: { type: 'user', id: 'u1' },
      action: 'created',
      entity: { type: 'doc', id: 'd1' },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    await store.append(record);
    const result = await store.query({});
    expect(result.records.length).toBe(1);
    expect(result.records[0].id).toBe('r1');
  });

  it('append clones — mutating record passed to append does not change stored data', async () => {
    const store = createInMemoryAuditStore();
    const record: AuditRecord = {
      id: 'r1',
      actor: { type: 'user', id: 'u1' },
      action: 'created',
      entity: { type: 'doc', id: 'd1' },
      timestamp: '2026-01-01T00:00:00.000Z',
      before: { status: 'draft' },
    };
    await store.append(record);
    (record.before as Record<string, unknown>).status = 'CHANGED';
    const result = await store.query({});
    expect((result.records[0].before as Record<string, unknown>).status).toBe('draft');
  });

  it('query filters by actor/entity/action', async () => {
    const store = createInMemoryAuditStore();
    await store.append({ id: '1', actor: { type: 'user', id: 'u1' }, action: 'create', entity: { type: 'doc', id: 'd1' }, timestamp: '2026-01-01T00:00:00.000Z' });
    await store.append({ id: '2', actor: { type: 'admin', id: 'u2' }, action: 'delete', entity: { type: 'doc', id: 'd2' }, timestamp: '2026-01-01T00:00:00.000Z' });
    await store.append({ id: '3', actor: { type: 'user', id: 'u1' }, action: 'update', entity: { type: 'doc', id: 'd1' }, timestamp: '2026-01-01T00:00:00.000Z' });

    const byActor = await store.query({ actor: { id: 'u1' } });
    expect(byActor.records.length).toBe(2);

    const byAction = await store.query({ action: 'delete' });
    expect(byAction.records.length).toBe(1);

    const byEntity = await store.query({ entity: { type: 'doc', id: 'd2' } });
    expect(byEntity.records.length).toBe(1);
  });

  it('query date range filtering', async () => {
    const store = createInMemoryAuditStore();
    await store.append({ id: '1', actor: { type: 'u' }, action: 'a', entity: { type: 't', id: 'i' }, timestamp: '2026-01-01T00:00:00.000Z' });
    await store.append({ id: '2', actor: { type: 'u' }, action: 'a', entity: { type: 't', id: 'i' }, timestamp: '2026-06-01T00:00:00.000Z' });
    await store.append({ id: '3', actor: { type: 'u' }, action: 'a', entity: { type: 't', id: 'i' }, timestamp: '2026-12-01T00:00:00.000Z' });

    const mid = await store.query({ dateRange: { from: '2026-03-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' } });
    expect(mid.records.length).toBe(1);
    expect(mid.records[0].id).toBe('2');
  });

  it('pagination default limit & offset', async () => {
    const store = createInMemoryAuditStore();
    for (let i = 0; i < 55; i++) {
      await store.append({ id: `${i}`, actor: { type: 'u' }, action: 'a', entity: { type: 't', id: 'i' }, timestamp: '2026-01-01T00:00:00.000Z' });
    }
    const defaultPage = await store.query({});
    expect(defaultPage.records.length).toBe(50);
    expect(defaultPage.total).toBe(55);

    const offsetPage = await store.query({ limit: 10, offset: 50 });
    expect(offsetPage.records.length).toBe(5);
    expect(offsetPage.total).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// 15. createPostgresAuditStore (adapters/postgres.ts) — fake query executor
// ---------------------------------------------------------------------------

describe('createPostgresAuditStore', () => {
  function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      id: 'uuid-1',
      actor: { type: 'user', id: 'usr_1' },
      action: 'created',
      entity: { type: 'doc', id: 'd1' },
      timestamp: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('append builds correct INSERT with all fields and params $1..$10', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const fakeQuery = async <T = unknown>(sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    await store.append(makeRecord({ before: { x: 1 }, after: { y: 2 }, metadata: { z: 3 } }));
    expect(capturedSql).toContain('INSERT INTO "audit_logs"');
    expect(capturedSql).toContain('$1');
    expect(capturedSql).toContain('$10');
    expect(capturedParams.length).toBe(10);
    expect(capturedParams[0]).toBe('uuid-1');
    expect(capturedParams[1]).toBe('usr_1');
    expect(capturedParams[2]).toBe('user');
    expect(capturedParams[3]).toBe('created');
    expect(capturedParams[4]).toBe('doc');
    expect(capturedParams[5]).toBe('d1');
  });

  it('append passes null for missing optional fields (before/after/metadata/actor.id)', async () => {
    let capturedParams: unknown[] = [];
    const fakeQuery = async <T = unknown>(sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    await store.append(makeRecord({ actor: { type: 'system' } }));
    expect(capturedParams[1]).toBeNull(); // actor.id
    expect(capturedParams[6]).toBeNull(); // before
    expect(capturedParams[7]).toBeNull(); // after
    expect(capturedParams[8]).toBeNull(); // metadata
  });

  it('append passes JSON.stringify for before/after/metadata', async () => {
    let capturedParams: unknown[] = [];
    const fakeQuery = async <T = unknown>(sql: string, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    await store.append(makeRecord({ before: { x: 1 }, after: { y: 2 }, metadata: { z: 3 } }));
    expect(capturedParams[6]).toBe(JSON.stringify({ x: 1 }));
    expect(capturedParams[7]).toBe(JSON.stringify({ y: 2 }));
    expect(capturedParams[8]).toBe(JSON.stringify({ z: 3 }));
  });

  it('query builds correct SQL with LIMIT/OFFSET', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const fakeQuery = async <T = unknown>(sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    await store.query({ limit: 10, offset: 20 });
    expect(capturedSql).toContain('LIMIT');
    expect(capturedSql).toContain('OFFSET');
    expect(capturedParams).toContain(10);
    expect(capturedParams).toContain(20);
  });

  it('query builds WHERE with conditions for each filter and correct $n params', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const fakeQuery = async <T = unknown>(sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    await store.query({
      actor: { id: 'u1', type: 'admin' },
      action: 'created',
      entity: { type: 'doc', id: 'd1' },
      dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.000Z' },
      limit: 50,
      offset: 0,
    });
    expect(capturedSql).toContain('WHERE');
    expect(capturedSql).toContain('actor_id = $1');
    expect(capturedSql).toContain('actor_type = $2');
    expect(capturedSql).toContain('action = $3');
    expect(capturedSql).toContain('entity_type = $4');
    expect(capturedSql).toContain('entity_id = $5');
    expect(capturedSql).toContain('timestamp >= $6');
    expect(capturedSql).toContain('timestamp <= $7');
    // limit=50 → $8, offset=0 → $9
    expect(capturedParams[0]).toBe('u1');
    expect(capturedParams[1]).toBe('admin');
    expect(capturedParams[2]).toBe('created');
    expect(capturedParams[3]).toBe('doc');
    expect(capturedParams[4]).toBe('d1');
    expect(capturedParams[5]).toBe('2026-01-01T00:00:00.000Z');
    expect(capturedParams[6]).toBe('2026-12-31T23:59:59.000Z');
    expect(capturedParams[7]).toBe(50);
    expect(capturedParams[8]).toBe(0);
  });

  it('query maps rows back to AuditRecord (rowToRecord)', async () => {
    const fakeRow = {
      id: 'rec-1',
      actor_id: 'usr_1',
      actor_type: 'user',
      action: 'created',
      entity_type: 'doc',
      entity_id: 'd1',
      before: { x: 1 },
      after: { y: 2 },
      metadata: { z: 3 },
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      total_count: '1',
    };
    const fakeQuery = async <T = unknown>() => {
      return { rows: [fakeRow] as unknown as T[], count: undefined };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    const result = await store.query({});
    expect(result.records.length).toBe(1);
    const r = result.records[0];
    expect(r.id).toBe('rec-1');
    expect(r.actor.type).toBe('user');
    expect(r.actor.id).toBe('usr_1');
    expect(r.action).toBe('created');
    expect(r.entity.type).toBe('doc');
    expect(r.entity.id).toBe('d1');
    expect(r.before).toEqual({ x: 1 });
    expect(r.after).toEqual({ y: 2 });
    expect(r.metadata).toEqual({ z: 3 });
    expect(r.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('query handles null before/after/metadata/actor_id (fields omitted)', async () => {
    const fakeRow = {
      id: 'rec-2',
      actor_id: null,
      actor_type: 'system',
      action: 'created',
      entity_type: 'doc',
      entity_id: 'd2',
      before: null,
      after: null,
      metadata: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      total_count: '1',
    };
    const fakeQuery = async <T = unknown>() => {
      return { rows: [fakeRow] as unknown as T[], count: undefined };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    const result = await store.query({});
    const r = result.records[0];
    expect(r.actor.id).toBeUndefined();
    expect(r.before).toBeUndefined();
    expect(r.after).toBeUndefined();
    expect(r.metadata).toBeUndefined();
  });

  it('query computes total from result.count', async () => {
    const fakeQuery = async <T = unknown>() => {
      return { rows: [] as unknown as T[], count: 42 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    const result = await store.query({});
    expect(result.total).toBe(42);
  });

  it('query computes total from total_count column when count is undefined', async () => {
    const fakeRow = {
      id: 'rec-3',
      actor_id: null,
      actor_type: 'u',
      action: 'a',
      entity_type: 't',
      entity_id: 'i',
      before: null,
      after: null,
      metadata: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      total_count: '7',
    };
    const fakeQuery = async <T = unknown>() => {
      return { rows: [fakeRow] as unknown as T[], count: undefined };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    const result = await store.query({});
    expect(result.total).toBe(7);
  });

  it('tableName option honored (default "audit_logs")', async () => {
    let capturedSql = '';
    const fakeQuery = async <T = unknown>(sql: string) => {
      capturedSql = sql;
      return { rows: [] as unknown as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery });
    await store.append(makeRecord());
    expect(capturedSql).toContain('"audit_logs"');
  });

  it('tableName option honored (custom table quoted)', async () => {
    let capturedSql = '';
    const fakeQuery = async <T = unknown>(sql: string) => {
      capturedSql = sql;
      return { rows: [] as unknown as T[], count: 0 };
    };
    const store = createPostgresAuditStore({ query: fakeQuery, tableName: 'custom_audit' });
    await store.append(makeRecord());
    expect(capturedSql).toContain('"custom_audit"');
  });

  it('quoteIdentifier rejects invalid SQL identifiers (space)', () => {
    expect(() => createPostgresAuditStore({ query: async () => ({ rows: [], count: 0 }), tableName: 'bad table' })).toThrowError(
      'Invalid SQL identifier',
    );
  });

  it('quoteIdentifier rejects invalid SQL identifiers (semicolon)', () => {
    expect(() => createPostgresAuditStore({ query: async () => ({ rows: [], count: 0 }), tableName: 'bad;table' })).toThrowError(
      'Invalid SQL identifier',
    );
  });

  it('AUDIT_LOG_DDL contains CREATE TABLE IF NOT EXISTS audit_logs', () => {
    expect(AUDIT_LOG_DDL).toContain('CREATE TABLE IF NOT EXISTS audit_logs');
  });

  it('AUDIT_LOG_DDL contains REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC', () => {
    expect(AUDIT_LOG_DDL).toContain('REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC');
  });

  it('AUDIT_LOG_DDL contains index definitions', () => {
    expect(AUDIT_LOG_DDL).toContain('CREATE INDEX IF NOT EXISTS idx_audit_logs_entity');
    expect(AUDIT_LOG_DDL).toContain('CREATE INDEX IF NOT EXISTS idx_audit_logs_actor');
    expect(AUDIT_LOG_DDL).toContain('CREATE INDEX IF NOT EXISTS idx_audit_logs_action');
    expect(AUDIT_LOG_DDL).toContain('CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp');
  });
});

// ---------------------------------------------------------------------------
// 16. Structured error codes (AuditErrorCode)
// ---------------------------------------------------------------------------

describe('Structured error codes (AuditErrorCode)', () => {
  it('surfaces CONFIG_INVALID at construction', () => {
    let code: string | undefined;
    try {
      createAuditLog({} as AuditLogConfig);
    } catch (e) {
      code = (e as AuditError).code;
    }
    expect(code).toBe('CONFIG_INVALID');
  });

  it('surfaces EVENT_INVALID on bad event', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.record({} as AuditEvent);
    expect(result.error!.code).toBe('EVENT_INVALID');
  });

  it('surfaces REDACTION_FAILED when redaction throws', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const before: Record<string, unknown> = {};
    Object.defineProperty(before, 'password', {
      get() { throw new Error('boom'); },
      enumerable: true,
    });
    const result = await audit.record(baseEvent({ before }));
    expect(result.error!.code).toBe('REDACTION_FAILED');
  });

  it('surfaces STORE_FAILED when store.append throws', async () => {
    const store = makeFakeStore({ append: () => Promise.reject(new Error('x')) });
    const audit = createAuditLog({ store });
    const result = await audit.record(baseEvent());
    expect(result.error!.code).toBe('STORE_FAILED');
  });

  it('surfaces QUERY_FAILED when store.query throws', async () => {
    const store = makeFakeStore({ query: () => Promise.reject(new Error('x')) });
    const audit = createAuditLog({ store });
    const result = await audit.query({});
    expect(result.error!.code).toBe('QUERY_FAILED');
  });

  it('surfaces QUERY_FAILED on invalid filters', async () => {
    const store = makeFakeStore();
    const audit = createAuditLog({ store });
    const result = await audit.query({ limit: -1 });
    expect(result.error!.code).toBe('QUERY_FAILED');
  });
});