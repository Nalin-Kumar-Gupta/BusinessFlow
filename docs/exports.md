# Exports

This doc maps the current export system end-to-end.

---

## 1) Core export pipeline

For PDF/Word/Excel/Clipboard, the pipeline is:

1. **Session bundle fetch**
   - `getSessionExportData(sessionId)` in `src/storage/db.ts`
   - Returns: `session`, `events`, `steps`, `networkLogs`, `blobs` (metadata)
2. **Canonical projection**
   - `buildCanonicalExportModel()` in `src/export/model/build-projection.ts`
   - Input type: `SessionExportInput` from `src/export/model/canonical.ts`
3. **Scope model selection** (single test case vs feature aggregate)
   - `buildTestCaseExportModel` / `buildFeatureExportModel` in `src/ui/export/scope-models.ts`
   - Feature aggregate model composed by `buildFeatureCanonicalModel` in `src/ui/export/feature-model.ts`
4. **Format-specific view model**
   - PDF: `preparePdfProps`
   - Word: `prepareWordProps`
   - Excel: `prepareExcelProps`
   - Clipboard: `buildClipboardEvidenceView` + `renderClipboardEvidence`
5. **Artifact generation**
   - PDF: `@react-pdf/renderer` + `QaReportPdf`
   - Word: `docx` via `generateWordDocx`
   - Excel: `exceljs` via `generateExcelWorkbook`
   - Clipboard: `navigator.clipboard.write` (`text/html` + `text/plain`)

---

## 2) Export triggers and orchestration

Primary UI orchestration is in `src/ui/dashboard/main.tsx`:

- `exportPdf`, `exportWord`, `exportExcel`
- `runUnifiedExport`
- `handleCopyEvidence`
- filename builders:
  - `buildSessionExportFilename`
  - `buildFeatureExportFilename`

Export scope support:

- single selected session
- latest run per test case
- all runs in feature (where applicable)

Preflight UX:

- `buildExportPreflightSummary` from `src/ui/dashboard/export-ux.ts`

---

## 3) Canonical model shape (source of truth)

Defined in `src/export/model/canonical.ts` (`CanonicalExportModel`):

- `meta` (generatedAt, generator info, correlation version, session id)
- `overview` (feature/test case identity, verdict, negative test context)
- `environment` (timing, UA/platform, viewport, scope origins, SLA)
- `stats` (steps/findings/network/console/user signals/performance rollups)
- `sections[]` with `steps[]`
- `findings[]`
- `appendix` (network, console warnings, performance samples, DOM/CSP/checkpoints/nav/capture timeline)

Key design principles (in file comments) are intentional:

- renderer-agnostic model
- screenshots as blob references (`blobKey`) until render time
- annotations stored as metadata (not burned into image bytes)
- temporal correlation language, not causal claims

---

## 4) Blob loading and screenshot handling

- Blob metadata is loaded in `getSessionExportData`
- Actual blob bytes loaded lazily by render path (shared loader):
  - `src/ui/export/pdf/blob-loader.ts`
- Loader behavior:
  - sequential loading by design to reduce transient memory pressure
  - failed/missing blobs don’t hard-fail export; placeholders are expected downstream

Clipboard renderer sizing behavior (`render-clipboard.ts`):

- target bounds: **450 x 396 px**
- uses intrinsic dimensions when available and scales to fit
- keeps original stored screenshot untouched

---

## 5) PDF export

Entry: `src/ui/export/pdf/export-session-pdf.ts`

- `buildSessionPdf` / `buildFeaturePdf`
- transforms canonical model to `PdfViewModel` (`prepare-pdf-props.ts`)
- renders via `QaReportPdf.tsx`

Notable implementation details:

- includes cover, environment, execution stats, step story, findings, appendix, footer
- tracks missing screenshot count for UX messaging
- supports feature scope summaries + per-test-case sections

---

## 6) Word export

Entry: `src/ui/export/word/export-session-word.ts`

- `prepareWordProps` maps canonical model to Word view model
- `generateWordDocx` writes final `.docx`

Includes:

- cover + identity + verdict + environment + execution summary
- execution story with before/after images
- findings + selected technical evidence + appendix
- feature-scope summary block when exporting aggregate model

---

## 7) Excel export

Entry: `src/ui/export/excel/export-session-excel.ts`

- `prepareExcelProps` creates workbook data projection
- `generateExcelWorkbook` writes `.xlsx`

Current workbook model includes datasets for:

- summary
- feature cases (feature scope)
- steps
- findings
- technical signals
- network
- console errors/signals
- evidence references
- performance metrics
- session metadata/history

---

## 8) Clipboard export

Entry: `src/ui/export/clipboard/copy-evidence.ts`

Flow:

1. build scope model
2. build clipboard evidence view (`clipboard-view-model.ts`)
3. resolve image data URLs
4. render HTML + plain text (`render-clipboard.ts`)
5. write clipboard payload
   - preferred: `text/html` + `text/plain`
   - fallback: plain text only

This path is intentionally evidence-focused rather than full session archival.

---

## 9) Feature vs test-case export model behavior

- Single session path uses canonical model directly
- Feature export path:
  - builds canonical model per session
  - merges into feature canonical aggregate (`feature-model.ts`)
  - flattens steps with global index remapping
  - retains per-section/test-case metadata for renderers

---

## 10) Key files

- Canonical projection:
  - `src/export/model/canonical.ts`
  - `src/export/model/build-projection.ts`
- Scope composition:
  - `src/ui/export/scope-models.ts`
  - `src/ui/export/feature-model.ts`
- Format exports:
  - PDF: `src/ui/export/pdf/*`
  - Word: `src/ui/export/word/*`
  - Excel: `src/ui/export/excel/*`
  - Clipboard: `src/ui/export/clipboard/*`
- UI trigger/orchestration:
  - `src/ui/dashboard/main.tsx`
- Storage bundle fetch:
  - `src/storage/db.ts` (`getSessionExportData`)