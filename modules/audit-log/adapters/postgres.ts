import type { AuditRecord, AuditStore, PostgresAuditStoreOptions, QueryFilters } from '../core/types';

export const AUDIT_LOG_DDL = `CREATE TABLE IF NOT EXISTS audit_logs (
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

REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

type AuditLogRow = {
  id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
  timestamp: string | Date;
  total_count?: string | number;
};

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Invalid SQL identifier');
  }

  return `"${identifier}"`;
}

function rowToRecord(row: AuditLogRow): AuditRecord {
  const record: AuditRecord = {
    id: row.id,
    actor: {
      type: row.actor_type,
    },
    action: row.action,
    entity: {
      type: row.entity_type,
      id: row.entity_id,
    },
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
  };

  if (row.actor_id !== null) {
    record.actor.id = row.actor_id;
  }

  if (row.before !== null) {
    record.before = row.before;
  }

  if (row.after !== null) {
    record.after = row.after;
  }

  if (row.metadata !== null) {
    record.metadata = row.metadata;
  }

  return record;
}

export function createPostgresAuditStore(options: PostgresAuditStoreOptions): AuditStore {
  const tableName = quoteIdentifier(options.tableName ?? 'audit_logs');

  return {
    async append(record: AuditRecord): Promise<void> {
      await options.query(
        `INSERT INTO ${tableName} (id, actor_id, actor_type, action, entity_type, entity_id, before, after, metadata, timestamp)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
        [
          record.id,
          record.actor.id ?? null,
          record.actor.type,
          record.action,
          record.entity.type,
          record.entity.id,
          record.before === undefined ? null : JSON.stringify(record.before),
          record.after === undefined ? null : JSON.stringify(record.after),
          record.metadata === undefined ? null : JSON.stringify(record.metadata),
          record.timestamp,
        ],
      );
    },

    async query(filters: QueryFilters): Promise<{ records: AuditRecord[]; total: number }> {
      const where: string[] = [];
      const params: unknown[] = [];

      function addCondition(sql: string, value: unknown): void {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      }

      if (filters.actor?.id !== undefined) {
        addCondition('actor_id = ?', filters.actor.id);
      }

      if (filters.actor?.type !== undefined) {
        addCondition('actor_type = ?', filters.actor.type);
      }

      if (filters.action !== undefined) {
        addCondition('action = ?', filters.action);
      }

      if (filters.entity?.type !== undefined) {
        addCondition('entity_type = ?', filters.entity.type);
      }

      if (filters.entity?.id !== undefined) {
        addCondition('entity_id = ?', filters.entity.id);
      }

      if (filters.dateRange?.from !== undefined) {
        addCondition('timestamp >= ?', filters.dateRange.from);
      }

      if (filters.dateRange?.to !== undefined) {
        addCondition('timestamp <= ?', filters.dateRange.to);
      }

      const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const offset = filters.offset ?? 0;
      params.push(limit, offset);

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const limitParam = `$${params.length - 1}`;
      const offsetParam = `$${params.length}`;
      const result = await options.query<AuditLogRow>(
        `SELECT id, actor_id, actor_type, action, entity_type, entity_id, before, after, metadata, timestamp, COUNT(*) OVER() AS total_count
FROM ${tableName}
${whereSql}
ORDER BY timestamp DESC
LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );

      const records = result.rows.map(rowToRecord);
      const totalFromRows = result.rows[0]?.total_count;
      const total = result.count ?? (typeof totalFromRows === 'string' ? Number.parseInt(totalFromRows, 10) : totalFromRows ?? 0);

      return { records, total };
    },
  };
}
