import { deepClone } from '../core/clone';
import type { AuditRecord, AuditStore, QueryFilters } from '../core/types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

function matchesFilters(record: AuditRecord, filters: QueryFilters): boolean {
  if (filters.actor?.id !== undefined && record.actor.id !== filters.actor.id) {
    return false;
  }

  if (filters.actor?.type !== undefined && record.actor.type !== filters.actor.type) {
    return false;
  }

  if (filters.action !== undefined && record.action !== filters.action) {
    return false;
  }

  if (filters.entity?.type !== undefined && record.entity.type !== filters.entity.type) {
    return false;
  }

  if (filters.entity?.id !== undefined && record.entity.id !== filters.entity.id) {
    return false;
  }

  if (filters.dateRange?.from !== undefined && record.timestamp < filters.dateRange.from) {
    return false;
  }

  if (filters.dateRange?.to !== undefined && record.timestamp > filters.dateRange.to) {
    return false;
  }

  return true;
}

export function createInMemoryAuditStore(): AuditStore {
  const records: AuditRecord[] = [];

  return {
    async append(record: AuditRecord): Promise<void> {
      records.push(deepClone(record));
    },

    async query(filters: QueryFilters): Promise<{ records: AuditRecord[]; total: number }> {
      const offset = filters.offset ?? 0;
      const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const matched = records.filter((record) => matchesFilters(record, filters));
      const page = matched.slice(offset, offset + limit);

      return {
        records: deepClone(page),
        total: matched.length,
      };
    },
  };
}
