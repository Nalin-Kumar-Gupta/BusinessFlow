/**
 * Evidence Candidate Engine — pure TypeScript, zero Chrome/DOM APIs.
 *
 * Turns raw observable signals from the DOM into scored EvidenceCandidate
 * objects.  All descriptions are factual observations, never causal claims.
 *
 * Confidence levels:
 *   'observed'  — directly measured (role attribute present, text content read)
 *   'inferred'  — derived from a heuristic pattern; may not reflect intent
 *
 * We never present an inferred relationship as observed fact.
 */

// ─── Signal types ─────────────────────────────────────────────────────────────
// Each kind maps to a base reliability score (0-100).
// Conservative: rather miss a signal than produce noise.

export type SignalKind =
  | 'dialog_opened'            // [role=dialog] added — 80
  | 'dialog_closed'            // [role=dialog] removed — 65
  | 'alert_appeared'           // [role=alert] or aria-live=assertive changed — 85
  | 'status_text_changed'      // [role=status] or aria-live=polite changed — 60
  | 'error_state_changed'      // aria-invalid set true — 80
  | 'aria_live_updated'        // any aria-live text changed — 55
  | 'form_submitted'           // form submit event — 75
  | 'button_enabled'           // disabled removed from interactive element — 50
  | 'button_disabled'          // disabled added to interactive element — 40
  | 'loading_completed'        // aria-busy true→false — 55
  | 'significant_content_added'    // large subtree appeared — 40
  | 'significant_content_removed'; // large subtree disappeared — 35

export const SIGNAL_BASE_SCORES: Record<SignalKind, number> = {
  dialog_opened:               80,
  dialog_closed:               65,
  alert_appeared:              85,
  status_text_changed:         60,
  error_state_changed:         80,
  aria_live_updated:           55,
  form_submitted:              75,
  button_enabled:              50,
  button_disabled:             40,
  loading_completed:           55,
  significant_content_added:   40,
  significant_content_removed: 35,
};

export interface ObservedSignal {
  kind: SignalKind;
  /**
   * Observed fact described in plain terms.
   * Must NOT claim causation or intent.
   * Good:  "Element with role=alert appeared"
   * Bad:   "Form was submitted successfully"
   */
  description: string;
  baseScore: number;
  /** Selector, label, or text that identifies the element — never input values */
  elementHint?: string;
  /** Observed text before the change */
  before?: string;
  /** Observed text after the change */
  after?: string;
  ts: number;
}

export interface EvidenceCandidate {
  id: string;
  /**
   * Aggregate meaningfulness score 0–100.
   *   ≥ 75 → auto-capture recommended
   *   ≥ 50 → surface as a suggestion
   *    < 50 → discard / too noisy
   */
  score: number;
  confidence: 'observed' | 'inferred';
  signals: ObservedSignal[];
  /**
   * Short human-readable label built from observed facts.
   * Format: "[trigger] → [what changed]"
   */
  label: string;
  /** The user action that opened the observation window, if any. */
  triggerAction?: string;
  ts: number;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Minimum score to auto-capture a screenshot. */
export const AUTO_CAPTURE_THRESHOLD = 75;
/** Minimum score to surface a suggestion to the tester. */
export const SUGGEST_THRESHOLD = 50;

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Aggregate a set of signals from one observation window into a candidate.
 *
 * Scoring model: highest signal is taken as the base; each additional signal
 * contributes diminishing returns (they are correlated, not independent).
 * This prevents a pile of weak signals from inflating the score.
 */
export function scoreSignals(
  signals: ObservedSignal[],
  triggerAction?: string,
): EvidenceCandidate {
  if (signals.length === 0) throw new Error('scoreSignals: empty signal list');

  const sorted = [...signals].sort((a, b) => b.baseScore - a.baseScore);
  let score = sorted[0]!.baseScore;
  for (let i = 1; i < sorted.length; i++) {
    // Diminishing contribution: i=1 → 50%, i=2 → 25%, …
    score = Math.min(100, score + sorted[i]!.baseScore / (2 * i));
  }
  score = Math.round(score);

  // Deduplicate description parts (same kind can appear multiple times)
  const seen = new Set<string>();
  const descParts: string[] = [];
  for (const s of sorted) {
    if (!seen.has(s.description)) {
      seen.add(s.description);
      descParts.push(s.description);
    }
  }
  const changeLabel = descParts.slice(0, 3).join(' · ');
  const label = triggerAction ? `${triggerAction} → ${changeLabel}` : changeLabel;

  // Confidence: all our signals are directly observed DOM facts
  const confidence: 'observed' | 'inferred' = 'observed';

  return {
    id: `ec${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    score,
    confidence,
    signals,
    label,
    triggerAction,
    ts: Date.now(),
  };
}

export const shouldAutoCapture  = (c: EvidenceCandidate): boolean => c.score >= AUTO_CAPTURE_THRESHOLD;
export const shouldSuggest      = (c: EvidenceCandidate): boolean => c.score >= SUGGEST_THRESHOLD && c.score < AUTO_CAPTURE_THRESHOLD;
