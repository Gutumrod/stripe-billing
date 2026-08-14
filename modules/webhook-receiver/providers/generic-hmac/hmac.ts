import { failureResult, timingSafeEqual } from '../../core/errors';
import { parseTimestamp } from '../../core/timestamp';
import type {
  GenericHmacConfig,
  VerificationResult,
  WebhookVerifier,
  WebhookVerifierInput,
} from '../../core/types';

export class GenericHmacVerifier implements WebhookVerifier {
  readonly providerName = 'generic-hmac';
  readonly config: Readonly<GenericHmacConfig>;

  constructor(config: GenericHmacConfig) {
    this.config = Object.freeze({ ...config });
  }

  async verify(input: WebhookVerifierInput): Promise<VerificationResult> {
    const signatureHeader = this.config.signatureHeader.toLowerCase();
    const signature = input.headers[signatureHeader];
    if (!signature) {
      return failureResult(
        'WEBHOOK_MISSING_SIGNATURE',
        `Missing required signature header: ${this.config.signatureHeader}`,
        this.providerName
      );
    }

    const timestampResult = this.parseConfiguredTimestamp(input.headers);
    if (timestampResult.error?.error) {
      return {
        valid: false,
        error: {
          ...timestampResult.error.error,
          provider: this.providerName,
        },
      };
    }

    const expectedSignature = await this.computeSignature(input.rawBody);
    const receivedSignature = this.decodeSignature(signature);
    if (!receivedSignature || !timingSafeEqual(expectedSignature, receivedSignature)) {
      return failureResult(
        'WEBHOOK_INVALID_SIGNATURE',
        'Invalid cryptographic signature',
        this.providerName
      );
    }

    return {
      valid: true,
      timestamp: timestampResult.timestamp,
    };
  }

  private parseConfiguredTimestamp(headers: Record<string, string>): {
    timestamp?: number;
    error?: ReturnType<typeof failureResult>;
  } {
    if (!this.config.timestampHeader) {
      return {};
    }

    const timestampHeader = this.config.timestampHeader.toLowerCase();
    return parseTimestamp(headers[timestampHeader]);
  }

  private async computeSignature(rawBody: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.config.secret),
      { name: 'HMAC', hash: this.config.algorithm ?? 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    return new Uint8Array(mac);
  }

  private decodeSignature(signature: string): Uint8Array | undefined {
    const unprefixed = this.config.prefix
      ? signature.startsWith(this.config.prefix)
        ? signature.slice(this.config.prefix.length)
        : undefined
      : signature;

    if (!unprefixed) {
      return undefined;
    }

    return (this.config.encoding ?? 'hex') === 'base64'
      ? decodeBase64(unprefixed)
      : decodeHex(unprefixed);
  }
}

function decodeHex(value: string): Uint8Array | undefined {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    return undefined;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}
