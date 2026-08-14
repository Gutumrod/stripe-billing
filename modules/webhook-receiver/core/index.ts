import type { WebhookReceiver, WebhookReceiverConfig } from './types';
import { createVerifyContext, verifyWebhookRequest } from './verify';

export function createWebhookReceiver(config: WebhookReceiverConfig): WebhookReceiver {
  const context = createVerifyContext(config);
  const receiver: WebhookReceiver = {
    verify(request, providerName) {
      return verifyWebhookRequest(context, request, providerName);
    },
  };

  return Object.freeze(receiver);
}

export type {
  GenericHmacConfig,
  IdempotencyStore,
  VerificationResult,
  WebhookError,
  WebhookErrorCode,
  WebhookEvent,
  WebhookReceiver,
  WebhookReceiverConfig,
  WebhookRequest,
  WebhookResult,
  WebhookVerifier,
  WebhookVerifierInput,
} from './types';
