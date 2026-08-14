import { failureResult } from '../../core/errors';
import type { VerificationResult, WebhookVerifier, WebhookVerifierInput } from '../../core/types';

export class StripeWebhookVerifier implements WebhookVerifier {
  readonly providerName = 'stripe';

  verify(_input: WebhookVerifierInput): Promise<VerificationResult> {
    return Promise.resolve(
      failureResult(
        'WEBHOOK_UNKNOWN_PROVIDER',
        'Stripe webhook verifier is not yet implemented',
        this.providerName
      )
    );
  }
}
