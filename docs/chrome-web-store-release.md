# Chrome Web Store Release Checklist

Use this before every BusinessFlow upload.

## 1) Permissions & capture behavior

- `manifest.json` uses:
  - `permissions`: `activeTab`, `tabs`, `scripting`, `webNavigation`, `webRequest`, `storage`, `sidePanel`, `unlimitedStorage`
  - `optional_host_permissions`: `"<all_urls>"`
- Runtime capture requires host permission. The panel requests permission from a **user gesture** before session start / manual capture.
- If permission is denied, UI shows a direct action message.

## 2) CWS listing disclosures (required)

In the Chrome Web Store listing, explain clearly:

- Why broad host access is requested:
  - "BusinessFlow captures user-approved QA screenshots and UI events for test evidence across arbitrary web apps during active sessions only."
- Data handling:
  - local-first storage
  - no automatic telemetry upload
  - manual export only

## 3) QA smoke test before upload

1. Load unpacked `dist/` extension
2. Open side panel
3. Start recording on any HTTPS page
4. Accept site access prompt
5. Capture evidence manually
6. Reload the page and verify capture still works
7. Stop session and verify screenshots appear in dashboard timeline

## 4) Packaging guardrails

- Rebuild before packaging: `pnpm build`
- Validate generated manifest in `dist/manifest.json`
- Never ship with placeholder secrets in backend deployment configs

## 5) Rejection-risk reducers

- Keep permission rationale concise and truthful in listing
- Do not imply passive always-on recording
- Keep screenshots/videos in listing focused on explicit tester actions (start/pause/capture/stop)
