import { failureResult, timingSafeEqual } from '../../core/errors';
import {
  DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
  validateTimestampWindow,
} from '../../core/timestamp';
import type {
  VerificationResult,
  WebhookVerifier,
  WebhookVerifierInput,
} from '../../core/types';

export interface StripeWebhookConfig {
  /** Stripe webhook endpoint secret (starts with whsec_). */
  secret: string;
  /** Maximum allowable age of webhook in seconds. Default 300. */
  toleranceSeconds?: number;
}

export class StripeWebhookVerifier implements WebhookVerifier {
  readonly providerName = 'stripe';
  readonly config: Readonly<StripeWebhookConfig>;

  constructor(config?: Partial<StripeWebhookConfig>) {
    this.config = Object.freeze({
      secret: '',
      ...config,
    });
  }

  async verify(input: WebhookVerifierInput): Promise<VerificationResult> {
    const signatureHeader = input.headers['stripe-signature'];
    if (!signatureHeader) {
      return failureResult(
        'WEBHOOK_MISSING_SIGNATURE',
        'Missing required stripe-signature header',
        this.providerName
      );
    }

    const { timestampStr, signatures } = parseStripeSignatureHeader(signatureHeader);
    if (!timestampStr || signatures.length === 0) {
      return failureResult(
        'WEBHOOK_INVALID_SIGNATURE',
        'Malformed stripe-signature header',
        this.providerName
      );
    }

    const timestamp = Number(timestampStr);
    if (!Number.isInteger(timestamp) || !/^\d+$/.test(timestampStr.trim())) {
      return failureResult(
        'WEBHOOK_INVALID_SIGNATURE',
        'Malformed stripe-signature header',
        this.providerName
      );
    }

    const payloadToSign = `${timestampStr}.${input.rawBody}`;
    const expectedSignature = await this.computeHmac(payloadToSign);

    let signatureMatches = false;
    for (const sig of signatures) {
      const receivedBytes = decodeHex(sig);
      if (receivedBytes && timingSafeEqual(expectedSignature, receivedBytes)) {
        signatureMatches = true;
        break;
      }
    }

    if (!signatureMatches) {
      return failureResult(
        'WEBHOOK_INVALID_SIGNATURE',
        'Invalid cryptographic signature',
        this.providerName
      );
    }

    const tolerance =
      this.config.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
    const timestampError = validateTimestampWindow(timestamp, tolerance);
    if (timestampError) {
      return {
        valid: false,
        error: {
          ...timestampError.error!,
          provider: this.providerName,
        },
      };
    }

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(input.rawBody);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return failureResult(
          'WEBHOOK_MALFORMED_JSON',
          'Invalid Stripe event payload: expected JSON object',
          this.providerName
        );
      }
      event = parsed as Record<string, unknown>;
    } catch {
      return failureResult(
        'WEBHOOK_MALFORMED_JSON',
        'Invalid Stripe event payload: malformed JSON',
        this.providerName
      );
    }

    const eventId = typeof event.id === 'string' ? event.id : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;

    return {
      valid: true,
      eventId,
      eventType,
      payload: event,
      timestamp,
    };
  }

  private async computeHmac(payload: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.config.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return new Uint8Array(mac);
  }
}

function parseStripeSignatureHeader(header: string): {
  timestampStr?: string;
  signatures: string[];
} {
  const signatures: string[] = [];
  let timestampStr: string | undefined;

  const parts = header.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();

    if (key === 't' && val) {
      timestampStr = val;
    } else if (key === 'v1' && val) {
      signatures.push(val);
    }
  }

  return { timestampStr, signatures };
}

function decodeHex(value: string): Uint8Array | undefined {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    return undefined;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
