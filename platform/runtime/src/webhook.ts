import { BillingRuntimeError } from './types';

export interface VerifiedStripeEvent {
  providerEventId: string;
  eventType: string;
  livemode: boolean;
  providerObjectId: string | null;
  providerCustomerId: string | null;
  hints: Record<string, unknown>;
  normalizedEnvelope: Record<string, unknown>;
}

const encoder = new TextEncoder();

export async function readBoundedRawBody(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BillingRuntimeError('WEBHOOK_BODY_TOO_LARGE', 'Webhook body exceeds configured limit', 413);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [rawKey, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (rawKey === 't') timestamp = value;
    if (rawKey === 'v1' && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
async function computeStripeSignature(secret: string, signedPayload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload)));
}

function timingSafeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedStripeEvent> {
  if (!signatureHeader) throw new BillingRuntimeError('WEBHOOK_SIGNATURE_REQUIRED', 'Stripe-Signature is required', 400);
  if (!webhookSecret) throw new BillingRuntimeError('WEBHOOK_SECRET_MISSING', 'Stripe webhook secret is not configured', 500);
  const parsedSignature = parseStripeSignature(signatureHeader);
  const timestamp = Number(parsedSignature.timestamp);
  if (!Number.isInteger(timestamp) || parsedSignature.signatures.length === 0) {
    throw new BillingRuntimeError('WEBHOOK_SIGNATURE_INVALID', 'Malformed Stripe signature', 400);
  }
  if (Math.abs(nowSeconds - timestamp) > 300) {
    throw new BillingRuntimeError('WEBHOOK_TIMESTAMP_INVALID', 'Stripe webhook timestamp outside tolerance', 400);
  }
  const expected = await computeStripeSignature(webhookSecret, `${parsedSignature.timestamp}.${rawBody}`);
  const valid = parsedSignature.signatures.some((value) => {
    const candidate = hexToBytes(value);
    return candidate ? timingSafeBytesEqual(expected, candidate) : false;
  });
  if (!valid) throw new BillingRuntimeError('WEBHOOK_SIGNATURE_INVALID', 'Invalid Stripe signature', 400);

  let event: Record<string, unknown>;
  try {
    const candidate = JSON.parse(rawBody) as unknown;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('not object');
    event = candidate as Record<string, unknown>;
  } catch {
    throw new BillingRuntimeError('WEBHOOK_JSON_INVALID', 'Signed webhook payload is not valid JSON', 400);
  }
  const eventId = typeof event.id === 'string' ? event.id : '';
  const eventType = typeof event.type === 'string' ? event.type : '';
  if (!eventId || !eventType) {
    throw new BillingRuntimeError('WEBHOOK_IDENTITY_MISSING', 'Stripe event id/type is required', 400);
  }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const object = (data.object ?? {}) as Record<string, unknown>;
  const metadata = object.metadata && typeof object.metadata === 'object'
    ? object.metadata as Record<string, unknown>
    : {};
  const customer = typeof object.customer === 'string'
    ? object.customer
    : String((object.customer as Record<string, unknown> | undefined)?.id ?? '') || null;
  const objectId = typeof object.id === 'string' ? object.id : null;
  const subscriptionRef = typeof object.subscription === 'string'
    ? object.subscription
    : String((object.subscription as Record<string, unknown> | undefined)?.id ?? '') || null;
  const providerObjectId = object.object === 'subscription' || objectId?.startsWith('sub_')
    ? objectId
    : subscriptionRef;
  const livemode = event.livemode === true || object.livemode === true;
  return {
    providerEventId: eventId,
    eventType,
    livemode,
    providerObjectId,
    providerCustomerId: customer,
    hints: {
      product_id: metadata.wstera_product_id ?? null,
      account_id: metadata.account_id ?? null,
      profile_version: metadata.profile_version ?? null,
      plan_id: metadata.plan_id ?? null,
    },
    normalizedEnvelope: {
      provider: 'stripe',
      event_id: eventId,
      event_type: eventType,
      created: typeof event.created === 'number' ? event.created : null,
      provider_object_id: providerObjectId,
      provider_customer_id: customer,
      livemode,
    },
  };
}
