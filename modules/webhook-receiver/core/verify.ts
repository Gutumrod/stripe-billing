import { failureResult } from './errors';
import {
  DEFAULT_PAYLOAD_MAX_BYTES,
  guardPayloadSize,
  parseJsonPayload,
  rawBodyToString,
} from './payload';
import { DEFAULT_TIMESTAMP_TOLERANCE_SECONDS, validateTimestampWindow } from './timestamp';
import { buildVerifierRegistry, resolveVerifier, type VerifierRegistry } from './verifier';
import { extractIdempotency, runIdempotencyStore } from './idempotency';
import type { WebhookReceiverConfig, WebhookRequest, WebhookResult } from './types';

export interface VerifyContext {
  registry: VerifierRegistry;
  config: Readonly<WebhookReceiverConfig>;
}

export function createVerifyContext(config: WebhookReceiverConfig): VerifyContext {
  return Object.freeze({
    registry: buildVerifierRegistry(config),
    config: Object.freeze({ ...config }),
  });
}

export async function verifyWebhookRequest(
  context: VerifyContext,
  request: WebhookRequest,
  providerName?: string
): Promise<WebhookResult> {
  const payloadMaxBytes = context.config.payloadMaxBytes ?? DEFAULT_PAYLOAD_MAX_BYTES;
  const payloadSizeError = guardPayloadSize(request.rawBody, payloadMaxBytes);
  if (payloadSizeError) {
    return payloadSizeError;
  }

  const headers = normalizeHeaders(request.headers);
  const resolved = resolveVerifier(context.registry, request, providerName);
  if (resolved.error) {
    return resolved.error;
  }
  if (!resolved.verifier) {
    return failureResult(
      'WEBHOOK_UNKNOWN_PROVIDER',
      'No verifier registered for provider: unknown-service'
    );
  }

  const rawBody = rawBodyToString(request.rawBody);
  const verification = await resolved.verifier.verify({ rawBody, headers });
  if (!verification.valid) {
    return {
      valid: false,
      error:
        verification.error ??
        failureResult(
          'WEBHOOK_INVALID_SIGNATURE',
          'Invalid cryptographic signature',
          resolved.verifier.providerName
        ).error,
    };
  }

  const extractionConfig = getVerifierExtractionConfig(resolved.verifier);
  const timestampToleranceSeconds =
    context.config.timestampToleranceSeconds ??
    extractionConfig.toleranceSeconds ??
    DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  const timestampError = validateTimestampWindow(
    verification.timestamp,
    timestampToleranceSeconds
  );
  if (timestampError) {
    return timestampError;
  }

  const parsed = parseJsonPayload(rawBody);
  if (parsed.error) {
    return parsed.error;
  }

  const extracted = extractIdempotency(headers, parsed.payload, extractionConfig);
  const eventId = verification.eventId ?? extracted.eventId;
  const eventType = verification.eventType ?? extracted.eventType;

  const replayError = await runIdempotencyStore(
    context.config.idempotencyStore,
    eventId,
    timestampToleranceSeconds
  );
  if (replayError) {
    return replayError;
  }

  return {
    valid: true,
    eventId,
    eventType,
    payload: verification.payload ?? parsed.payload,
  };
}

export function normalizeHeaders(
  headers: WebhookRequest['headers']
): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(', ');
    }
  }

  return normalized;
}

function getVerifierExtractionConfig(verifier: unknown): {
  idempotencyHeader?: string;
  eventIdPath?: string;
  eventTypePath?: string;
  toleranceSeconds?: number;
} {
  if (verifier && typeof verifier === 'object' && 'config' in verifier) {
    const config = (verifier as { config?: unknown }).config;
    if (config && typeof config === 'object') {
      const candidate = config as {
        idempotencyHeader?: unknown;
        eventIdPath?: unknown;
        eventTypePath?: unknown;
        toleranceSeconds?: unknown;
      };
      return {
        idempotencyHeader:
          typeof candidate.idempotencyHeader === 'string'
            ? candidate.idempotencyHeader
            : undefined,
        eventIdPath:
          typeof candidate.eventIdPath === 'string' ? candidate.eventIdPath : undefined,
        eventTypePath:
          typeof candidate.eventTypePath === 'string' ? candidate.eventTypePath : undefined,
        toleranceSeconds:
          typeof candidate.toleranceSeconds === 'number'
            ? candidate.toleranceSeconds
            : undefined,
      };
    }
  }
  return {};
}
