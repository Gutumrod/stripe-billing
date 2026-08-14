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

export interface AuditError {
  code: AuditErrorCode;
  message: string;
  cause?: unknown;
}

export type AuditErrorCode =
  | 'CONFIG_INVALID'
  | 'EVENT_INVALID'
  | 'REDACTION_FAILED'
  | 'STORE_FAILED'
  | 'QUERY_FAILED'
  | 'PROVIDER_ERROR';

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

export interface PostgresAuditStoreOptions {
  /** SQL query executor provided by Host (e.g. postgres pool, neon, or supabase rpc) */
  query: <T = unknown>(sql: string, params: unknown[]) => Promise<{ rows: T[]; count?: number }>;
  /** Table name in postgres (default: "audit_logs") */
  tableName?: string;
}

export interface AuditLogClient {
  record(event: AuditEvent): Promise<RecordResult>;
  query(filters: QueryFilters): Promise<QueryResult>;
  close?(): Promise<void>;
}
