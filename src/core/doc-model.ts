/**
 * DocModel — canonical source of truth for a TestTrace QA report.
 *
 * Two layers:
 *   1. DocModel  — user-edited field values (persisted in IDB).
 *   2. BlockSpec — typed block list derived at render-time from
 *                  DocModel + SemanticReport. Drives both the
 *                  A4 pagination engine and the DOCX exporter.
 *
 * Field ID conventions:
 *   "doc.title"                    — document-level title
 *   "exec.verdict"                 — executive summary verdict paragraph
 *   "exec.reviewer-notes"          — reviewer sign-off / observations
 *   "session.<id>.title"           — per-session heading (editable)
 *   "session.<id>.notes"           — per-session general notes
 *   "step.<sessionId>.<n>.heading" — step heading (screen name)
 *   "step.<sessionId>.<n>.notes"   — per-step tester notes
 *   "issue.<id>.notes"             — per-issue reviewer notes
 */

// ─── A4 page constants (96 dpi) ──────────────────────────────────────────────

/** A4 page width in CSS pixels at 96 dpi (210 mm). */
export const A4_W = 794;
/** A4 page height in CSS pixels at 96 dpi (297 mm). */
export const A4_H = 1123;
/** Page margin in CSS pixels (~25 mm). */
export const A4_MARGIN = 96;
/** Usable content width inside margins. */
export const CONTENT_W = A4_W - 2 * A4_MARGIN;   // 602 px
/** Usable content height inside margins. */
export const CONTENT_H = A4_H - 2 * A4_MARGIN;   // 931 px

// ─── DocModel ────────────────────────────────────────────────────────────────

export interface DocModel {
  /** Composite key: sorted session IDs joined with ':'. */
  id: string;
  /**
   * Simple key-value edits (title etc). Kept for backward compat.
   * Primary content is now stored per-page in pageContents.
   */
  fields: Record<string, string>;
  /**
   * Per-page HTML content keyed by page index.
   * This IS the canonical document — what the user has written.
   * Images are stripped (src replaced with data-bk) before storing.
   * They are reloaded from IDB on page render.
   */
  pageContents: Record<number, string>;
  /** Unix ms timestamp of last save. */
  savedAt: number;
}

export function makeDocId(sessionIds: string[]): string {
  return [...sessionIds].sort().join(':');
}

export const FieldId = {
  docTitle:          ()                    => 'doc.title',
  docLogo:           ()                    => 'doc.logo',   // 'none'|'walmart'|'sams'|'custom'
  execVerdict:       ()                    => 'exec.verdict',
  execReviewerNotes: ()                    => 'exec.reviewer-notes',
  sessionTitle:      (sid: string)         => `session.${sid}.title`,
  sessionNotes:      (sid: string)         => `session.${sid}.notes`,
  stepHeading:       (sid: string, n: number) => `step.${sid}.${n}.heading`,
  stepNotes:         (sid: string, n: number) => `step.${sid}.${n}.notes`,
  issueNotes:        (issueId: string)     => `issue.${issueId}.notes`,
} as const;

// ─── BlockSpec — intermediate representation for layout + export ──────────────
// Derived from DocModel + SemanticReport. Never stored — rebuilt on each render.

export type BlockSpec =
  | CoverBlock
  | TocBlock
  | ExecSummaryBlock
  | SessionHeaderBlock
  | SessionMetaBlock
  | IssuesBlock
  | StepBlock
  | SectionNotesBlock
  | FooterBlock;

interface BaseBlock {
  /** Stable unique ID — used by height-measurement map. */
  id: string;
  /**
   * Forces this block to start on a new A4 page.
   * Layout engine inserts a page break before this block.
   */
  forceNewPage?: boolean;
  /**
   * Height estimate in px used by the layout engine before
   * the DOM is rendered and actual heights are measured.
   */
  estimatedHeight: number;
}

export interface CoverBlock extends BaseBlock {
  type: 'cover';
  forceNewPage: true;
  /** Feature / project name — shown large on the cover. Editable by user. */
  title: string;
  /** Generated date + browser + OS line. */
  meta: string;
  /** 'none' | 'walmart' | 'sams' | 'custom' — which logo mark to render. */
  logoId: string;
}

export interface TocBlock extends BaseBlock {
  type: 'toc';
  forceNewPage: true;
  entries: Array<{ label: string; level: 1 | 2 }>;
}

export interface ExecSummaryBlock extends BaseBlock {
  type: 'exec-summary';
  forceNewPage: true;
  verdictText: string;
  rows: ExecRow[];
  reviewerNotes: string;
}

export interface ExecRow {
  index: number;
  title: string;
  functionalPass: boolean;
  slaLabel: string;
  issueCount: number;
  duration: string;
  result: string;
  resultColor: string;
  sessionId: string;
}

export interface SessionHeaderBlock extends BaseBlock {
  type: 'session-header';
  forceNewPage: true;
  sessionId: string;
  index: number;
  title: string;
  meta: string;
  resultLabel: string;
  resultColor: string;
}

export interface SessionMetaBlock extends BaseBlock {
  type: 'session-meta';
  rows: [string, string, string, string][];
}

export interface IssuesBlock extends BaseBlock {
  type: 'issues';
  sessionId: string;
  issues: Array<{
    id: string;
    severity: string;
    title: string;
    apiPath?: string;
    apiMethod?: string;
    status: string;
    noteFieldId: string;
    noteValue: string;
  }>;
}

export interface StepBlock extends BaseBlock {
  type: 'step';
  sessionId: string;
  stepNumber: number;
  isBaseline: boolean;
  label: string;
  screenName: string;        // default (from SemanticReport)
  headingFieldId: string;    // editable heading field ID
  headingValue: string;      // current value (from DocModel)
  timestamp: string;
  stateText: string;
  stateColor: string;
  precedingAction?: string;
  captureNote?: string;
  screenshotBlobKey: string;
  screenshotW: number;
  screenshotH: number;
  networkRows: NetworkRow[];
  errorRows: ErrorRow[];
  notesFieldId: string;      // editable notes field ID
  notesValue: string;        // current value (from DocModel)
}

export interface NetworkRow {
  requestId: string;
  method: string;
  path: string;
  url: string;
  statusCode?: number;
  duration: string;
  state: 'pending' | 'complete' | 'error' | 'after';
  isSlow: boolean;
}

export interface ErrorRow {
  kind: string;
  message: string;
}

export interface SectionNotesBlock extends BaseBlock {
  type: 'section-notes';
  sessionId: string;
  fieldId: string;
  value: string;
  label: string;
}

export interface FooterBlock extends BaseBlock {
  type: 'footer';
  text: string;
  date: string;
}
