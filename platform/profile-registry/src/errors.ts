export class ProfileValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid Product Billing Profile: ${issues.join('; ')}`);
    this.name = 'ProfileValidationError';
  }
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileResolutionError';
  }
}

export class ProfileActivationError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Profile activation denied: ${reasons.join('; ')}`);
    this.name = 'ProfileActivationError';
  }
}
