import { failureResult } from './errors';
import type { IdempotencyStore, WebhookResult } from './types';

export interface IdempotencyExtractionConfig {
  idempotencyHeader?: string;
  eventIdPath?: string;
  eventTypePath?: string;
}

export interface IdempotencyExtractionResult {
  eventId?: string;
  eventType?: string;
}

function getPathValue(payload: unknown, path: string | undefined): unknown {
  if (!path || payload === null || typeof payload !== 'object') {
    return undefined;
  }

  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (!segment || current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function extractIdempotency(
  headers: Record<string, string>,
  payload: unknown,
  config: IdempotencyExtractionConfig
): IdempotencyExtractionResult {
  const idempotencyHeader = config.idempotencyHeader?.toLowerCase();
  const headerEventId = idempotencyHeader ? headers[idempotencyHeader] : undefined;
  const eventId = asString(headerEventId) ?? asString(getPathValue(payload, config.eventIdPath));
  const eventType = asString(getPathValue(payload, config.eventTypePath));

  return { eventId, eventType };
}

export async function runIdempotencyStore(
  store: IdempotencyStore | undefined,
  eventId: string | undefined,
  ttlSeconds?: number
): Promise<WebhookResult | undefined> {
  if (!store || !eventId) {
    return undefined;
  }

  if (await store.has(eventId)) {
    return failureResult(
      'WEBHOOK_REPLAY_DETECTED',
      'Replay detected: event ID has already been processed'
    );
  }

  await store.set(eventId, ttlSeconds);
  return undefined;
}
