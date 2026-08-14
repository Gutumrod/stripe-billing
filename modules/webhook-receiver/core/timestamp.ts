import { failureResult } from './errors';
import type { WebhookResult } from './types';

export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function parseTimestamp(value: string | number | undefined): {
  timestamp?: number;
  error?: WebhookResult;
} {
  if (value === undefined) {
    return {
      error: failureResult('WEBHOOK_MISSING_TIMESTAMP', 'Missing required timestamp header'),
    };
  }

  const timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(timestamp)) {
    return {
      error: failureResult('WEBHOOK_INVALID_TIMESTAMP', 'Invalid timestamp format in header'),
    };
  }

  return { timestamp };
}

export function validateTimestampWindow(
  timestamp: number | undefined,
  toleranceSeconds: number
): WebhookResult | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

  const currentEpochSeconds = Math.floor(Date.now() / 1000);
  const age = Math.abs(currentEpochSeconds - timestamp);

  if (age > toleranceSeconds) {
    return failureResult(
      'WEBHOOK_EXPIRED_TIMESTAMP',
      'Webhook timestamp expired or outside tolerance window'
    );
  }

  return undefined;
}
