# Payment Core + Stripe Adapter Module — DESIGN.md

**Version:** 0.1.0 (P0, experimental)
**Status:** Design (Stage 1 — Architect). This file is the single source of truth for downstream agents (Stage 2 implementer, Stage 3 tester, Stage 4 reviewer).
**Language / runtime:** TypeScript, ES2022, strict mode, `moduleResolution: Bundler`. Must run on Cloudflare Workers (no `node:*` imports; Web APIs only).

---

## 1. Purpose

A reusable, central **Payment Core module with a Stripe Adapter** for the Module Hub monorepo. It provides a standardized payment abstraction layer separating business domain logic from payment provider SDKs.

The architecture follows a strict layered design:

```
Business Project
       ↓
  Payment Core
       ↓
Payment Provider (Interface)
       ↓
Stripe Adapter (or Mock Adapter)
       ↓
Stripe API / SDK
```

### Architectural Boundary

> **CRITICAL BOUNDARY:** Business Projects MUST NOT call the Stripe SDK directly or scatter Stripe-specific API calls across the system. All payment operations (creation, retrieval, refund, status checks, and webhook event normalization) MUST route exclusively through the Payment Core abstraction and its `PaymentProvider` contract.
>
> Furthermore, the Payment Core module is strictly responsible for transactional single-payment operations. Subscription management, recurring billing plans, entitlements, invoicing UI, tax calculation engines, and accounting/ledger features are **explicitly out of scope**.
>
> Webhook infrastructure boundary: Payment Core DOES NOT build a new webhook receiver or HTTP endpoint listener. It delegates webhook HTTP request handling, signature verification, and payload routing to the **Webhook Receiver Module** (or dedicated Stripe signature verifier). The Stripe Adapter provides a `parsePaymentEvent()` utility to normalize verified raw webhook payloads into standardized payment events.

### Host responsibilities vs module responsibilities

| Host does | Module does |
|---|---|
| Reads `process.env` / secret vaults | Never touches env — receives configuration via `PaymentCoreConfig` / `StripeAdapterConfig` |
| Injects Stripe secret keys & publishable keys | Encapsulates secrets into adapter API calls without logging sensitive keys |
| Receives HTTP webhooks & verifies signatures | Parses verified raw webhook payloads into normalized payment events |
| Stores domain business models (Orders, Customers) | Manages payment operation lifecycles & normalized states |
| Handles currency selection & UI checkout redirection | Enforces integer minor-unit amount validation & currency rules |
| Executes post-payment fulfillment logic | Normalizes provider responses, payment statuses, and structured errors |

---

## 2. Public API (exact signatures)

All public types, interfaces, and factory functions are exported from the module's entry points (`index.ts`, `core/index.ts`, and `adapters/index.ts`).

```ts
// core/service.ts
export function createPaymentCore(config: PaymentCoreConfig, provider: PaymentProvider): PaymentCore;

// PaymentCore Interface
export interface PaymentCore {
  createPayment(request: CreatePaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
  getPayment(paymentId: string, options?: PaymentOptions): Promise<PaymentResult>;
  refundPayment(request: RefundPaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
}

// adapters/stripe-adapter.ts
export function createStripeAdapter(config: StripeAdapterConfig): PaymentProvider & StripeAdapterExtensions;

export interface StripeAdapterExtensions {
  parsePaymentEvent(rawPayload: unknown): PaymentEventResult;
}

// adapters/mock-adapter.ts
export function createMockPaymentAdapter(config?: MockAdapterConfig): PaymentProvider;
```

### 2.1 Pipeline Guarantee

Every call to `createPayment()` and `refundPayment()` **MUST enforce pre-flight validation**:
1. **Amount Validation:** `assertValidAmount(request.amount)` ensures amounts are positive integers in minor units.
2. **Idempotency Key Enforcement:** Ensures `idempotencyKey` is non-empty before calling the provider adapter.
3. **Error Normalization:** All provider rejections or HTTP errors are caught and converted into structured `PaymentError` instances.

---

## 3. Exact Core Types

```ts
/** Standard monetary amount in integer minor units (e.g. 10000 = 100.00 THB, 1000 = $10.00 USD) */
export type MinorUnitAmount = number & { readonly __brand: unique symbol };

/** Supported ISO 4217 Currency Code */
export type CurrencyCode = 'THB' | 'USD' | 'EUR' | 'JPY' | 'GBP' | 'SGD' | 'AUD' | string;

/** Normalized payment status across all providers */
export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'cancelled';

/** Input request payload for creating a payment */
export type CreatePaymentRequest = {
  amount: number; // Integer minor units (e.g. 10000 = 100.00 THB)
  currency: string; // ISO 4217 3-letter currency code (e.g. 'THB', 'USD')
  referenceId: string; // Business internal reference ID (e.g. Order ID, Invoice ID)
  idempotencyKey: string; // Mandatory unique key for idempotency enforcement
  customerId?: string; // Optional host customer ID
  description?: string; // Human-readable description
  metadata?: Record<string, string>; // Arbitrary Key-Value string metadata
  returnUrl?: string; // Host redirect URL after hosted checkout completion
  cancelUrl?: string; // Host redirect URL if customer cancels hosted checkout
};

/** Input request payload for refunding a payment */
export type RefundPaymentRequest = {
  paymentId: string; // Core or provider payment ID
  idempotencyKey: string; // Mandatory unique key for refund idempotency
  amount?: number; // Optional partial refund amount in minor units; full refund if omitted
  reason?: string; // Reason for refund
  metadata?: Record<string, string>; // Optional metadata for refund
};

/** Options passed into payment service methods */
export type PaymentOptions = {
  timeoutMs?: number; // Request-level override timeout
  signal?: AbortSignal; // Abort signal for request cancellation
};

/** Uniform payment operation result contract returned to Host */
export type PaymentResult = {
  success: boolean;
  paymentId?: string; // Normalized payment identifier
  status?: PaymentStatus; // Core normalized status
  amount?: number; // Minor units amount
  currency?: string; // ISO 4217 Currency
  checkoutUrl?: string; // Hosted checkout page URL (if status === 'requires_action' or 'pending')
  clientSecret?: string; // Client token for frontend Stripe Elements (if applicable)
  provider?: string; // Provider name (e.g. 'stripe')
  providerReference?: string; // Provider's native ID (e.g. Stripe PaymentIntent ID 'pi_123')
  error?: PaymentError; // Structured error if success === false
  rawProviderMetadata?: Record<string, unknown>; // Sanitized non-sensitive metadata from provider
};

/** Payment Provider Interface contract implemented by provider adapters */
export interface PaymentProvider {
  readonly name: string;
  createPayment(request: CreatePaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
  getPayment(paymentId: string, options?: PaymentOptions): Promise<PaymentResult>;
  refundPayment(request: RefundPaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
}

/** Payment Event representation parsed from verified webhooks */
export type PaymentEvent = {
  eventId: string;
  eventType:
    | 'payment.succeeded'
    | 'payment.failed'
    | 'payment.processing'
    | 'payment.requires_action'
    | 'payment.refunded'
    | 'payment.cancelled'
    | 'unknown';
  paymentId: string;
  providerReference: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
  rawEvent?: unknown;
};

export type PaymentEventResult = {
  success: boolean;
  event?: PaymentEvent;
  error?: PaymentError;
};

/** Host Payment Core Configuration */
export type PaymentCoreConfig = {
  defaultCurrency?: string; // Default ISO 4217 currency (e.g. 'THB')
  supportedCurrencies?: string[]; // List of allowed ISO currencies (e.g. ['THB', 'USD', 'EUR'])
  maxAmountMinorUnits?: number; // Maximum allowed single transaction amount (e.g. 100000000 = 1,000,000 THB)
  minAmountMinorUnits?: number; // Minimum allowed single transaction amount (e.g. 1000 = 10.00 THB)
  hooks?: PaymentLoggingHooks;
};

/** Stripe Adapter Configuration injected from Host */
export type StripeAdapterConfig = {
  secretKey: string; // Stripe Secret API key (sk_test_... or sk_live_...)
  publishableKey?: string; // Stripe Publishable API key (pk_test_... or pk_live_...)
  webhookSecret?: string; // Stripe Webhook signing secret (whsec_...)
  apiVersion?: string; // Stripe API version pin (e.g. '2024-06-20')
  fetch?: typeof globalThis.fetch; // Host-injected fetch implementation for Workers runtime
  maxRetries?: number; // Adapter HTTP transport retry count (Default: 2)
  timeoutMs?: number; // Default timeout for Stripe API calls (Default: 10000ms)
  useCheckoutSession?: boolean; // True to use Stripe Checkout Sessions; False for PaymentIntent (Default: true)
};

/** Mock Adapter Configuration for Unit Testing */
export type MockAdapterConfig = {
  failOnCreate?: boolean;
  failOnRefund?: boolean;
  simulatedDelayMs?: number;
  initialPayments?: Record<string, PaymentResult>;
};

/** Telemetry and Logging Hooks */
export type PaymentLoggingHooks = {
  onPaymentStart?: (request: CreatePaymentRequest) => void;
  onPaymentSuccess?: (result: PaymentResult) => void;
  onPaymentFailure?: (error: PaymentError) => void;
};
```

---

## 4. Minor-Units Amount Rule & Money Validation Design

Monetary values in floating-point representations (`100.00`, `19.99`) are prone to binary floating-point inaccuracies in JavaScript (`0.1 + 0.2 === 0.30000000000000004`).

1. **Integer Minor Units Rule:**
   - ALL monetary amounts inside Payment Core and Provider contract MUST be expressed strictly as **positive integers representing minor units** (smallest currency unit, e.g., satang for THB, cents for USD/EUR, yen for JPY).
   - Examples:
     - `10000` = `100.00 THB`
     - `1999` = `$19.99 USD`
     - `500` = `¥500 JPY` (Note: JPY is a zero-decimal currency; minor unit factor = 1 JPY)
2. **Zero-Decimal vs Multi-Decimal Currencies:**
   - Standard 2-decimal currencies (`THB`, `USD`, `EUR`, `GBP`, `SGD`, `AUD`): minor unit factor = 100 (1 THB = 100 satang).
   - Zero-decimal currencies (`JPY`, `KRW`, `VND`): minor unit factor = 1 (1 JPY = 1 yen).
   - 3-decimal currencies (`BHD`, `KWD`, `OMR`): minor unit factor = 1000.
3. **Strict Validation Logic (`assertValidAmount`):**
   - Must be a finite number (`Number.isFinite(amount)`).
   - Must be a strict integer (`Number.isInteger(amount)`).
   - Must be strictly positive (> 0 for payment creation; > 0 for refund).
   - Must not exceed JavaScript's safe integer limit (`amount <= Number.MAX_SAFE_INTEGER`).
   - Must fall within `minAmountMinorUnits` and `maxAmountMinorUnits` if configured in `PaymentCoreConfig`.
   - If amount validation fails, Payment Core throws `PaymentError` with code `INVALID_AMOUNT`.

---

## 5. Normalized Payment States & Mapping Table

Payment Core defines 7 normalized lifecycle states:

1. `pending`: Payment record created; awaiting customer input or provider initiation.
2. `requires_action`: Customer interaction required (e.g., 3D-Secure authentication, redirect to Stripe Checkout URL, QR scan).
3. `processing`: Payment submitted to payment network; awaiting final settlement confirmation.
4. `succeeded`: Funds authorized and captured successfully.
5. `failed`: Payment attempt was declined, expired, or failed.
6. `refunded`: Payment was partially or fully refunded.
7. `cancelled`: Payment intent or session was explicitly voided/canceled prior to capture.

### Complete Stripe Status → Normalized Status Mapping Table

| Stripe Resource | Stripe Status | Payment Core Normalized Status | Notes / Description |
|---|---|---|---|
| PaymentIntent | `requires_payment_method` | `pending` / `requires_action` | Initial state or payment method declined; needs new payment method |
| PaymentIntent | `requires_confirmation` | `pending` | PaymentIntent ready to be confirmed |
| PaymentIntent | `requires_action` | `requires_action` | Customer must complete 3DS challenge or redirect |
| PaymentIntent | `processing` | `processing` | Funds being processed by bank/network |
| PaymentIntent | `requires_capture` | `requires_action` | Funds authorized, waiting host capture step |
| PaymentIntent | `succeeded` | `succeeded` | Payment successfully captured |
| PaymentIntent | `canceled` | `cancelled` | PaymentIntent explicitly canceled |
| Checkout Session | `open` | `pending` | Checkout session active, customer on hosted page |
| Checkout Session | `complete` (payment_status: `paid`) | `succeeded` | Checkout completed & payment verified |
| Checkout Session | `complete` (payment_status: `unpaid`) | `failed` / `pending` | Session completed without immediate payment |
| Checkout Session | `expired` | `cancelled` | Checkout session expired after 24 hours |
| Charge / Refund | `refunded` (or `amount_refunded > 0`) | `refunded` | Partial or full refund applied |

---

## 6. Idempotency Safety Design

Payment operations (especially payment creation and refunds) carry severe financial risks if retried blindly due to network timeouts or duplicate requests.

1. **Mandatory `idempotencyKey` Rule:**
   - Every call to `createPayment()` and `refundPayment()` MUST include a non-empty `idempotencyKey` string in the request object.
   - If `idempotencyKey` is missing or empty, Payment Core MUST throw `PaymentError` with code `MISSING_IDEMPOTENCY_KEY` before delegating to the provider.
2. **Provider Pass-Through (Stripe Adapter):**
   - The Stripe Adapter MUST pass `idempotencyKey` directly to Stripe API requests via the `Idempotency-Key` HTTP header (`Idempotency-Key: <key>`).
   - Stripe natively deduplicates requests sharing the same `Idempotency-Key` within 24 hours, returning the cached initial response without double-charging the customer card.
3. **Double-Request / Replay Handling:**
   - If host sends duplicate `createPayment` or `refundPayment` with the same `idempotencyKey`, Stripe returns the identical `PaymentIntent` or `Refund` object.
   - Core maps this response to `PaymentResult` with `success: true` and the existing `paymentId`, ensuring duplicate invocations are completely safe and side-effect-free.

---

## 7. Webhook & Event Parsing Architecture

1. **Architectural Isolation:**
   - Payment Core DOES NOT listen on raw HTTP routes or verify cryptographic webhook signatures directly.
   - The Host application receives raw HTTP webhook requests from Stripe and passes the raw payload + headers to the **Webhook Receiver Module** (or dedicated Stripe signature verifier).
2. **Stripe Adapter Event Parser (`parsePaymentEvent`):**
   - Once the Webhook Receiver Module verifies the Stripe signature (`Stripe-Signature` header against `webhookSecret`), it passes the parsed event JSON to `stripeAdapter.parsePaymentEvent(rawEvent)`.
   - `parsePaymentEvent` converts raw Stripe webhook payloads (e.g., `payment_intent.succeeded`, `checkout.session.completed`, `charge.refunded`) into standard `PaymentEvent` objects with normalized status and amount.
3. **Event Normalization Mapping:**

| Stripe Event Type | Mapped `eventType` | Extracted Status |
|---|---|---|
| `payment_intent.succeeded` | `payment.succeeded` | `succeeded` |
| `payment_intent.payment_failed` | `payment.failed` | `failed` |
| `payment_intent.processing` | `payment.processing` | `processing` |
| `payment_intent.amount_capturable_updated` | `payment.requires_action` | `requires_action` |
| `payment_intent.canceled` | `payment.cancelled` | `cancelled` |
| `checkout.session.completed` | `payment.succeeded` | `succeeded` |
| `checkout.session.expired` | `payment.cancelled` | `cancelled` |
| `charge.refunded` | `payment.refunded` | `refunded` |

---

## 8. Stripe Adapter Implementation Design

The Stripe Adapter (`adapters/stripe-adapter.ts`) implements `PaymentProvider`.

1. **Host Secret Injection (Zero Environment Access):**
   - `createStripeAdapter(config: StripeAdapterConfig)` accepts secrets explicitly via `config.secretKey`.
   - Core and Adapter NEVER touch `process.env.STRIPE_SECRET_KEY` directly. Secrets remain encapsulated inside host dependency injection.
2. **Stripe Hosted & Tokenized Flow Support:**
   - **Flow A: Stripe Checkout Session (Recommended for web host applications)**
     - Adapter creates a Stripe Checkout Session (`POST /v1/checkout/sessions`) with `line_items`, `mode: 'payment'`, `success_url`, `cancel_url`.
     - Returns `checkoutUrl: session.url` and `paymentId: session.id` inside `PaymentResult`. Status is `requires_action` / `pending`.
   - **Flow B: Direct PaymentIntent (For custom mobile/web UI with Stripe Elements)**
     - Adapter creates a Stripe PaymentIntent (`POST /v1/payment_intents`) with `amount`, `currency`, `automatic_payment_methods: { enabled: true }`.
     - Returns `clientSecret: intent.client_secret` and `providerReference: intent.id`.
3. **Stripe Direct HTTP / Lightweight SDK Compatibility:**
   - The adapter uses standard `fetch` Web API (injected via `config.fetch || globalThis.fetch`) to make HTTPS calls to `https://api.stripe.com/v1/*` with Form-UrlEncoded payloads or standard Stripe REST contract.
   - This guarantees 100% compatibility with **Cloudflare Workers**, Edge runtimes, and Node.js without relying on Node-specific native bindings.

---

## 9. Structured Errors & Normalization

All error conditions produce an instance of `PaymentError`.

```ts
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly status?: number; // HTTP status if applicable
  readonly retryable: boolean;
  readonly provider?: string; // e.g. 'stripe'
  readonly providerCode?: string; // Stripe error code e.g. 'card_declined'
  readonly providerDeclineCode?: string; // Stripe decline code e.g. 'insufficient_funds'
  readonly rawProviderError?: unknown;
  readonly cause?: unknown;

  constructor(options: {
    message: string;
    code: PaymentErrorCode;
    status?: number;
    retryable?: boolean;
    provider?: string;
    providerCode?: string;
    providerDeclineCode?: string;
    rawProviderError?: unknown;
    cause?: unknown;
  });
}

export type PaymentErrorCode =
  | 'INVALID_AMOUNT'
  | 'UNSUPPORTED_CURRENCY'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'PAYMENT_DECLINED'
  | 'INSUFFICIENT_FUNDS'
  | 'EXPIRED_CARD'
  | 'INVALID_CARD'
  | 'AUTHENTICATION_REQUIRED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NETWORK_ERROR'
  | 'PROVIDER_AUTHENTICATION_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'PAYMENT_NOT_FOUND'
  | 'REFUND_FAILED'
  | 'UNKNOWN_PAYMENT_ERROR';
```

### Error Code Semantics & Stripe Error Mapping

| PaymentErrorCode | Description / Trigger Condition | Default `retryable` | Stripe Error Type / Code Mapping |
|---|---|---|---|
| `INVALID_AMOUNT` | Amount is negative, non-integer, zero, or out of min/max bounds | `false` | Client-side validation before API call |
| `UNSUPPORTED_CURRENCY` | Currency code not supported by provider or core config | `false` | Client-side validation or Stripe `parameter_invalid_empty` |
| `MISSING_IDEMPOTENCY_KEY` | `idempotencyKey` missing on create or refund | `false` | Client-side pre-flight check |
| `PAYMENT_DECLINED` | Card or payment method declined by issuing bank | `false` | `card_error` / decline_code: `generic_decline`, `do_not_honor` |
| `INSUFFICIENT_FUNDS` | Card has insufficient balance | `false` | `card_error` / decline_code: `insufficient_funds` |
| `EXPIRED_CARD` | Payment card expired | `false` | `card_error` / decline_code: `expired_card` |
| `INVALID_CARD` | Card number, CVC, or expiry invalid | `false` | `card_error` / code: `incorrect_number`, `invalid_cvc` |
| `AUTHENTICATION_REQUIRED` | 3D-Secure 2 mandatory authentication failed | `false` | `card_error` / decline_code: `authentication_required` |
| `PROVIDER_TIMEOUT` | Provider API request timed out | `true` | Fetch timeout / AbortSignal trigger |
| `PROVIDER_NETWORK_ERROR` | DNS, TCP, or socket connection error to Stripe API | `true` | Fetch network exception (`TypeError: Failed to fetch`) |
| `PROVIDER_AUTHENTICATION_ERROR` | Invalid Stripe API Secret Key (401 Unauthorized) | `false` | `api_error` / HTTP status 401 |
| `PROVIDER_RATE_LIMITED` | Stripe API rate limit exceeded (HTTP status 429) | `true` | `rate_limit_error` / HTTP status 429 |
| `PROVIDER_SERVER_ERROR` | Stripe API 5xx internal server error | `true` | `api_error` / HTTP status 500, 502, 503, 504 |
| `PAYMENT_NOT_FOUND` | `getPayment()` with non-existent payment ID | `false` | `invalid_request_error` / code: `resource_missing` (404) |
| `REFUND_FAILED` | Refund request rejected (e.g. already fully refunded) | `false` | `invalid_request_error` / code: `charge_already_refunded` |
| `UNKNOWN_PAYMENT_ERROR` | Unmapped error condition | `false` | General unhandled exceptions |

---

## 10. Security Requirements

1. **Zero Direct Card Data Handling (PCI-DSS Compliance):**
   - Payment Core and Stripe Adapter MUST NEVER accept raw card numbers, CVV/CVC codes, or card expiration dates in request DTOs (`CreatePaymentRequest`).
   - Payments MUST use Stripe-hosted checkout flows (Stripe Checkout Sessions) or tokenized client-side payment methods (Stripe Elements `clientSecret` tokens).
2. **Zero Storage of CVV & Sensitive Auth Data:**
   - CVV/CVC codes and sensitive authentication data MUST NOT be accepted, passed, processed, or stored in any shape or form.
3. **Redaction of Payment Secrets & Sensitive Method Details:**
   - Secret API Keys (`sk_test_...`, `sk_live_...`), Webhook Secrets (`whsec_...`), client secrets, and customer payment method tokens MUST NEVER be logged to stdout, console, or external hooks.
   - All logging hooks (`onPaymentStart`, `onPaymentSuccess`, `onPaymentFailure`) receive sanitized result objects with sensitive tokens stripped or redacted (`"[REDACTED]"`).
4. **No Direct Environment Access:**
   - Payment Core and Provider Adapters MUST NOT read `process.env`, `globalThis.process.env`, or system environment variables. All secrets are explicitly injected by the Host via configuration objects.
5. **Cloudflare Workers & Edge Compatibility:**
   - Zero imports of Node built-in modules (`node:crypto`, `node:http`, `node:https`, `node:buffer`, `node:stream`).
   - Uses Web standard APIs exclusively (`fetch`, `Headers`, `Request`, `Response`, `AbortController`, `crypto.subtle`).

---

## 11. File Structure

The file structure matches the `http-client` module standard:

```
modules/payment/
├── MODULE.md
├── VERSION
├── package.json
├── tsconfig.json
├── index.ts
├── core/
│   ├── index.ts
│   ├── service.ts
│   ├── types.ts
│   ├── error.ts
│   ├── amount.ts
│   ├── state.ts
│   └── idempotency.ts
├── adapters/
│   ├── index.ts
│   ├── stripe-adapter.ts
│   └── mock-adapter.ts
├── tests/
│   ├── unit/
│   │   ├── service.test.ts
│   │   ├── amount.test.ts
│   │   ├── state.test.ts
│   │   ├── error.test.ts
│   │   └── idempotency.test.ts
│   └── adapters/
│       ├── stripe-adapter.test.ts
│       └── mock-adapter.test.ts
└── examples/
    └── integration.example.ts
```

---

## 12. Test Requirements (for Stage 3 Tester)

The test suite must be implemented using `vitest` in `tests/`. Downstream agents MUST verify every enumerated test case:

| Test File | Test Case Name | Assertion / Expected Outcome |
|---|---|---|
| `service.test.ts` | `create payment success` | Resolves `PaymentResult` with `success: true`, `status: 'pending'` or `'requires_action'`, valid `paymentId`, and `checkoutUrl` or `clientSecret`. |
| `service.test.ts` | `create failure` | When provider returns decline, resolves `PaymentResult` with `success: false` and structured `PaymentError` with code `PAYMENT_DECLINED`. |
| `service.test.ts` | `retrieve payment` | `getPayment(id)` returns `PaymentResult` with `paymentId`, normalized status, amount, and currency. |
| `service.test.ts` | `refund payment` | `refundPayment({ paymentId, amount, idempotencyKey })` returns `PaymentResult` with `status: 'refunded'`. |
| `idempotency.test.ts` | `double request/idempotency` | Dispatching two identical `createPayment` requests with the same `idempotencyKey` returns identical `paymentId` without duplicate processing. |
| `amount.test.ts` | `invalid amount` | Passing negative amount, floating-point number (e.g. `10.5`), or zero throws `PaymentError` with code `INVALID_AMOUNT`. |
| `service.test.ts` | `unsupported currency` | Requesting an unsupported currency code (e.g. `XYZ`) throws `PaymentError` with code `UNSUPPORTED_CURRENCY`. |
| `service.test.ts` | `provider timeout` | When provider call exceeds `timeoutMs`, request aborts and throws `PaymentError` with code `PROVIDER_TIMEOUT`. |
| `error.test.ts` | `error normalization` | Provider error structures (e.g. Stripe `card_declined`, `insufficient_funds`, `expired_card`) correctly map to normalized `PaymentErrorCode`. |
| `stripe-adapter.test.ts` | `stripe event parsing` | `parsePaymentEvent()` accurately parses verified Stripe `payment_intent.succeeded` webhook into normalized `PaymentEvent`. |
| `mock-adapter.test.ts` | `mock adapter sanity` | In-memory mock adapter correctly simulates success, decline, and refund states without network calls. |

> **NOTE:** Unit tests MUST use `mock-adapter.ts` or mocked HTTP transports first. Real Stripe API integration tests MUST be executed in separate integration test files (`tests/adapters/stripe-adapter.integration.test.ts`) requiring host-provided test keys (`sk_test_...`).

---

## 13. `integration.example.ts` Reference Shape

```ts
import { createPaymentCore, createStripeAdapter, PaymentError } from '../index.js';

// 1. Host injects Stripe configuration & secrets (e.g. from environment or secret vault)
const stripeAdapter = createStripeAdapter({
  secretKey: 'sk_test_mock_secret_key_for_example',
  publishableKey: 'pk_test_mock_pub_key_for_example',
  webhookSecret: 'whsec_mock_webhook_secret',
  apiVersion: '2024-06-20',
  fetch: globalThis.fetch, // Host passes fetch implementation
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

    // 4. Retrieve payment status
    if (paymentResult.paymentId) {
      console.log('\n--- Retrieving Payment ---');
      const retrieved = await paymentCore.getPayment(paymentResult.paymentId);
      console.log('Retrieved Status:', retrieved.status);
    }

    // 5. Refund payment (Partial refund of 50.00 THB = 5000 minor units)
    if (paymentResult.paymentId) {
      console.log('\n--- Refunding Payment ---');
      const refundResult = await paymentCore.refundPayment({
        paymentId: paymentResult.paymentId,
        amount: 5000, // 50.00 THB partial refund
        reason: 'Customer returned item',
        idempotencyKey: 'idemp_refund_order_20260812_001_v1',
      });
      console.log('Refund Success:', refundResult.success);
      console.log('Refund Status:', refundResult.status);
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
```

---

## 14. `package.json` and `tsconfig.json`

### `package.json`
```json
{
  "name": "@module-hub/payment",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "exports": {
    ".": "./index.ts",
    "./core": "./core/index.ts",
    "./adapters": "./adapters/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["**/*.ts"]
}
```

---

## 15. Explicit Non-Goals

The following features are **explicitly out of scope** for v0.1.0 of the Payment Core + Stripe Adapter module:

- **Subscription & Recurring Billing:** Handled exclusively by a separate Subscription module.
- **Plans & Entitlements:** Plan catalog, features entitlement checks, and usage limits belong to Entitlements/Catalog modules.
- **Invoice UI & PDF Generation:** Rendered exclusively by Host applications or specialized Invoicing modules.
- **Accounting & General Ledger:** Financial balance sheets, journal entries, and reconciliation tools.
- **Tax Calculation Engine:** Automated VAT/Sales Tax calculations (e.g. Stripe Tax / TaxJar integrations).
- **New Webhook Infrastructure:** Payment module DOES NOT create HTTP webhook endpoints or standalone webhook listener servers; relies on Webhook Receiver module.

---

## 16. Acceptance Criteria (for Stage 4 Reviewer)

A Stage 4 Reviewer MUST verify all of the following criteria before approving the module design & implementation:

1. [ ] **File Location:** Deliverable exists at `D:\AI-Workspace\projects\modules-hub\modules\payment\DESIGN.md`.
2. [ ] **Layered Abstraction:** Business Project interacts strictly through `PaymentCore` abstraction; zero direct calls to Stripe SDK scattered in business logic.
3. [ ] **Minor Units Amount Enforcement:** Amounts are strictly positive integers (e.g. `10000` = `100.00 THB`). Floating-point numbers throw `INVALID_AMOUNT`.
4. [ ] **Normalized States:** All provider-specific statuses map accurately to the 7 normalized states (`pending`, `requires_action`, `processing`, `succeeded`, `failed`, `refunded`, `cancelled`).
5. [ ] **Idempotency Enforcement:** `createPayment()` and `refundPayment()` require `idempotencyKey`; passed to Stripe via `Idempotency-Key` header.
6. [ ] **Stripe Adapter Configuration:** Secrets (`secretKey`) injected from Host via `StripeAdapterConfig`; zero direct environment variable reads (`process.env`).
7. [ ] **Tokenized & Hosted Flow Security:** Direct raw card data handling and CVV storage prohibited; relies on Stripe Checkout Sessions or Stripe Elements `clientSecret`.
8. [ ] **Webhook Handling Delegation:** Cryptographic signature verification delegated to Webhook Receiver Module; Stripe Adapter provides payload parsing via `parsePaymentEvent()`.
9. [ ] **Structured Error Normalization:** All failures normalized into `PaymentError` with exact error codes (`PAYMENT_DECLINED`, `INSUFFICIENT_FUNDS`, `PROVIDER_TIMEOUT`, etc.).
10. [ ] **Test Coverage Plan:** Test suite plan covers every required test in brief (create success/fail, retrieve, refund, idempotency, invalid amount, unsupported currency, timeout, error normalization).
11. [ ] **Runtime Compatibility:** Zero `node:*` imports; 100% compatible with Cloudflare Workers Web APIs runtime.
