# BusinessFlow Docs

No archaeology required. Start here.

## Documents

- [`architecture.md`](./architecture.md)
  - High-level system map (MV3 extension + Cloudflare Worker backend)
  - Main runtime paths and storage boundaries
- [`auth-entitlement.md`](./auth-entitlement.md)
  - Session auth model, extension auth cache, entitlement lifecycle
- [`paddle-billing.md`](./paddle-billing.md)
  - Paddle sandbox integration, webhook processing, DB mapping
- [`exports.md`](./exports.md)
  - Export pipeline: storage → canonical model → PDF/Word/Excel/clipboard
- [`dev-workflow.md`](./dev-workflow.md)
  - Day-to-day setup, build/test loop, local backend + extension workflow

## Grounding policy

These docs are based on current implementation, not wishlist behavior.
Every major section points to concrete files in `src/` or `backend/src/`.
If behavior changes, update docs in the same PR.