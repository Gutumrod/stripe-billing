import { deepClone } from './clone';
import { redactObject } from './redact';
import type { AuditError, AuditEvent, AuditLogClient, AuditLogConfig, AuditRecord, QueryFilters, QueryResult, RecordResult } from './types';
import { validateEvent, validateFilters } from './validate';

function createError(code: AuditError['code'], message: string, cause?: unknown): AuditError {
  return cause === undefined ? { code, message } : { code, message, cause };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function assertValidConfig(config: AuditLogConfig): void {
  if (!isRecord(config)) {
    throw createError('CONFIG_INVALID', 'Invalid audit log config: config must be an object');
  }

  if (config.store === undefined || typeof config.store.append !== 'function' || typeof config.store.query !== 'function') {
    throw createError('CONFIG_INVALID', 'Invalid audit log config: missing store adapter');
  }

  if (config.redaction?.mask !== undefined && typeof config.redaction.mask !== 'string') {
    throw createError('CONFIG_INVALID', 'Invalid audit log config: redaction mask must be a string');
  }

  const customSensitiveFields = config.redaction?.customSensitiveFields;
  if (customSensitiveFields !== undefined) {
    if (!Array.isArray(customSensitiveFields)) {
      throw createError('CONFIG_INVALID', 'Invalid audit log config: custom sensitive fields must be an array');
    }

    for (const field of customSensitiveFields) {
      if (typeof field !== 'string' || field.trim().length === 0) {
        throw createError('CONFIG_INVALID', 'Invalid audit log config: custom sensitive field names must be non-empty strings');
      }
    }
  }

  if (config.getCurrentTimestamp !== undefined && typeof config.getCurrentTimestamp !== 'function') {
    throw createError('CONFIG_INVALID', 'Invalid audit log config: custom timestamp provider must be a function');
  }
}

function redactAndClone<T>(value: T, config: AuditLogConfig): T {
  return deepClone(redactObject(value, config.redaction)) as T;
}

function buildRecord(event: AuditEvent, config: AuditLogConfig): AuditRecord {
  const timestamp = event.timestamp ?? config.getCurrentTimestamp?.() ?? new Date().toISOString();
  const record: AuditRecord = {
    id: crypto.randomUUID(),
    actor: deepClone(event.actor),
    action: event.action,
    entity: deepClone(event.entity),
    timestamp,
  };

  if (event.before !== undefined) {
    record.before = redactAndClone(event.before, config);
  }

  if (event.after !== undefined) {
    record.after = redactAndClone(event.after, config);
  }

  if (event.metadata !== undefined) {
    record.metadata = redactAndClone(event.metadata, config);
  }

  return record;
}

export function createAuditLog(config: AuditLogConfig): AuditLogClient {
  assertValidConfig(config);

  return {
    async record(event: AuditEvent): Promise<RecordResult> {
      const validation = validateEvent(event);
      if (!validation.ok) {
        return { success: false, error: validation.error };
      }

      let record: AuditRecord;
      try {
        record = buildRecord(event, config);
      } catch (cause) {
        return {
          success: false,
          error: createError('REDACTION_FAILED', 'Failed to redact audit event safely', cause),
        };
      }

      try {
        await config.store.append(record);
        return { success: true, recordId: record.id, timestamp: record.timestamp };
      } catch (cause) {
        return {
          success: false,
          error: createError('STORE_FAILED', 'Failed to append audit record', cause),
        };
      }
    },

    async query(filters: QueryFilters): Promise<QueryResult> {
      const validation = validateFilters(filters);
      if (!validation.ok) {
        return { success: false, error: validation.error };
      }

      try {
        const result = await config.store.query(filters);
        return {
          success: true,
          records: result.records,
          total: result.total,
        };
      } catch (cause) {
        return {
          success: false,
          error: createError('QUERY_FAILED', 'Failed to query audit records', cause),
        };
      }
    },

    async close(): Promise<void> {
      await config.store.close?.();
    },
  };
}
