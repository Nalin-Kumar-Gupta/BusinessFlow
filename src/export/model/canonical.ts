// CanonicalExportModel — the export-oriented, renderer-agnostic view of
// ONE BusinessFlow session (a "run"). Feed this into PDF / Word / Excel /
// .bflow renderers. Do NOT couple renderers to the raw storage schema.
//
// Design rules (do not break these):
//   * Renderer-agnostic. Zero React/Preact. Zero DOM. Zero Chrome APIs.
//   * Reference-preserving. Screenshots stay as `blobKey` refs; renderers
//     decode lazily so a 200-step session does not sit as base64 in memory.
//   * Never bake annotations into image bytes. Pins/highlights are metadata
//     on `CanonicalStep.annotations`; each renderer paints them at render time.
//   * Correlational, not causal. Every "related" claim carries a temporal
//     delta and a source event id. Never assert causation.
//   * Honest about gaps. Fields we cannot populate from the current storage
//     schema are `undefined`, never fabricated.

import type {
  Confidence,
  FindingSeverity,
  FindingStatus,
  FindingType,
  FindingDisposition,
  NegativeTest,
  NetworkLog,
  Session,
  SessionStatus,
  SessionTestType,
  Step,
  TestEvent,
  TestResult,
  VitalName,
  VitalRating,
} from '../../core/types.js';

// ─── Top-level model ────────────────────────────────────────────────────

export interface CanonicalExportModel {
  readonly schemaVersion: 1;
  readonly meta: ReportMeta;
  readonly overview: TestOverview;
  readonly environment: EnvironmentSnapshot;
  readonly stats: ExecutionStatistics;
  readonly sections: readonly TestSection[];
  readonly findings: readonly ObservedFinding[];
  readonly appendix: TechnicalAppendix;
}

// ─── Metadata & overview ────────────────────────────────────────────────

export interface ReportMeta {
  readonly generatedAt: number;
  readonly generatedBy: { readonly product: 'BusinessFlow'; readonly version: string };
  readonly sessionId: string;
  readonly correlationVersion: number;
}

export interface TestOverview {
  readonly featureName?: string;
  readonly testCaseName?: string;
  readonly testCaseId?: string;
  readonly testType?: SessionTestType;
  readonly negativeTest: NegativeTest;
  readonly status?: SessionStatus;
  readonly testResult: TestResult;
  /**
   * One-line human summary derived at projection time (e.g. "Fail — 2 bugs,
   * 3 failed requests"). Never authoritative; renderers may compose their own.
   */
  readonly verdictSummary: string;
  readonly testerNotes?: string;
  readonly negativeAssertions?: readonly NegativeAssertion[];
}

export interface NegativeAssertion {
  readonly channel: 'http' | 'ui';
  readonly expected: string;
  readonly observed: string;
  readonly verdict: 'pass' | 'fail';
}

export interface EnvironmentSnapshot {
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly userAgent: string;
  readonly chromeVersion?: string;
  readonly platform?: string;
  readonly extVersion?: string;
  readonly timeZone?: string;
  readonly viewport?: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly scopeOrigins: readonly string[];
  readonly apiSlaSec?: number;
}

// ─── Statistics (Level 1 rollup) ────────────────────────────────────────

export interface ExecutionStatistics {
  readonly steps: number;
  readonly stepsWithBugs: number;
  readonly stepsNoStateChange: number;
  readonly bugs: number;
  readonly findings: Readonly<Record<FindingSeverity, number>>;
  readonly network: {
    readonly total: number;
    readonly failed: number;
    readonly slowOverSla: number;
    readonly thirdParty: number;
  };
  readonly console: {
    readonly errors: number;
    readonly warnings: number;
    readonly pageErrors: number;
  };
  readonly userSignals: {
    readonly clicks: number;
    readonly rageClicks: number;
    readonly manualCaptures: number;
    readonly screenshots: number;
  };
  readonly performance?: {
    readonly lcpMs?: number;
    readonly fcpMs?: number;
    readonly cls?: number;
    readonly inpMs?: number;
    readonly ttfbMs?: number;
  };
}

// ─── Sections & steps ───────────────────────────────────────────────────

export interface TestSection {
  readonly id: string;
  readonly title?: string; // no user-defined sectioning today; always undefined for single-session reports
  readonly testCaseId?: string;
  readonly sourceSessionId?: string;
  readonly status?: SessionStatus;
  readonly testResult?: TestResult;
  readonly startedAt?: number;
  readonly durationMs?: number;
  readonly steps: readonly CanonicalStep[];
}

export interface CanonicalStep {
  readonly id: string;
  readonly sourceStepId: string;
  /** 1-based index within the session, preserved from Step.index. */
  readonly index: number;
  readonly timestamp: number;
  /** Duration from this step to the next step, when a next step exists. */
  readonly durationToNextMs?: number;
  readonly action: StepAction;
  readonly beforeEvidence?: EvidenceRef;
  readonly afterEvidence?: EvidenceRef;
  readonly systemEvidence: readonly EvidenceRef[];
  readonly annotations: readonly StepAnnotation[];
  readonly noVisibleChange: boolean;
  readonly testerNotes: readonly StepTesterNote[];
  readonly bugs: readonly StepBugSummary[];
  readonly correlated: CorrelatedEvidence;
}

export interface StepAction {
  /** Resolved via step-helpers.stepLabel() — same precedence as the dashboard. */
  readonly label: string;
  readonly semanticLabel?: string;
  readonly pageUrl?: string;
  readonly elementRect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly pageScrollX: number;
    readonly pageScrollY: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly devicePixelRatio: number;
  };
  /** Derived from Step.clickEventIds.length. */
  readonly clickCount: number;
}

// ─── Evidence & annotations ─────────────────────────────────────────────

export interface EvidenceRef {
  readonly blobKey: string;
  readonly mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  readonly capturedAt: number;
  readonly width?: number;
  readonly height?: number;
  readonly bytes?: number;
  readonly capturePhase?: 'loading' | 'complete';
  readonly aboveFold?: boolean;
  readonly componentName?: string;
  readonly triggerConfidence: Confidence;
  /** The `evidence_stored` event id — enables round-trip to raw event stream. */
  readonly sourceEventId: string;
  /**
   * True when the referenced blob was NOT found in the current blob index
   * at projection time. Renderers should render a placeholder rather than
   * silently dropping the image.
   */
  readonly missing: boolean;
}

export interface StepAnnotation {
  readonly kind: 'pin' | 'highlight-rect';
  readonly target: 'before' | 'after' | 'system';
  /** For pins: horizontal position as percent (0-100) of rendered image. */
  readonly xPercent?: number;
  readonly yPercent?: number;
  /** For highlight-rect: element bounding rect in page coords. */
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly label?: string;
  readonly note?: string;
  readonly sourceKind: 'note' | 'bug' | 'element';
  readonly sourceId: string;
}

export interface StepTesterNote {
  readonly id: string;
  readonly text: string;
  readonly hasPin: boolean;
}

export interface StepBugSummary {
  readonly id: string;
  readonly description: string;
  readonly hasPin: boolean;
}

// ─── Correlation (Level 2, inline in step) ──────────────────────────────
//
// Correlation principle: temporal only. Every entry carries `temporalDeltaMs`
// so renderers can honestly say "N ms after the action" rather than making
// causal claims.

export interface CorrelatedEvidence {
  readonly failedRequests: readonly NetworkFindingSummary[];
  readonly slowRequests: readonly NetworkFindingSummary[];
  readonly consoleErrors: readonly ConsoleFindingSummary[];
  readonly pageErrors: readonly ConsoleFindingSummary[];
  readonly navigation?: NavigationSummary;
  readonly rageClicks: number;
}

// ─── Observed findings (Level 1 rollup, session-wide) ───────────────────

export interface ObservedFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly type: FindingType;
  readonly disposition: FindingDisposition;
  readonly status: FindingStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly timestamp: number;
  readonly seq: number;
  readonly pageUrl?: string;
  readonly stepIndex?: number;
  readonly relatedRequestId?: string;
  readonly relatedEvidence: readonly EvidenceRef[];
  readonly relatedEventIds: readonly string[];
  readonly testerNote?: string;
  /**
   * Time from the inferred preceding user click, if any. Null when the
   * finding stands alone.
   */
  readonly temporalDeltaFromClickMs?: number;
  /** Fixed value; the model never claims causation. */
  readonly correlationClaim: 'observed_around_same_time';
}

// ─── Technical appendix (Level 3) ───────────────────────────────────────

export interface TechnicalAppendix {
  readonly network: readonly NetworkFindingSummary[];
  readonly consoleWarnings: readonly ConsoleFindingSummary[];
  readonly performance: {
    readonly webVitals: readonly WebVitalSummary[];
    readonly pageTimings: readonly PageTimingSummary[];
    readonly longTasks: readonly LongTaskSummary[];
    readonly memorySnapshots: readonly MemorySnapshotSummary[];
  };
  readonly domMetrics: readonly DomMetricsSummary[];
  readonly cspViolations: readonly CspViolationSummary[];
  readonly checkpoints: readonly CheckpointSummary[];
  readonly navigationHistory: readonly NavigationSummary[];
  readonly captureTimeline: {
    readonly pausedAt: readonly number[];
    readonly resumedAt: readonly number[];
  };
  readonly negativeInference?: NegativeInferenceSummary;
}

// ─── Nested summary types ───────────────────────────────────────────────

export interface NetworkFindingSummary {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly origin: string;
  readonly path: string;
  readonly statusCode?: number;
  readonly outcome: 'success' | 'http_error' | 'network_error' | 'pending';
  readonly durationMs?: number;
  readonly startedAt: number;
  readonly resourceType: string;
  readonly fromCache?: boolean;
  readonly responseSizeBytes?: number;
  readonly errorText?: string;
  readonly isThirdParty?: boolean;
  readonly isOverSla?: boolean;
  /** Signed ms delta from an anchor timestamp (e.g. step.ts). */
  readonly temporalDeltaMs?: number;
}

export interface ConsoleFindingSummary {
  readonly eventId: string;
  readonly kind: 'console_error' | 'console_warn' | 'page_error';
  readonly message: string;
  readonly stack?: string;
  readonly pageUrl?: string;
  readonly source?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly timestamp: number;
  readonly temporalDeltaMs?: number;
}

export interface NavigationSummary {
  readonly eventId: string;
  readonly url: string;
  readonly previousUrl?: string;
  readonly isSpaRouteChange: boolean;
  readonly transitionType?: string;
  readonly timestamp: number;
  readonly temporalDeltaMs?: number;
}

export interface WebVitalSummary {
  readonly eventId: string;
  readonly name: VitalName;
  readonly value: number;
  readonly rating: VitalRating;
  readonly pageUrl?: string;
  readonly timestamp: number;
}

export interface PageTimingSummary {
  readonly eventId: string;
  readonly ttfbMs: number;
  readonly domContentLoadedMs: number;
  readonly loadEventMs: number;
  readonly redirectCount: number;
  readonly pageUrl?: string;
  readonly timestamp: number;
}

export interface LongTaskSummary {
  readonly eventId: string;
  readonly durationMs: number;
  readonly startTime: number;
  readonly pageUrl?: string;
  readonly timestamp: number;
}

export interface MemorySnapshotSummary {
  readonly eventId: string;
  readonly usedJSHeapSizeBytes: number;
  readonly totalJSHeapSizeBytes: number;
  readonly jsHeapSizeLimitBytes: number;
  readonly timestamp: number;
}

export interface DomMetricsSummary {
  readonly eventId: string;
  readonly nodeCount: number;
  readonly maxDepth: number;
  readonly ariaInvalidCount: number;
  readonly missingAltCount: number;
  readonly unlabelledInteractiveCount: number;
  readonly pageUrl?: string;
  readonly timestamp: number;
}

export interface CspViolationSummary {
  readonly eventId: string;
  readonly violatedDirective: string;
  readonly blockedURI: string;
  readonly pageUrl?: string;
  readonly timestamp: number;
}

export interface CheckpointSummary {
  readonly id: string;
  readonly name: string;
  readonly source: 'manual' | 'navigation' | 'failure' | 'inferred';
  readonly pageUrl?: string;
  readonly timestamp: number;
  readonly note?: string;
}

export interface NegativeInferenceSummary {
  readonly confidence: 'inferred-high' | 'inferred-low';
  readonly signals: readonly string[];
  readonly evidenceEventIds: readonly string[];
  readonly testerVerdict?: 'confirmed' | 'rejected';
}

// ─── Projection input & options ─────────────────────────────────────────

/**
 * The complete set of data the projection needs for ONE session. Kept as a
 * plain data bag so unit tests can construct it in memory and so the storage
 * layer can populate it via the session-scoped read path
 * (`storage/db.ts::getSessionExportData`).
 */
export interface SessionExportInput {
  readonly session: Session;
  readonly events: readonly TestEvent[];
  readonly steps: readonly Step[];
  readonly networkLogs: readonly NetworkLog[];
  /** Keys of blobs currently available in storage; used to flag `missing`. */
  readonly knownBlobKeys: ReadonlySet<string>;
}

export interface CanonicalExportOptions {
  /**
   * Correlation half-window (ms) for step-inline signals. Signals whose
   * timestamp lies within ±window of a step's ts are considered "correlated"
   * with that step. Defaults to 4000 ms to match the historical dashboard
   * behavior (`findNearbyNetworkErrors`).
   */
  readonly correlationWindowMs?: number;
  /** Emitted into ReportMeta.generatedBy.version. */
  readonly generatorVersion?: string;
  /** Overrides `Date.now()` — deterministic tests. */
  readonly nowMs?: number;
}
