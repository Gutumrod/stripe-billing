import type { AuditError, AuditEvent, QueryFilters } from './types';

type ValidationResult = { ok: true } | { ok: false; error: AuditError };

const MAX_LIMIT = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0;
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return new Date(timestamp).toISOString() === value;
}

function eventError(message: string): ValidationResult {
  return { ok: false, error: { code: 'EVENT_INVALID', message } };
}

function queryError(message: string): ValidationResult {
  return { ok: false, error: { code: 'QUERY_FAILED', message } };
}

export function validateEvent(event: AuditEvent): ValidationResult {
  if (!isRecord(event)) {
    return eventError('Invalid event: event must be an object');
  }

  if (!isRecord(event.actor)) {
    return eventError("Invalid event: missing required field 'actor'");
  }

  if (!isNonEmptyString(event.actor.type)) {
    return eventError("Invalid event: missing required field 'actor.type'");
  }

  if ('id' in event.actor && event.actor.id !== undefined && typeof event.actor.id !== 'string') {
    return eventError("Invalid event: field 'actor.id' must be a string");
  }

  if (!isNonEmptyString(event.action)) {
    return eventError("Invalid event: missing required field 'action'");
  }

  if (!isRecord(event.entity)) {
    return eventError("Invalid event: missing required field 'entity'");
  }

  if (!isNonEmptyString(event.entity.type)) {
    return eventError("Invalid event: missing required field 'entity.type'");
  }

  if (!isNonEmptyString(event.entity.id)) {
    return eventError("Invalid event: missing required field 'entity.id'");
  }

  if (event.timestamp !== undefined && !isValidIsoDate(event.timestamp)) {
    return eventError("Invalid event: field 'timestamp' must be a valid ISO 8601 string");
  }

  if (event.metadata !== undefined && !isRecord(event.metadata)) {
    return eventError("Invalid event: field 'metadata' must be an object");
  }

  return { ok: true };
}

export function validateFilters(filters: QueryFilters): ValidationResult {
  if (!isRecord(filters)) {
    return queryError('Invalid query filters: filters must be an object');
  }

  if (filters.limit !== undefined) {
    if (!isPositiveInteger(filters.limit)) {
      return queryError("Invalid query filters: field 'limit' must be a positive integer");
    }

    if (filters.limit > MAX_LIMIT) {
      return queryError("Invalid query filters: field 'limit' must be at most 1000");
    }
  }

  if (filters.offset !== undefined && !isPositiveInteger(filters.offset)) {
    return queryError("Invalid query filters: field 'offset' must be a positive integer");
  }

  if (filters.dateRange !== undefined) {
    if (!isRecord(filters.dateRange)) {
      return queryError("Invalid query filters: field 'dateRange' must be an object");
    }

    if (filters.dateRange.from !== undefined && !isValidIsoDate(filters.dateRange.from)) {
      return queryError("Invalid query filters: field 'dateRange.from' must be a valid ISO 8601 string");
    }

    if (filters.dateRange.to !== undefined && !isValidIsoDate(filters.dateRange.to)) {
      return queryError("Invalid query filters: field 'dateRange.to' must be a valid ISO 8601 string");
    }
  }

  return { ok: true };
}
