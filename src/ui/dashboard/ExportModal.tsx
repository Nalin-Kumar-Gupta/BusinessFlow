import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';

import {
  EXPORT_FORMATS,
  formatScopeCopy,
  isFormatSessionScoped,
} from './export-ux.js';
import type {
  ExportFormat,
  ExportModalContext,
  ExportPreflightSummary,
  SessionSelectionMode,
} from './export-ux.js';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ExportModalProps {
  context: ExportModalContext;
  isOpen: boolean;
  selectedFormat: ExportFormat;
  selectionMode: SessionSelectionMode;
  canUseSelectedRun: boolean;
  canUseLatestRun: boolean;
  hasAnyExportableData: boolean;
  preflight: ExportPreflightSummary | null;
  isPreflighting: boolean;
  isExporting: boolean;
  isCopyingEvidence: boolean;
  exportStatusText: string | null;
  onSelectFormat: (format: ExportFormat) => void;
  onSelectMode: (mode: SessionSelectionMode) => void;
  onConfirm: () => void;
  onCopyEvidence: () => void;
  canCopyEvidence: boolean;
  onClose: () => void;
}

export function ExportModal({
  context,
  isOpen,
  selectedFormat,
  selectionMode,
  canUseSelectedRun,
  canUseLatestRun,
  hasAnyExportableData,
  preflight,
  isPreflighting,
  isExporting,
  isCopyingEvidence,
  exportStatusText,
  onSelectFormat,
  onSelectMode,
  onConfirm,
  onCopyEvidence,
  canCopyEvidence,
  onClose,
}: ExportModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleIdRef = useRef(`export-modal-title-${Math.random().toString(36).slice(2, 8)}`);
  const bodyIdRef = useRef(`export-modal-body-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    if (!isOpen) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isExporting && !isCopyingEvidence) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((node) => !node.hasAttribute('disabled'));
      if (focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [isCopyingEvidence, isExporting, isOpen, onClose]);

  if (!isOpen) return null;

  const selectedDefinition = EXPORT_FORMATS.find((option) => option.format === selectedFormat) || EXPORT_FORMATS[0]!;
  const isFeatureContext = context === 'feature';
  const sessionScoped = isFormatSessionScoped(selectedFormat);
  const reportFormats = EXPORT_FORMATS.filter((option) => option.scopeLabel === 'Run export');
  const archiveFormats = EXPORT_FORMATS.filter((option) => option.scopeLabel === 'Feature archive');

  const noValidRun = sessionScoped && (
    isFeatureContext
      ? (!canUseLatestRun && selectionMode !== 'all') || (!hasAnyExportableData && selectionMode === 'all')
      : !(selectionMode === 'selected' ? canUseSelectedRun : canUseLatestRun)
  );

  const disabledConfirm = isExporting || isCopyingEvidence || isPreflighting || !hasAnyExportableData || noValidRun;

  return (
    <div class="modal-overlay" onClick={() => (!isExporting && !isCopyingEvidence ? onClose() : undefined)}>
      <div
        class="modal-content export-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
        aria-describedby={bodyIdRef.current}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div id={titleIdRef.current} class="modal-title">{isFeatureContext ? 'Feature exports' : 'Test case exports'}</div>
        <div id={bodyIdRef.current} class="modal-body">
          {isFeatureContext
            ? 'Copy evidence for tickets and chat first, then download reports or a full .bflow archive.'
            : 'Copy evidence for tickets and chat first, then download your report.'}
        </div>

        <section class="export-copy-evidence-row" aria-label="Quick share">
          <div class="export-copy-evidence-top">
            <strong>1) Copy Evidence</strong>
            <span class="badge badge-success">Fastest</span>
          </div>
          <p class="export-copy-evidence-help">
            {context === 'feature'
              ? 'Copies a feature summary with per-test-case results, top findings, and representative screenshots.'
              : 'Copies test details, result, key steps, findings, technical evidence, and relevant screenshots.'}
          </p>
          <button class="btn btn-primary export-copy-btn" onClick={onCopyEvidence} disabled={isCopyingEvidence || isExporting || !canCopyEvidence}>
            {isCopyingEvidence ? 'Copying evidence…' : (context === 'feature' ? 'Copy feature evidence' : 'Copy evidence')}
          </button>
        </section>

        <section class="export-section" aria-label="Download reports">
          <div class="export-section-head">
            <strong>2) Download reports</strong>
            <span class="export-section-subtle">PDF, Word, and Excel for sharing or triage</span>
          </div>
          <div class="export-format-list" role="radiogroup" aria-label="Report format">
            {reportFormats.map((option) => (
              <label key={option.format} class={`export-format-card ${selectedFormat === option.format ? 'selected' : ''} ${option.format === 'pdf' ? 'priority' : ''}`}>
                <input
                  type="radio"
                  name="export-format"
                  checked={selectedFormat === option.format}
                  onChange={() => onSelectFormat(option.format)}
                />
                <div class="export-format-card-main">
                  <div class="export-format-card-top">
                    <strong>{option.label}</strong>
                    {option.recommendedForMostTesters && <span class="badge badge-muted">Recommended</span>}
                  </div>
                  <div class="export-format-help">{option.shortHelp}</div>
                  <div class="export-format-meta">Contains: {option.containsLabel}</div>
                  <div class="export-format-meta">Scope: {option.scopeLabel}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        {isFeatureContext && archiveFormats.length > 0 && (
          <section class="export-section export-section-archive" aria-label="Portability archive">
            <div class="export-section-head">
              <strong>3) Portability</strong>
              <span class="export-section-subtle">Use only when you need full re-importable data</span>
            </div>
            <div class="export-format-list export-format-list--archive" role="radiogroup" aria-label="Archive format">
              {archiveFormats.map((option) => (
                <label key={option.format} class={`export-format-card ${selectedFormat === option.format ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="export-format"
                    checked={selectedFormat === option.format}
                    onChange={() => onSelectFormat(option.format)}
                  />
                  <div class="export-format-card-main">
                    <div class="export-format-card-top">
                      <strong>{option.label}</strong>
                    </div>
                    <div class="export-format-help">{option.shortHelp}</div>
                    <div class="export-format-meta">Contains: {option.containsLabel}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>
        )}

        <details class="export-advanced" open={false}>
          <summary>Advanced options</summary>
          <div class="export-advanced-body">
            <fieldset class="export-run-choice" disabled={!sessionScoped || isExporting || isCopyingEvidence}>
              <legend>{isFeatureContext ? 'Feature scope' : 'Run source'}</legend>
              {isFeatureContext ? (
                <>
                  <label>
                    <input
                      type="radio"
                      name="run-source"
                      checked={selectionMode === 'latest'}
                      disabled={!canUseLatestRun}
                      onChange={() => onSelectMode('latest')}
                    />
                    Latest run per test case (default)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="run-source"
                      checked={selectionMode === 'all'}
                      disabled={!hasAnyExportableData}
                      onChange={() => onSelectMode('all')}
                    />
                    All runs in this feature
                  </label>
                </>
              ) : (
                <>
                  <label>
                    <input
                      type="radio"
                      name="run-source"
                      checked={selectionMode === 'selected'}
                      disabled={!canUseSelectedRun}
                      onChange={() => onSelectMode('selected')}
                    />
                    Selected run (default)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="run-source"
                      checked={selectionMode === 'latest'}
                      disabled={!canUseLatestRun}
                      onChange={() => onSelectMode('latest')}
                    />
                    Latest run
                  </label>
                </>
              )}
            </fieldset>

            <div class="export-copy-note">{formatScopeCopy(selectedFormat)}</div>
            <div class="export-copy-note">Copy Evidence writes rich HTML + Markdown text when possible; fallback is Markdown text.</div>
            <div class="export-copy-note">
              Privacy note: exports can include screenshots, URLs, and diagnostic text. Review before sharing externally.
            </div>
          </div>
        </details>

        <div class="export-preflight" role="status" aria-live="polite" aria-atomic="false">
          {isPreflighting && <p>Preparing export details…</p>}
          {!isPreflighting && preflight && sessionScoped && (
            <>
              <p><strong>Run:</strong> {preflight.selectedRunLabel}</p>
              <p>
                <strong>Contains:</strong> {preflight.stepCount} steps · {preflight.findingCount} findings · {preflight.requestCount} requests · {preflight.evidenceCount} evidence files
              </p>
              {preflight.missingEvidenceCount > 0 && (
                <p class="export-warning">
                  Heads up: {preflight.missingEvidenceCount} evidence file{preflight.missingEvidenceCount === 1 ? '' : 's'} are missing and will be marked unavailable.
                </p>
              )}
              {preflight.isLargeRun && <p class="export-warning">Large run detected. Export may take longer than usual.</p>}
            </>
          )}
          {!sessionScoped && (
            <p>
              <strong>{selectedDefinition.label}:</strong> this exports the full feature archive so teammates can re-import the complete dataset.
            </p>
          )}
          {!hasAnyExportableData && <p class="export-warning">No exportable data found yet. Record a run first.</p>}
          {noValidRun && sessionScoped && <p class="export-warning">No data available for the selected export scope.</p>}
          {canCopyEvidence && (
            <p class="export-copy-note">
              Tip: use <strong>{context === 'feature' ? 'Copy feature evidence' : 'Copy evidence'}</strong> for quick ticket/chat paste.
            </p>
          )}
          {exportStatusText && <p>{exportStatusText}</p>}
        </div>

        <div class="modal-actions">
          <button ref={closeRef} class="btn btn-outline" onClick={onClose} disabled={isExporting || isCopyingEvidence}>
            {isExporting || isCopyingEvidence ? 'Working…' : 'Cancel'}
          </button>
          <button class="btn btn-primary" onClick={onConfirm} disabled={disabledConfirm}>
            {isExporting ? 'Exporting…' : `Download ${selectedDefinition.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
