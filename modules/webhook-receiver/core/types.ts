export interface WebhookRequest {
  /** Raw unparsed request body as string or Uint8Array. Mandatory for signature checks. */
  rawBody: string | Uint8Array;
  /** Request headers object or Web Standard Headers object. */
  headers: Record<string, string | string[] | undefined> | Headers;
  /** Optional URL path for providers requiring route path verification. */
  url?: string;
  /** Optional HTTP method (e.g. "POST"). */
  method?: string;
  /** Optional explicit provider name identifier. */
  provider?: string;
}

export type WebhookResult = {
  /** True if signature, timestamp, size limit, and replay checks pass. */
  valid: boolean;
  /** Extracted unique event ID / idempotency key from provider. */
  eventId?: string;
  /** Extracted event type name (e.g. "payment.succeeded", "ping"). */
  eventType?: string;
  /** Parsed JSON payload or decoded body content. */
  payload?: unknown;
  /** Structured error details if valid is false. */
  error?: WebhookError;
};

export interface WebhookEvent {
  id: string;
  type: string;
  payload: unknown;
  timestamp?: number;
  provider: string;
  signature?: string;
  rawBody: string;
  headers: Record<string, string>;
}

export interface WebhookError {
  code: WebhookErrorCode;
  message: string;
  provider?: string;
}

export type WebhookErrorCode =
  | 'WEBHOOK_MISSING_SIGNATURE'
  | 'WEBHOOK_INVALID_SIGNATURE'
  | 'WEBHOOK_MISSING_TIMESTAMP'
  | 'WEBHOOK_INVALID_TIMESTAMP'
  | 'WEBHOOK_EXPIRED_TIMESTAMP'
  | 'WEBHOOK_MALFORMED_JSON'
  | 'WEBHOOK_OVERSIZED_PAYLOAD'
  | 'WEBHOOK_REPLAY_DETECTED'
  | 'WEBHOOK_UNKNOWN_PROVIDER'
  | 'WEBHOOK_CONFIG_INVALID';

export interface WebhookVerifierInput {
  /** Raw body payload exactly as received. */
  rawBody: string;
  /** Normalized lowercase request headers. */
  headers: Record<string, string>;
  /** Pre-extracted timestamp in seconds (if parsed from headers). */
  timestamp?: number;
}

export interface VerificationResult {
  valid: boolean;
  eventId?: string;
  eventType?: string;
  payload?: unknown;
  timestamp?: number;
  providerMetadata?: Record<string, unknown>;
  error?: WebhookError;
}

export interface WebhookVerifier {
  /** Unique provider identifier (e.g. "generic-hmac", "line", "stripe", "github"). */
  readonly providerName: string;
  /** Cryptographically verifies the raw payload and headers. */
  verify(input: WebhookVerifierInput): Promise<VerificationResult>;
}

export interface IdempotencyStore {
  /** Returns true if the eventId has already been processed. */
  has(key: string): Promise<boolean>;
  /** Records an eventId in the dedup store with optional TTL. */
  set(key: string, ttlSeconds?: number): Promise<void>;
}

export interface GenericHmacConfig {
  /** Secret key used for HMAC computation. Must never be logged. */
  secret: string;
  /** Header name containing signature (e.g. "x-signature", "x-hub-signature-256"). */
  signatureHeader: string;
  /** Optional header name containing timestamp (e.g. "x-timestamp"). */
  timestampHeader?: string;
  /** Hash algorithm to use. Default 'SHA-256'. */
  algorithm?: 'SHA-256' | 'SHA-512';
  /** Signature encoding format in header. Default 'hex'. */
  encoding?: 'hex' | 'base64';
  /** Optional signature prefix (e.g. "sha256=" or "v1="). */
  prefix?: string;
  /** Maximum allowable age of webhook in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Optional header name containing event ID for idempotency. */
  idempotencyHeader?: string;
  /** Dot-notation JSON path to extract eventId from payload (e.g. "id" or "event_id"). */
  eventIdPath?: string;
  /** Dot-notation JSON path to extract eventType from payload (e.g. "type" or "event"). */
  eventTypePath?: string;
}

export interface WebhookReceiverConfig {
  /** Primary verifier instance (convenience for single-provider setup). */
  verifier?: WebhookVerifier;
  /** Dictionary of verifiers keyed by provider name (for multi-provider setup). */
  verifiers?: Record<string, WebhookVerifier>;
  /** Default provider name to use if request doesn't specify one. */
  defaultProvider?: string;
  /** Max raw body size in bytes. Default: 1,048,576 (1 MB). */
  payloadMaxBytes?: number;
  /** Max acceptable timestamp skew/age in seconds. Default: 300 (5 minutes). */
  timestampToleranceSeconds?: number;
  /** Optional idempotency store for replay deduplication. */
  idempotencyStore?: IdempotencyStore;
}

export interface WebhookReceiver {
  /**
   * Primary entry point to verify an incoming webhook request.
   * Parses, checks payload size limit, verifies signature & timestamp,
   * checks replay/idempotency, and extracts verified event data.
   */
  verify(request: WebhookRequest, providerName?: string): Promise<WebhookResult>;
}
