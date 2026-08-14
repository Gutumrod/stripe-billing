import { createPaymentCore, createStripeAdapter, PaymentError } from '../index.js';

// 1. Host injects Stripe configuration & secrets
const stripeAdapter = createStripeAdapter({
  secretKey: 'sk_test_mock_secret_key_for_example',
  publishableKey: 'pk_test_mock_pub_key_for_example',
  webhookSecret: 'whsec_mock_webhook_secret',
  apiVersion: '2024-06-20',
  fetch: globalThis.fetch,
  useCheckoutSession: true,
});

// 2. Instantiate Payment Core with configuration and provider adapter
const paymentCore = createPaymentCore(
  {
    defaultCurrency: 'THB',
    supportedCurrencies: ['THB', 'USD', 'EUR'],
    minAmountMinorUnits: 1000, // 10.00 THB minimum
    maxAmountMinorUnits: 100000000, // 1,000,000.00 THB maximum
    hooks: {
      onPaymentStart: (req) => console.log(`[Payment] Starting payment for ref: ${req.referenceId}`),
      onPaymentSuccess: (res) => console.log(`[Payment] Success ID: ${res.paymentId}`),
      onPaymentFailure: (err) => console.error(`[Payment] Failed Code: ${err.code} Message: ${err.message}`),
    },
  },
  stripeAdapter
);

async function run() {
  try {
    // 3. Create a payment (100.00 THB = 10000 minor units)
    console.log('--- Creating Payment ---');
    const paymentResult = await paymentCore.createPayment({
      amount: 10000, // 100.00 THB
      currency: 'THB',
      referenceId: 'order_20260812_001',
      idempotencyKey: 'idemp_order_20260812_001_v1',
      description: 'Order #20260812_001 Payment',
      metadata: { orderId: 'order_20260812_001', customerEmail: 'user@example.com' },
      returnUrl: 'https://app.example.com/checkout/success',
      cancelUrl: 'https://app.example.com/checkout/cancel',
    });

    if (paymentResult.success) {
      console.log('Payment Created Successfully!');
      console.log('Payment ID:', paymentResult.paymentId);
      console.log('Normalized Status:', paymentResult.status);
      console.log('Checkout URL (Redirect customer here):', paymentResult.checkoutUrl);
    } else {
      console.error('Payment creation failed:', paymentResult.error?.message);
    }
  } catch (error) {
    if (error instanceof PaymentError) {
      console.error('Payment Core Error:', error.code, error.message);
    } else {
      console.error('Unexpected Error:', error);
    }
  }
}

run();
