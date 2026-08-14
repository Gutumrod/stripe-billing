import { failureResult } from './errors';
import type { WebhookResult } from './types';

export const DEFAULT_PAYLOAD_MAX_BYTES = 1_048_576;

export function rawBodyToString(rawBody: string | Uint8Array): string {
  if (typeof rawBody === 'string') {
    return rawBody;
  }
  return new TextDecoder().decode(rawBody);
}

export function getRawBodyByteLength(rawBody: string | Uint8Array): number {
  if (typeof rawBody === 'string') {
    return new TextEncoder().encode(rawBody).byteLength;
  }
  return rawBody.byteLength;
}

export function guardPayloadSize(
  rawBody: string | Uint8Array,
  payloadMaxBytes: number
): WebhookResult | undefined {
  if (getRawBodyByteLength(rawBody) > payloadMaxBytes) {
    return failureResult(
      'WEBHOOK_OVERSIZED_PAYLOAD',
      `Payload size exceeds maximum allowed limit of ${payloadMaxBytes} bytes`
    );
  }
  return undefined;
}

export function parseJsonPayload(rawBody: string): { payload?: unknown; error?: WebhookResult } {
  try {
    return { payload: JSON.parse(rawBody) as unknown };
  } catch {
    return {
      error: failureResult('WEBHOOK_MALFORMED_JSON', 'Failed to parse JSON body'),
    };
  }
}
