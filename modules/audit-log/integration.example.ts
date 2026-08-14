/**
 * modules/audit-log/integration.example.ts
 * Generic Cloudflare Worker Host Example — reference only when integrating into a real project.
 * Do NOT copy this file wholesale into production.
 *
 * The Audit Log module NEVER reads env itself. The Host reads its own env
 * (DB credentials, custom sensitive field names, etc.) and injects the adapter + config
 * via the public API. The module never touches process.env / env / globalThis.
 */

import { createAuditLog, type AuditLogConfig, type AuditEvent, type QueryFilters } from './core';
import { createInMemoryAuditStore } from './adapters/memory';
// Production swap: import { createPostgresAuditStore, AUDIT_LOG_DDL } from './adapters/postgres';

// Host declares its OWN env bindings — configured in wrangler.toml and wrangler secrets.
// The Audit Log module never reads these; the Host reads them and injects config.
interface Env {
  ENVIRONMENT: string;             // e.g. "development" | "production"
  AUDIT_SENSITIVE_MASK?: string;   // custom redaction mask (e.g. "[CONFIDENTIAL]"); default: "[REDACTED]"
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Host reads its OWN env and constructs the store adapter.
    //    For development/testing: use the in-memory adapter (data lost on restart).
    //    For production: swap to createPostgresAuditStore with your own query runner.
    const store = createInMemoryAuditStore();

    // Production swap (Postgres / Neon / Supabase):
    // const store = createPostgresAuditStore({
    //   query: async (sql, params) => {
    //     // pool is a pg.Pool, neon(), or similar — managed by the Host, not the module.
    //     const result = await pool.query(sql, params);
    //     return { rows: result.rows, count: result.rowCount ?? undefined };
    //   },
    //   tableName: 'audit_logs', // optional; default: "audit_logs"
    // });
    // Before first use, run AUDIT_LOG_DDL against the DB to create the table and indexes.

    // 2. Host builds AuditLogConfig and calls createAuditLog.
    //    createAuditLog validates the config at construction time and throws AuditError
    //    (code: CONFIG_INVALID) for any malformed field — catch this at startup, not per request.
    const config: AuditLogConfig = {
      store,
      redaction: {
        // Extend the built-in list with any domain-specific sensitive field names.
        // Built-in fields (always redacted): password, token, secret, authorization,
        // apiKey, creditCard, ssn, privateKey (all case-insensitive).
        customSensitiveFields: ['taxId', 'licenseNumber', 'internalToken'],
        mask: env.AUDIT_SENSITIVE_MASK ?? '[REDACTED]',
      },
    };

    const audit = createAuditLog(config);

    const url = new URL(request.url);

    // --- record ---
    // POST /audit/record
    // Records an audit event after a domain action. The module validates the event,
    // redacts sensitive fields in before/after/metadata, deep-clones an immutable snapshot,
    // and appends to the store. On any failure, record() returns { success: false, error }
    // — it does NOT throw.
    if (request.method === 'POST' && url.pathname === '/audit/record') {
      const body = await request.json() as {
        userId?: string;
        entityId?: string;
        action?: string;
      };

      const beforeState = {
        status: 'draft',
        internalToken: 'tok_abc123', // redacted — matches customSensitiveFields
      };

      const afterState = {
        status: 'published',
        internalToken: 'tok_abc123', // redacted
      };

      const event: AuditEvent = {
        actor: {
          id: body.userId ?? 'anonymous',
          type: 'user',
        },
        action: body.action ?? 'document.updated',
        entity: {
          type: 'document',
          id: body.entityId ?? 'unknown',
        },
        before: beforeState,
        after: afterState,
        metadata: {
          ip: request.headers.get('cf-connecting-ip') ?? '127.0.0.1',
          userAgent: request.headers.get('user-agent') ?? '',
          environment: env.ENVIRONMENT,
        },
      };

      const result = await audit.record(event);

      // Always check result.success before using the payload.
      if (!result.success) {
        const status = result.error?.code === 'EVENT_INVALID' ? 400 : 500;
        return Response.json(
          { error: result.error?.code, message: result.error?.message },
          { status },
        );
      }

      return Response.json({
        recordId: result.recordId,
        timestamp: result.timestamp,
      });
    }

    // --- query ---
    // GET /audit/query?entityId=doc_001&action=document.updated&limit=20
    // Queries paginated audit records. Filters are all optional and combined with AND.
    // query() returns { success: false, error } on failure — it does NOT throw.
    if (request.method === 'GET' && url.pathname === '/audit/query') {
      const entityId = url.searchParams.get('entityId');
      const action = url.searchParams.get('action');
      const limitRaw = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 50;

      const filters: QueryFilters = {
        limit,
      };

      if (entityId != null) {
        filters.entity = { type: 'document', id: entityId };
      }

      if (action != null) {
        filters.action = action;
      }

      const result = await audit.query(filters);

      // Always check result.success before using the payload.
      if (!result.success) {
        return Response.json({ error: result.error?.code }, { status: 500 });
      }

      return Response.json({
        records: result.records,
        total: result.total,
      });
    }

    return new Response('not found', { status: 404 });
  },
};
