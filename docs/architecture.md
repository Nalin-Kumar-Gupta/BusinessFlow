# Architecture

This is the current architecture of BusinessFlow as implemented.

---

## 1) Runtime topology

## Chrome Extension (MV3)

- Manifest: `src/manifest.json`
- Build entrypoints: `build.mjs`
- Main runtime parts:
  - **Background service worker**: `src/background/index.ts`
  - **Content scripts**: `src/content/*`
  - **UI surfaces**:
    - Side panel: `src/ui/panel/main.tsx`
    - Dashboard: `src/ui/dashboard/main.tsx`
    - Report/options pages under `src/ui/*`

## Backend (Cloudflare Worker)

- Worker entry: `backend/src/worker.ts`
- App composition: `backend/src/app.ts`
- Route dispatcher: `backend/src/api/router.ts`
- Storage: Cloudflare D1 (`backend/migrations/*.sql`)

---

## 2) Extension architecture

## 2.1 Service worker responsibilities

`src/background/index.ts` is the orchestration hub:

- Registers Chrome listeners synchronously at top-level (MV3-safe)
- Coordinates session lifecycle (`startSession`, `stopSession`, pause/resume)
- Ingests network/nav/content signals
- Persists sessions/events/steps/blobs/network logs via storage layer
- Handles runtime message API consumed by dashboard/panel UI
- Integrates auth/entitlement manager (`src/background/auth-entitlement.ts`)

Key collaborators:

- Session orchestration: `src/background/session.ts`, `session-flow.ts`
- Capture pipeline: `src/background/screenshot.ts`
- Observers:
  - Network: `src/background/net-observer.ts`
  - Navigation: `src/background/nav-observer.ts`
  - Content events: `src/background/content-events.ts`
- Injection logic: `src/background/inject.ts`

## 2.2 Storage boundaries

Primary local storage lives in IndexedDB (`src/storage/db.ts`):

- `sessions`
- `events`
- `steps`
- `blobs`
- `network-logs`
- `documents`

Feature catalog metadata is in `chrome.storage.local` (`tt:featureCatalog`).

Auth/entitlement cache also uses `chrome.storage.local` via `src/background/auth-entitlement.ts` keys:

- `bf:auth:session`
- `bf:auth:entitlement`
- `bf:auth:config`
- `bf:auth:session-expired`

## 2.3 UI architecture

The dashboard (`src/ui/dashboard/main.tsx`) is the main operator surface and handles:

- Feature/session browsing
- Step/dev trace views
- Export modal orchestration (PDF/Word/Excel/.bflow + copy evidence)
- Pricing modal launch and post-checkout UX messaging

Structured exports are delegated to `src/ui/export/*` modules, not built inline in the dashboard.

---

## 3) Backend architecture

## 3.1 Request flow

1. `worker.ts` exports `createApp().fetch`
2. `app.ts`:
   - loads config (`config/env.ts`)
   - constructs services/repositories/providers
   - applies CORS + security headers
   - dispatches to `routeRequest`
3. `api/router.ts` performs path/method routing to controllers
4. Controllers call domain services
5. Domain services call repositories + external providers (Supabase/Paddle)

This is a clean controller → service → repository split.

## 3.2 Services and repositories

- Auth:
  - Service: `backend/src/domain/auth/service.ts`
  - Repo: `backend/src/db/auth-repository.ts`
  - Provider: `backend/src/auth/supabase-provider.ts`
- Billing:
  - Service: `backend/src/domain/billing/service.ts`
  - Repo: `backend/src/db/billing-repository.ts`
  - Paddle API client: `backend/src/billing/paddle-client.ts`
- Entitlement:
  - Service: `backend/src/domain/entitlement/service.ts`
  - Repo: `backend/src/db/entitlement-repository.ts`

## 3.3 API surface (current)

Defined in `backend/src/api/router.ts`:

- `/api/v1/health` (GET/POST)
- `/api/v1/auth/*`
- `/api/v1/account`
- `/api/v1/billing/*`
- `/api/v1/entitlement`

---

## 4) Data model snapshot

## 4.1 Extension capture domain

Core types are in `src/core/types.ts`:

- `Session`
- `Step`
- `TestEvent` union (`navigation`, `console_error`, `page_error`, `evidence_stored`, etc.)
- `NetworkLog`

This model drives both dashboard UX and export projection.

## 4.2 Backend account/billing domain (D1)

Migrations:

- `0001_initial.sql` — metadata table
- `0002_auth_foundation.sql` — users/auth_sessions/subscriptions/entitlements
- `0003_paddle_billing.sql` — Paddle IDs + webhook event table
- `0004_entitlement_authorization.sql` — access revocation columns on users
- `0004_paddle_subscription_reconciliation.sql` — scheduled change / billing date fields

---

## 5) Design intent visible in code

- Export pipeline is explicitly projection-based (`buildCanonicalExportModel`) and renderer-agnostic.
- Blob bytes are lazy-loaded at renderer boundary (`src/ui/export/pdf/blob-loader.ts`).
- Feature exports are composition of canonical session models (`src/ui/export/feature-model.ts`), not ad-hoc aggregation inside renderers.
- Backend enforces sandbox-only Paddle mode in current phase (`backend/src/config/env.ts`).