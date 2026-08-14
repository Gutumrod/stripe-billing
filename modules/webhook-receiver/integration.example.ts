/**
 * modules/webhook-receiver/integration.example.ts
 * Generic Cloudflare Worker Host Example — reference only when integrating into a real project.
 * Do NOT copy this file wholesale into production.
 *
 * The Webhook Receiver module NEVER reads env itself. The Host reads its own env
 * (HMAC secret, tolerance, header names) and injects the verifier + config via the
 * public API. The module never touches process.env / env / globalThis.
 */

import { createWebhookReceiver } from './core';
import { GenericHmacVerifier } from './providers/generic-hmac';

// Host declares its OWN env bindings — declared in wrangler.toml.
// The module never sees this interface; it only receives the constructed config.
interface Env {
  WEBHOOK_SECRET: string;          // HMAC signing secret — set via `wrangler secret put`
  WEBHOOK_TOLERANCE_SECONDS?: string; // optional clock-skew window override (integer string)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST — all other methods are rejected before any processing.
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 1. Host reads its OWN env and constructs the verifier.
    //    GenericHmacVerifier handles HMAC-over-body schemes; the secret never leaves
    //    the host env — the module only receives the already-constructed verifier.
    const hmacVerifier = new GenericHmacVerifier({
      secret: env.WEBHOOK_SECRET,
      signatureHeader: 'x-hub-signature-256',
      timestampHeader: 'x-webhook-timestamp',
      algorithm: 'SHA-256',
      encoding: 'hex',
      prefix: 'sha256=',
      eventIdPath: 'id',
      eventTypePath: 'type',
    });

    // 2. Host builds WebhookReceiverConfig and calls createWebhookReceiver.
    //    toleranceSeconds can be overridden from host env; falls back to the module default (300).
    const toleranceSeconds = env.WEBHOOK_TOLERANCE_SECONDS
      ? parseInt(env.WEBHOOK_TOLERANCE_SECONDS, 10)
      : 300;

    const receiver = createWebhookReceiver({
      verifier: hmacVerifier,
      payloadMaxBytes: 1_048_576,
      timestampToleranceSeconds: toleranceSeconds,
    });

    // 3. Read the raw body as a string BEFORE any parsing.
    //    The module enforces payloadMaxBytes against this string length — do not pre-parse.
    const rawBody = await request.text();

    // 4. Build a plain headers record from the incoming request.
    //    The module normalizes header names internally (lowercases); passing them as-is is fine.
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // 5. Run the full verification pipeline.
    //    verify() never throws — failures surface as { valid: false, error }.
    //    Pipeline: size guard → header normalization → provider selection →
    //              signature verification → timestamp window → idempotency → result framing.
    const result = await receiver.verify({ rawBody, headers });

    // 6. Branch on result.valid BEFORE any business logic.
    //    Never forward result.error.message or result.error.cause to external callers —
    //    only expose the error code so internal details cannot be inferred by senders.
    if (!result.valid) {
      return Response.json(
        { error: result.error?.code, message: result.error?.message },
        { status: 400 },
      );
    }

    // 7. Safe to use verified event data.
    //    result.eventId and result.eventType are extracted by the verifier (via eventIdPath /
    //    eventTypePath) and available here without re-parsing the payload.
    console.log('[webhook] verified event', {
      eventId: result.eventId,
      eventType: result.eventType,
    });

    // Execute domain logic here using result.payload (the parsed, verified JSON body).

    return Response.json({ success: true });
  },
};
