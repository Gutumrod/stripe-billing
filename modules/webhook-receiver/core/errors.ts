import type { WebhookError, WebhookErrorCode, WebhookResult } from './types';

export function createError(
  code: WebhookErrorCode,
  message: string,
  provider?: string
): WebhookError {
  return provider ? { code, message, provider } : { code, message };
}

export function failureResult(
  code: WebhookErrorCode,
  message: string,
  provider?: string
): WebhookResult {
  return {
    valid: false,
    error: createError(code, message, provider),
  };
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let c = 0;
  for (let i = 0; i < a.byteLength; i++) {
    c |= a[i] ^ b[i];
  }
  return c === 0;
}
