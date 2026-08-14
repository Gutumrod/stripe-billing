import { failureResult } from '../../core/errors';
import type { VerificationResult, WebhookVerifier, WebhookVerifierInput } from '../../core/types';

export class GithubWebhookVerifier implements WebhookVerifier {
  readonly providerName = 'github';

  verify(_input: WebhookVerifierInput): Promise<VerificationResult> {
    return Promise.resolve(
      failureResult(
        'WEBHOOK_UNKNOWN_PROVIDER',
        'GitHub webhook verifier is not yet implemented',
        this.providerName
      )
    );
  }
}
