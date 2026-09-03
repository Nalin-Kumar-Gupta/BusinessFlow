import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';

import {
  EXPORT_FORMATS,
  formatScopeCopy,
  isFormatSessionScoped,
} from './export-ux.js';
import type {
  ExportFormat,
  ExportPreflightSummary,
  SessionSelectionMode,
} from './export-ux.js';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ExportModalContext = 'feature' | 'test-case';

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
        <div id={titleIdRef.current} class="modal-title">{isFeatureContext ? 'Export feature report' : 'Export test case report'}</div>
        <div id={bodyIdRef.current} class="modal-body">
          {isFeatureContext
            ? 'Export this feature with latest run per test case (default) or all runs from advanced options.'
            : 'Export this test case with selected run (default) or latest run from advanced options.'}
        </div>

        <div class="export-copy-evidence-row">
            <button class="btn btn-primary" onClick={onCopyEvidence} disabled={isCopyingEvidence || isExporting || !canCopyEvidence}>
              {isCopyingEvidence ? 'Copying evidence…' : (context === 'feature' ? 'Copy feature summary' : 'Copy evidence')}
            </button>
            <p class="export-copy-evidence-help">
              {context === 'feature'
                ? 'Copy feature summary, test-case matrix, findings, and representative screenshots.'
                : 'Copy test result, relevant steps, findings and screenshots.'}
            </p>
          </div>

        <div class="export-format-list" role="radiogroup" aria-label="Export format">
          {EXPORT_FORMATS.map((option) => (
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
                  {option.recommendedForMostTesters && <span class="badge badge-muted">Recommended</span>}
                </div>
                <div class="export-format-help">{option.shortHelp}</div>
                <div class="export-format-meta">Contains: {option.containsLabel}</div>
                <div class="export-format-meta">Scope: {option.scopeLabel}</div>
              </div>
            </label>
          ))}
        </div>

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
              Tip: use <strong>{context === 'feature' ? 'Copy feature summary' : 'Copy evidence'}</strong> for quick ticket/chat paste.
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
