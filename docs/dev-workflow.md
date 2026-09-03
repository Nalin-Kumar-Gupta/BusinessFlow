# Dev Workflow

Fast path for building, testing, and running BusinessFlow locally.

---

## 1) Prereqs

- Node + pnpm
- Chrome (for extension runtime)
- Cloudflare Wrangler (for backend worker dev)
- Supabase project creds + Paddle sandbox creds for full auth/billing flow

---

## 2) Install and baseline checks

From repo root:

```bash
pnpm install
pnpm typecheck
pnpm typecheck:backend
pnpm lint
pnpm test
```

Script source: `package.json`.

---

## 3) Build extension

Production build:

```bash
pnpm build
```

Watch/dev build:

```bash
pnpm watch
# or
pnpm build:dev
```

Build system:

- `build.mjs` bundles multiple entrypoints with esbuild
- output goes to `dist/`
- dashboard build uses ESM splitting for chunks

---

## 4) Load extension in Chrome

1. `chrome://extensions`
2. Enable Developer Mode
3. Load unpacked extension from `dist/`
4. Use dashboard at generated extension page (`ui/dashboard/dashboard.html`)

Manifest + runtime context:

- `src/manifest.json`
- background worker: `dist/background/index.js`

---

## 5) Run local backend

## 5.1 Configure env

```bash
cp backend/.dev.vars.example backend/.dev.vars
```

Fill required values (Supabase + Paddle sandbox + encryption key).

## 5.2 D1 setup + migrations

```bash
cd backend
npx wrangler d1 migrations apply businessflow_local --local
```

Migration files live in `backend/migrations/`.

## 5.3 Start worker

```bash
cd backend
npx wrangler dev
```

Default extension backend URL is `http://localhost:8787` (`src/background/auth-entitlement.ts`).

---

## 6) Typical iteration loops

## Frontend/extension loop

1. `pnpm watch`
2. Reload extension after changes
3. Reproduce in dashboard/panel
4. Run targeted unit/e2e checks

## Backend loop

1. Update `backend/src/*`
2. Restart `wrangler dev` if needed
3. Hit `/api/v1/health` and relevant auth/billing routes
4. Re-run backend typecheck

---

## 7) Tests

## Unit tests

```bash
pnpm test
```

- Vitest config: `vitest.config.ts`
- Node env, focused on unit logic (not Chrome APIs)

## E2E tests

```bash
pnpm e2e
```

- Playwright config: `playwright.config.ts`
- Uses built extension from `dist/`
- Starts fixture server (`node fixture/server.mjs`)
- Project runs Chromium with extension args

---

## 8) Verification commands

Full local verification chain:

```bash
pnpm verify
```

Equivalent to:

- `pnpm typecheck`
- `pnpm typecheck:backend`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

---

## 9) Export-system specific smoke checks

After export-related changes:

1. Open dashboard
2. Load a feature/session with evidence
3. Validate:
   - PDF export
   - Word export
   - Excel export
   - Copy evidence to rich editor + plain text target
4. Confirm missing screenshot handling still graceful

Relevant code paths:

- `src/ui/dashboard/main.tsx`
- `src/ui/export/*`
- `src/export/model/*`

---

## 10) Common gotchas

- Extension auth can look "signed in but no access" if backend entitlement endpoint is stale/unreachable.
- Billing activation depends on webhook processing; checkout completion alone is not final entitlement activation.
- Export paths are model-driven; avoid injecting renderer-specific logic into canonical projection layer.

---

## 11) File references

- Scripts/build: `package.json`, `build.mjs`
- Manifest/runtime: `src/manifest.json`, `src/background/index.ts`
- Backend setup: `backend/README.md`, `backend/wrangler.toml`, `backend/.dev.vars.example`
- Testing: `vitest.config.ts`, `playwright.config.ts`