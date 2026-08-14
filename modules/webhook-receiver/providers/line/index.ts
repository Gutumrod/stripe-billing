import { failureResult } from '../../core/errors';
import type { VerificationResult, WebhookVerifier, WebhookVerifierInput } from '../../core/types';

export class LineWebhookVerifier implements WebhookVerifier {
  readonly providerName = 'line';

  verify(_input: WebhookVerifierInput): Promise<VerificationResult> {
    return Promise.resolve(
      failureResult(
        'WEBHOOK_UNKNOWN_PROVIDER',
        'LINE webhook verifier is not yet implemented',
        this.providerName
      )
    );
  }
}
