# Paddle Billing (Sandbox)

Current implementation notes for BusinessFlow billing.

---

## 1) Scope and mode

Billing is sandbox-only right now.

Enforced in config parser (`backend/src/config/env.ts`):

- `PADDLE_ENV` must be `sandbox`
- `PADDLE_CLIENT_TOKEN` must start with `test_`

Any non-sandbox mode is rejected at startup.

---

## 2) API endpoints used

From `backend/src/api/router.ts` and billing controller:

- `GET /api/v1/billing/catalog`
- `POST /api/v1/billing/checkout`
- `POST /api/v1/billing/portal`
- `POST /api/v1/billing/webhook`

Extension interactions:

- Dashboard/Pricing modal requests catalog + checkout via runtime messages
- Background auth manager calls backend directly (`src/background/auth-entitlement.ts`)

---

## 3) Catalog + checkout flow

Catalog generation (`BillingService.getCatalog`):

- Tiers: `starter`, `pro`, `advanced`
- Intervals: monthly/yearly
- Price IDs come from env JSON mapping (`PADDLE_PRICE_IDS_JSON`)

Checkout (`BillingService.startCheckout`):

1. Validate plan key exists in configured map
2. Resolve authenticated user
3. Create Paddle checkout via `PaddleApiClient`
4. Return checkout ID + URL + selected plan metadata

Files:

- `backend/src/domain/billing/service.ts`
- `backend/src/billing/paddle-client.ts`
- `backend/src/api/v1/billing/controller.ts`

---

## 4) Webhook processing model

Controller (`handlePaddleWebhook`) does:

1. Rate-limit
2. Verify signature (`verifyPaddleWebhookSignature`)
3. Pass verified payload to `BillingService.processWebhookEvent`

Service behavior (`processWebhookEvent`):

- Claims webhook event idempotently in `paddle_webhook_events`
- Ignores already processed duplicates
- Supports mapped event families:
  - customer created/updated
  - transaction completed/payment_failed
  - subscription created/updated/canceled
- Resolves BusinessFlow user association by user hint, subscription ownership, customer id, or email (depending on event shape)
- Upserts subscription row with event-time ordering guard
- Updates `billing.paid` entitlement active/inactive based on status
- Marks webhook processed or failed

Files:

- `backend/src/api/v1/billing/controller.ts`
- `backend/src/domain/billing/service.ts`
- `backend/src/domain/billing/webhook-events.ts`
- `backend/src/domain/billing/webhook-mapper.ts`
- `backend/src/db/billing-repository.ts`

---

## 5) Access policy tied to billing status

Implemented policy in `BillingService` + `EntitlementService`:

- `active`, `trialing` => paid entitlement enabled
- `canceled`, `paused`, `past_due` => paid entitlement disabled
- Scheduled changes are stored for reconciliation but do not automatically revoke while subscription status remains active/trialing

---

## 6) D1 schema impact

Migrations defining billing persistence:

- `0003_paddle_billing.sql`
  - Adds Paddle IDs/fields on users and subscriptions
  - Creates `paddle_webhook_events`
- `0004_paddle_subscription_reconciliation.sql`
  - Adds `first_billed_at`, `next_billed_at`
  - Adds scheduled change fields

Important persistent fields include:

- `users.paddle_customer_id`
- `subscriptions.paddle_subscription_id`, `status`, `plan_code`, period fields, scheduled change fields, `last_event_time`
- `entitlements` row for `billing.paid`

---

## 7) Pricing modal integration

UI file: `src/ui/dashboard/PricingModal.tsx`

Behavior visible in code:

- Fetches catalog + auth status
- Requires sign-in before checkout
- Verifies checkout plan/price consistency before opening Paddle flow
- Shows sandbox caveat and webhook-finalization messaging

---

## 8) Operational helper script

`backend/scripts/setup-paddle-notification-destination.mjs`:

- Creates/updates sandbox notification destination
- Subscribes required billing/customer events
- Outputs endpoint secret key for backend config

---

## 9) Relevant files

- Backend config: `backend/src/config/env.ts`
- Billing controller/service/repo:
  - `backend/src/api/v1/billing/controller.ts`
  - `backend/src/domain/billing/service.ts`
  - `backend/src/db/billing-repository.ts`
- Paddle client/signature:
  - `backend/src/billing/paddle-client.ts`
  - `backend/src/billing/webhook-signature.ts`
- Migrations:
  - `backend/migrations/0003_paddle_billing.sql`
  - `backend/migrations/0004_paddle_subscription_reconciliation.sql`
- Extension integration:
  - `src/background/auth-entitlement.ts`
  - `src/ui/dashboard/PricingModal.tsx`