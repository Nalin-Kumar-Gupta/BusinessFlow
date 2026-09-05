# BusinessFlow Backend (Phase 3 Billing Sandbox Foundation)

Cloudflare Worker backend with:

- versioned API routes (`/api/v1/...`)
- Supabase Auth integration (email/password signup + login)
- server-managed opaque sessions via secure HTTP-only cookies
- Paddle sandbox checkout initiation
- signed Paddle webhook processing with idempotency + retry safety
- D1-backed subscription lifecycle state (`users -> subscriptions -> entitlements`)

## Run locally

1. Copy vars:

```bash
cp backend/.dev.vars.example backend/.dev.vars
```

2. Create a local D1 DB and update `backend/wrangler.toml` IDs.

3. Apply migrations:

```bash
cd backend
npx wrangler d1 migrations apply businessflow_local --local
```

4. Start worker:

```bash
cd backend
npx wrangler dev
```

## API routes

- `GET /api/v1/health`
- `POST /api/v1/health`
- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/forgot-password`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/extension/login`
- `POST /api/v1/auth/extension/logout`
- `GET /api/v1/account`
- `POST /api/v1/billing/checkout`
- `POST /api/v1/billing/portal`
- `POST /api/v1/billing/webhook`
- `GET /api/v1/entitlement`

## Security notes

- Passwords are handled by Supabase Auth (never stored in BusinessFlow DB).
- Paddle API and webhook secrets stay server-side only.
- Webhook state is authoritative for subscription state.
- Paddle webhook verification uses Paddle SDK `webhooks.unmarshal(rawBody, webhookSecret, signature)` and never parses JSON before verification.
- Access/refresh tokens are stored server-side encrypted at rest in D1.
- Browser receives only an opaque session cookie (`HttpOnly`, `Secure` outside local).

## Scope limits

- Paddle **sandbox only** in this phase (`PADDLE_ENV=sandbox` enforced).
- No production billing switch.
- No card-level payment data stored.

## Entitlement policy (for extension integration)

The backend is authoritative. Client-side checks are UX only.

- `active` + `trialing`: paid access granted.
- `canceled`: paid access revoked immediately.
- `paused` + `past_due`: paid access revoked (explicit BusinessFlow policy).
- Scheduled cancellation/change metadata is stored for reconciliation but does not revoke access while status remains `active`.
- Revalidate entitlement every `ENTITLEMENT_REFRESH_INTERVAL_SECONDS` (default 300s).
- A cached entitlement should not be trusted past `ENTITLEMENT_CACHE_MAX_AGE_SECONDS` (default 900s).
- If backend is temporarily unavailable, allow stale cache only up to `ENTITLEMENT_OFFLINE_GRACE_SECONDS` (default 900s), then disable paid UX until revalidated.
- On logout, clear entitlement cache immediately.
- Any 401/403 from backend invalidates cached paid access immediately.
