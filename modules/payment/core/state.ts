import { PaymentStatus } from './types.js';

const VALID_STATUSES: PaymentStatus[] = [
  'pending',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'cancelled',
];

export function isValidPaymentStatus(status: unknown): status is PaymentStatus {
  return typeof status === 'string' && VALID_STATUSES.includes(status as PaymentStatus);
}
