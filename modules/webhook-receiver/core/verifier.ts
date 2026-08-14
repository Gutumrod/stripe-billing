import { createError, failureResult } from './errors';
import type {
  WebhookError,
  WebhookReceiverConfig,
  WebhookRequest,
  WebhookResult,
  WebhookVerifier,
} from './types';

export interface VerifierRegistry {
  readonly verifiers: ReadonlyMap<string, WebhookVerifier>;
  readonly defaultProvider?: string;
}

export function buildVerifierRegistry(config: WebhookReceiverConfig): VerifierRegistry {
  if (config.payloadMaxBytes !== undefined && config.payloadMaxBytes <= 0) {
    throw createConfigError('payloadMaxBytes must be greater than 0');
  }
  if (
    config.timestampToleranceSeconds !== undefined &&
    config.timestampToleranceSeconds <= 0
  ) {
    throw createConfigError('timestampToleranceSeconds must be greater than 0');
  }

  const verifiers = new Map<string, WebhookVerifier>();

  if (config.verifier) {
    verifiers.set(config.verifier.providerName, config.verifier);
  }

  if (config.verifiers) {
    for (const [name, verifier] of Object.entries(config.verifiers)) {
      verifiers.set(name, verifier);
      verifiers.set(verifier.providerName, verifier);
    }
  }

  if (verifiers.size === 0) {
    throw createConfigError('verifiers are required');
  }

  const defaultProvider =
    config.defaultProvider ??
    (config.verifier && !config.verifiers ? config.verifier.providerName : undefined);

  if (defaultProvider && !verifiers.has(defaultProvider)) {
    throw createConfigError('defaultProvider not found in verifiers');
  }

  return Object.freeze({
    verifiers,
    defaultProvider,
  });
}

export function resolveVerifier(
  registry: VerifierRegistry,
  request: WebhookRequest,
  providerName?: string
): { verifier?: WebhookVerifier; provider?: string; error?: WebhookResult } {
  const selectedProvider = providerName ?? request.provider ?? registry.defaultProvider;

  if (!selectedProvider) {
    return {
      error: failureResult(
        'WEBHOOK_UNKNOWN_PROVIDER',
        'No verifier registered for provider: unknown-service'
      ),
    };
  }

  const verifier = registry.verifiers.get(selectedProvider);
  if (!verifier) {
    return {
      provider: selectedProvider,
      error: failureResult(
        'WEBHOOK_UNKNOWN_PROVIDER',
        `No verifier registered for provider: ${selectedProvider}`,
        selectedProvider
      ),
    };
  }

  return { verifier, provider: selectedProvider };
}

function createConfigError(reason: string): WebhookError {
  return createError(
    'WEBHOOK_CONFIG_INVALID',
    `Invalid WebhookReceiverConfig: ${reason}`
  );
}
