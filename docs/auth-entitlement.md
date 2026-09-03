# Auth & Entitlement

This describes current behavior across extension + backend.

---

## 1) Auth model

BusinessFlow uses **server-issued opaque sessions** backed by Supabase identity.

- Provider authentication: Supabase (`backend/src/auth/supabase-provider.ts`)
- Session issuance/storage: `backend/src/domain/auth/service.ts`
- Session persistence: `backend/src/db/auth-repository.ts` (`auth_sessions` table)

## Session token format in extension/backend integration

- Extension login endpoint returns `sessionToken` (`/api/v1/auth/extension/login`)
- Extension sends `Authorization: Session <token>` to backend
- Backend hashes the token (`sha256Hex`) and resolves session record

(Implemented in `backend/src/domain/auth/service.ts` and extension manager in `src/background/auth-entitlement.ts`.)

---

## 2) Backend auth flow

## 2.1 Signup/login

Controllers: `backend/src/api/v1/auth/controller.ts`

- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/extension/login`

Service behavior (`AuthService`):

1. Authenticate against provider
2. Upsert user by provider identity
3. Ensure default account records (`free` subscription + `core.recording` entitlement)
4. Generate opaque session token
5. Encrypt provider access/refresh tokens before D1 persistence

## 2.2 Session validation and refresh

`AuthService.requireIdentity()`:

- Handles bearer mode (provider token introspection) and session mode
- Rejects revoked/expired sessions
- Refreshes provider access token when near expiry
- Revokes session on refresh failure/subject mismatch

## 2.3 Logout

- Best-effort upstream provider revoke
- Always marks local session revoked

---

## 3) Extension auth state machine

Implementation: `src/background/auth-entitlement.ts`, types in `src/core/auth.ts`.

Possible extension states:

- `signed_out`
- `signed_in`
- `checking_access`
- `access_active`
- `access_unavailable`
- `session_expired`

Stored local state:

- Session (`bf:auth:session`) with token + user + expiry
- Entitlement cache (`bf:auth:entitlement`) including stale/error flags
- Backend base URL config (`bf:auth:config`)
- Session-expired flag (`bf:auth:session-expired`)

Backend URL guardrails are enforced by code:

- HTTP only for localhost/127.0.0.1
- HTTPS allowed for BusinessFlow domains

---

## 4) Entitlement evaluation

Backend endpoint:

- `GET /api/v1/entitlement` → `EntitlementService.evaluate()`

Implementation: `backend/src/domain/entitlement/service.ts`

Decision inputs:

- user-level revocation (`users.access_revoked_at`)
- `billing.paid` entitlement row status
- latest subscription state + period bounds

Result includes:

- plan
- access `{granted, state, accessUntil}`
- authorization timing policy (`refreshAfterSeconds`, `cacheMaxAgeSeconds`, `offlineGraceSeconds`)
- `entitlementVersion`

## Access policy implemented

- `active` / `trialing` => granted
- `canceled` / `paused` / `past_due` => denied
- time-expired period => `expired`
- explicit user revoke => `revoked`

---

## 5) Client-side cache and offline behavior

`refreshEntitlement()` behavior in `src/background/auth-entitlement.ts`:

- Uses backend policy fields to control refresh/cache/grace behavior
- On backend fetch failure:
  - can continue with stale cached entitlement if within maxAge + offlineGrace window
  - otherwise state becomes `access_unavailable`
- On 401: clears auth and marks session expired

Important: backend is authoritative; cache is UX continuity only.

---

## 6) Security controls currently present

From implementation:

- Session cookie support for web flow (`HttpOnly`, `Secure` outside local, `SameSite=Lax`) in `auth/controller.ts`
- Opaque token hashing in DB (`session_token_hash`)
- Provider tokens encrypted at rest in D1
- Route-level identity checks (`authService.requireIdentity`)
- Basic rate limits on auth and billing webhook endpoints
- CORS and security headers applied in app middleware (`app.ts`, `http/*`)

---

## 7) Relevant files

- Extension auth manager: `src/background/auth-entitlement.ts`
- Shared auth types: `src/core/auth.ts`
- Backend auth controller: `backend/src/api/v1/auth/controller.ts`
- Auth service: `backend/src/domain/auth/service.ts`
- Auth repository: `backend/src/db/auth-repository.ts`
- Entitlement controller: `backend/src/api/v1/entitlement/controller.ts`
- Entitlement service: `backend/src/domain/entitlement/service.ts`
- Entitlement repository: `backend/src/db/entitlement-repository.ts`
- Env policy: `backend/src/config/env.ts`
- Schema: `backend/migrations/0002_auth_foundation.sql`, `0004_entitlement_authorization.sql`