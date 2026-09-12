import {
  AccountAssertionKey,
  BillingEnvironment,
  BillingRuntimeError,
  CredentialBinding,
  CredentialScope,
  EntitlementSigningKey,
  ProfileRegistryLike,
  RuntimeProfile,
  SignedEntitlementTransition,
  EntitlementTransitionEnvelope,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await digest(value));
}

async function constantTimeStringEqual(left: string, right: string): Promise<boolean> {
  const a = await digest(left);
  const b = await digest(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
export async function authenticateBearer(
  authorization: string | null,
  bindings: CredentialBinding[],
  requiredScope: CredentialScope,
): Promise<CredentialBinding> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new BillingRuntimeError('AUTH_REQUIRED', 'Product credential is required', 401);
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new BillingRuntimeError('AUTH_REQUIRED', 'Product credential is required', 401);
  for (const binding of bindings) {
    if (await constantTimeStringEqual(token, binding.token)) {
      if (!binding.scopes.includes(requiredScope)) {
        throw new BillingRuntimeError('AUTH_SCOPE_DENIED', 'Credential scope denied', 403);
      }
      return { ...binding, token: '[REDACTED]' };
    }
  }
  throw new BillingRuntimeError('AUTH_INVALID', 'Invalid product credential', 401);
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

export interface AccountAssertionPayload {
  iss: string;
  aud: string;
  key_id: string;
  product_id: string;
  environment: BillingEnvironment;
  account_id: string;
  action: string;
  operation_id: string;
  nonce: string;
  iat: number;
  exp: number;
}

export async function signAccountAssertion(
  payload: AccountAssertionPayload,
  secret: string,
): Promise<string> {
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, payloadPart);
  return `${payloadPart}.${signature}`;
}

export async function verifyAccountAssertion(
  token: string | null,
  binding: CredentialBinding,
  expectedAction: string,
  expectedAccountId: string,
  expectedOperationId: string,
  keys: AccountAssertionKey[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AccountAssertionPayload> {
  if (!token) throw new BillingRuntimeError('ACCOUNT_ASSERTION_REQUIRED', 'Account assertion is required', 401);
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_INVALID', 'Malformed account assertion', 401);
  }
  const [payloadPart, signaturePart] = parts;
  let payload: AccountAssertionPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(payloadPart))) as AccountAssertionPayload;
  } catch {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_INVALID', 'Malformed account assertion', 401);
  }
  const key = keys.find((candidate) =>
    candidate.keyId === payload.key_id &&
    candidate.productId === binding.productId &&
    candidate.environment === binding.environment,
  );
  if (!key) throw new BillingRuntimeError('ACCOUNT_ASSERTION_INVALID', 'Unknown assertion key', 401);
  const expectedSignature = await hmac(key.secret, payloadPart);
  if (!(await constantTimeStringEqual(signaturePart, expectedSignature))) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_INVALID', 'Invalid account assertion', 401);
  }
  if (payload.aud !== 'wstera-billing-core' || payload.iss !== binding.productId) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_INVALID', 'Assertion audience or issuer mismatch', 403);
  }
  if (payload.product_id !== binding.productId || payload.environment !== binding.environment) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_MISMATCH', 'Assertion product/environment mismatch', 403);
  }
  if (payload.account_id !== expectedAccountId || payload.operation_id !== expectedOperationId) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_MISMATCH', 'Assertion account/operation mismatch', 403);
  }
  if (payload.action !== expectedAction) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_MISMATCH', 'Assertion action mismatch', 403);
  }
  if (!payload.nonce || payload.exp <= nowSeconds || payload.iat > nowSeconds + 30) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_EXPIRED', 'Assertion is expired or outside clock window', 401);
  }
  if (payload.exp - payload.iat > 300) {
    throw new BillingRuntimeError('ACCOUNT_ASSERTION_INVALID', 'Assertion lifetime exceeds five minutes', 401);
  }
  return payload;
}

export function resolveProfile(
  registry: ProfileRegistryLike,
  binding: CredentialBinding,
  admissionTestMode: boolean,
): Readonly<RuntimeProfile> {
  if (!admissionTestMode) {
    return registry.resolveForRuntime({
      credentialProductId: binding.productId,
      environment: binding.environment,
      profileVersion: binding.profileVersion,
    });
  }
  if (binding.environment !== 'test') {
    throw new BillingRuntimeError('ADMISSION_MODE_DENIED', 'Admission test mode is Test-only', 403);
  }
  const profile = registry.getRegistered(binding.productId, binding.environment, binding.profileVersion);
  if (!['pending_validation', 'active'].includes(profile.status)) {
    throw new BillingRuntimeError('PROFILE_NOT_ADMISSIBLE', `Profile status is not admissible: ${profile.status}`, 409);
  }
  return profile;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export async function requestFingerprint(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(value)));
}

export async function deriveIdempotencyKey(parts: string[]): Promise<string> {
  return `wstera-${(await sha256Hex(parts.join('\u001f'))).slice(0, 48)}`;
}
export async function signEntitlementTransition(
  envelope: EntitlementTransitionEnvelope,
  key: EntitlementSigningKey,
): Promise<SignedEntitlementTransition> {
  if (key.productId !== envelope.product_id || key.environment !== envelope.environment) {
    throw new BillingRuntimeError('ENTITLEMENT_KEY_MISMATCH', 'Entitlement signing key mismatch', 500);
  }
  const encoded = toBase64Url(encoder.encode(JSON.stringify(canonicalize(envelope))));
  return { envelope, signature: `${key.keyId}.${await hmac(key.secret, encoded)}` };
}

export async function verifyEntitlementTransition(
  signed: SignedEntitlementTransition,
  keys: EntitlementSigningKey[],
  nowMs = Date.now(),
): Promise<void> {
  const [keyId, provided] = signed.signature.split('.');
  const key = keys.find((candidate) =>
    candidate.keyId === keyId &&
    candidate.productId === signed.envelope.product_id &&
    candidate.environment === signed.envelope.environment,
  );
  if (!key || !provided) throw new BillingRuntimeError('ENTITLEMENT_SIGNATURE_INVALID', 'Invalid entitlement signature', 401);
  const encoded = toBase64Url(encoder.encode(JSON.stringify(canonicalize(signed.envelope))));
  const expected = await hmac(key.secret, encoded);
  if (!(await constantTimeStringEqual(provided, expected))) {
    throw new BillingRuntimeError('ENTITLEMENT_SIGNATURE_INVALID', 'Invalid entitlement signature', 401);
  }
  const issued = Date.parse(signed.envelope.issued_at);
  const expires = Date.parse(signed.envelope.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= nowMs || issued > nowMs + 30_000) {
    throw new BillingRuntimeError('ENTITLEMENT_REPLAY_WINDOW', 'Entitlement transition outside replay window', 401);
  }
  if (expires - issued > 300_000) {
    throw new BillingRuntimeError('ENTITLEMENT_REPLAY_WINDOW', 'Entitlement replay window exceeds five minutes', 401);
  }
}
