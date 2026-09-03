/**
 * Signal Pipeline — pure TypeScript, zero browser/Chrome APIs.
 *
 * Given a set of DOM signals, a user action context, and a fingerprint diff,
 * returns a structured decision: auto-capture, surface a suggestion, or ignore.
 *
 * This replaces the ad-hoc score-threshold approach with explicit policy rules
 * that are independently testable.
 *
 * Decision rules (evaluated top-to-bottom; first match wins):
 *   R1. Route (URL) changed                          → auto, observed
 *   R2. High-confidence signal (alert/dialog/error)  → auto, observed
 *   R3. Medium signal + fingerprint changed + user action → auto, inferred-high
 *   R4. Medium signal + fingerprint changed (no action)  → suggest, inferred-high
 *   R5. Fingerprint unchanged                        → ignore (no visual change)
 *   R6. Weak signals only                            → ignore
 *
 * IMPORTANT: "Captured after click" ≠ "click caused the change."
 * The captureNote describes correlation only, never causation.
 */

import type { ObservedSignal, SignalKind } from './evidence-engine.js';
import { scoreSignals } from './evidence-engine.js';
import { fingerprintDiffers, extractRoute } from './state-fingerprint.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CaptureDecision = 'auto' | 'suggest' | 'ignore';
export type PipelineConfidence = 'observed' | 'inferred-high' | 'inferred-low';

/**
 * A user action that was observed in the same time window as the signals.
 * label must NEVER contain typed input values.
 */
export interface UserAction {
  kind: 'click' | 'submit' | 'keypress' | 'url-change';
  /** Short human label, e.g. "Submit button" or "Enter key" */
  label: string;
  ts: number;
}

export interface PipelineInput {
  signals: ObservedSignal[];
  userAction?: UserAction;     // defined if within USER_ACTION_WINDOW_MS
  fingerprintBefore: string;
  fingerprintAfter: string;
}

export interface PipelineResult {
  decision: CaptureDecision;
  confidence: PipelineConfidence;
  /**
   * Factual, causation-free explanation for why capture was triggered.
   * Stored as the screenshot note.
   * Example: "Captured shortly after click (Submit button); status changed to Processing"
   */
  captureNote: string;
  /** Signal kinds present — stored for report correlation */
  triggerKinds: SignalKind[];
  /** Aggregate score from evidence-engine */
  score: number;
  route: string;
  routeChanged: boolean;
}

// ─── Policy constants ──────────────────────────────────────────────────────────

/** User action stays "current" for this long after it occurs. */
export const USER_ACTION_WINDOW_MS = 5_000;

/**
 * High-confidence: a single signal of this kind is sufficient to auto-capture
 * regardless of fingerprint change (because these are direct ARIA observations,
 * not heuristics).
 */
const HIGH_CONFIDENCE: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'dialog_opened',
  'alert_appeared',
  'error_state_changed',
  'form_submitted',
]);

/**
 * Medium-confidence: worth capturing when combined with a visible state change
 * (fingerprint diff).  Without fingerprint change, we ignore them.
 */
const MEDIUM_CONFIDENCE: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'dialog_closed',
  'status_text_changed',
  'loading_completed',
  'aria_live_updated',
  'button_enabled',
]);

// ─── Pipeline ──────────────────────────────────────────────────────────────────

export function runPipeline(input: PipelineInput): PipelineResult {
  const { signals, userAction, fingerprintBefore, fingerprintAfter } = input;

  const routeBefore  = extractRoute(fingerprintBefore);
  const routeAfter   = extractRoute(fingerprintAfter);
  const routeChanged = routeBefore !== routeAfter;
  const fpChanged    = fingerprintDiffers(fingerprintBefore, fingerprintAfter);
  const route        = routeAfter || routeBefore;
  const triggerKinds = signals.map((s) => s.kind);

  // Score for reporting only — not used in decision rules
  const score = signals.length > 0
    ? scoreSignals(signals, userAction?.label).score
    : 0;

  // ── R1: Route change ──────────────────────────────────────────────────────
  if (routeChanged) {
    return result('auto', 'observed', triggerKinds, score, route, routeChanged,
      `Page navigated to ${routeAfter}`);
  }

  // ── R2: High-confidence signal ────────────────────────────────────────────
  const highSig = signals.find((s) => HIGH_CONFIDENCE.has(s.kind));
  if (highSig) {
    return result('auto', 'observed', triggerKinds, score, route, routeChanged,
      buildNote(highSig.description, userAction));
  }

  // ── R3 / R4: Medium signal + visible state actually changed ───────────────
  const medSig = signals.find((s) => MEDIUM_CONFIDENCE.has(s.kind));
  if (medSig && fpChanged) {
    // With a recent user action → auto (inferred correlation, not proof)
    // Without → surface as a suggestion (tester can judge)
    return result(
      userAction ? 'auto' : 'suggest',
      'inferred-high',
      triggerKinds, score, route, routeChanged,
      buildNote(medSig.description, userAction),
    );
  }

  // ── R5: No visible state change → nothing meaningful happened ─────────────
  if (!fpChanged) {
    return result('ignore', 'inferred-low', triggerKinds, score, route, routeChanged,
      'No visible state change detected');
  }

  // ── R6: Weak signals only ─────────────────────────────────────────────────
  return result('ignore', 'inferred-low', triggerKinds, score, route, routeChanged,
    'Signals too weak; ignoring');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function result(
  decision: CaptureDecision,
  confidence: PipelineConfidence,
  triggerKinds: SignalKind[],
  score: number,
  route: string,
  routeChanged: boolean,
  captureNote: string,
): PipelineResult {
  return { decision, confidence, triggerKinds, score, route, routeChanged, captureNote };
}

/**
 * Build a factual, causation-free capture note.
 * "Captured shortly after click (Submit); status changed to Processing"
 * — describes correlation, never claims causation.
 */
function buildNote(signalDescription: string, action?: UserAction): string {
  if (!action) return signalDescription;
  const elapsed = Date.now() - action.ts;
  const timing  = elapsed < 300  ? 'immediately after'
                : elapsed < 1500 ? 'shortly after'
                : 'after';
  return `Captured ${timing} ${action.kind} (${action.label}); ${signalDescription}`;
}
