export const EVENT_SCHEMA_VERSION = 1;
export const CORRELATION_VERSION = 1;

// ─── Session ─────────────────────────────────────────────────────────────────

export type SessionMode = 'guided' | 'aware' | 'automatic';
export type NegativeTest = 'yes' | 'no' | 'unknown';
export type NegativeTestSource = 'user' | 'default' | 'inferred';
export type RecordingState = 'active' | 'paused' | 'stopped';
export type Confidence = 'observed' | 'inferred-high' | 'inferred-low';

/** Overall result of the test session. Auto-derived from findings; tester can override. */
export type TestResult = 'pass' | 'fail' | 'partial' | 'blocked' | 'in_progress';

/** Intake-state status used by the QA Command Center workflow. */
export type SessionStatus = 'draft' | 'pass' | 'fail' | 'blocked';
export type SessionTestType = 'Positive' | 'Negative' | 'Edge Case';


/** Finding severity, matching industry conventions (Allure / TestRail / Jira). */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Tester-managed defect status. */
export type FindingStatus = 'open' | 'known_issue' | 'fixed' | 'wont_fix';

export interface ViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

/**
 * Rect of a clicked element captured in page coordinates at the moment of
 * the click, plus the page scroll offset so the report renderer can decide
 * whether the element was above/below fold and where to draw the highlight.
 */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pageScrollX: number;
  pageScrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
}

export interface SessionEnvironment {
  userAgent: string;
  chromeVersion: string;
  platform: string;
  extVersion: string;
  timeZone: string;
  /** Captured at session start from the active tab. */
  viewport?: ViewportInfo;
}

export interface SessionCounters {
  events: number;
  networkRequests: number;
  httpErrors: number;
  networkErrors: number;
  consoleErrors: number;
  consoleWarns: number;
  pageErrors: number;
  screenshots: number;
  manualCaptures: number;
  rageClicks: number;
  /** Number of click-driven steps opened in this session. Optional for pre-v3 sessions. */
  steps?: number;
}

export interface NegativeExpectationConfig {
  /**
   * HTTP statuses that are considered expected outcomes for this negative run
   * (e.g. [400, 401, 403]).
   */
  httpStatuses?: number[];
  /**
   * Case-insensitive text snippets expected in UI/error messaging
   * (DOM change summaries, console/page errors), e.g. "validation error".
   */
  uiSignals?: string[];
}

export interface Session {
  id: string;
  testCaseName?: string;
  featureName?: string;
  status?: SessionStatus;
  testType?: SessionTestType;
  testCaseId?: string;
  mode: SessionMode;
  negativeTest: NegativeTest;
  negativeTestSource: NegativeTestSource;
  /**
   * Optional lightweight expectations for negative-test assertions.
   * Omitted for positive tests or when tester did not provide explicit oracles.
   */
  negativeExpectations?: NegativeExpectationConfig;
  recordingState: RecordingState;
  startedAt: number;
  endedAt?: number;
  scopeOrigins: string[];
  environment: SessionEnvironment;
  counters: SessionCounters;
  schemaVersion: number;
  notes?: string;
  /** Auto-derived from findings. Tester can override. */
  testResult: TestResult;
  /** API response SLA threshold in seconds. Default 3. */
  apiSlaSec: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type EventKind =
  | 'session_start'
  | 'session_end'
  | 'checkpoint'
  | 'navigation'
  | 'user_click'
  | 'rage_click'
  | 'net_phase'
  | 'web_vital'
  | 'page_timing'
  | 'long_task'
  | 'memory_snapshot'
  | 'dom_metrics'
  | 'csp_violation'
  | 'resource_timing'
  | 'console_error'
  | 'console_warn'
  | 'page_error'
  | 'dom_change'
  | 'negative_inference'
  | 'evidence_requested'
  | 'evidence_stored'
  | 'evidence_failed'
  | 'capture_paused'
  | 'capture_resumed';

export interface BaseEvent {
  id: string;
  sessionId: string;
  ts: number;
  seq: number;
  kind: EventKind;
  tabId: number;
  frameId?: number;
  confidence: Confidence;
}

export interface SessionStartEvent extends BaseEvent { kind: 'session_start'; confidence: 'observed' }
export interface SessionEndEvent extends BaseEvent { kind: 'session_end'; confidence: 'observed'; durationMs: number }
export interface CapturePausedEvent extends BaseEvent { kind: 'capture_paused'; confidence: 'observed' }
export interface CaptureResumedEvent extends BaseEvent { kind: 'capture_resumed'; confidence: 'observed' }

export type CheckpointSource = 'manual' | 'navigation' | 'failure' | 'inferred';
export interface CheckpointEvent extends BaseEvent {
  kind: 'checkpoint';
  name: string;
  source: CheckpointSource;
  pageUrl?: string;
  note?: string;
}

export interface NavigationEvent extends BaseEvent {
  kind: 'navigation';
  url: string;
  previousUrl?: string;
  isSpaRouteChange: boolean;
  transitionType?: string;
  confidence: 'observed';
}

export interface UserClickEvent extends BaseEvent {
  kind: 'user_click';
  selector: string;
  tagName: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  /** Best-effort human label: aria-label > text > role > tagName */
  accessibleName?: string;
  /** Bounding rect of the clicked element at click time (page coords). */
  elementRect?: ElementRect;
  pageUrl?: string;
  confidence: 'observed';
}

export interface RageClickEvent extends BaseEvent {
  kind: 'rage_click';
  selector: string;
  tagName: string;
  clickCount: number;
  windowMs: number;
  pageUrl?: string;
  confidence: 'observed';
}

export type NetPhase = 'start' | 'headers' | 'complete' | 'error';
export interface NetPhaseEvent extends BaseEvent {
  kind: 'net_phase';
  phase: NetPhase;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  initiator?: string;
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: Record<string, string>;
  droppedHeaderCount: number;
  fromCache?: boolean;
  responseSize?: number;
  errorText?: string;
  confidence: 'observed';
}

export type VitalName = 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB';
export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface WebVitalEvent extends BaseEvent {
  kind: 'web_vital';
  name: VitalName;
  value: number;
  rating: VitalRating;
  pageUrl?: string;
  confidence: 'observed';
}

export interface PageTimingEvent extends BaseEvent {
  kind: 'page_timing';
  ttfbMs: number;
  domContentLoadedMs: number;
  loadEventMs: number;
  redirectCount: number;
  pageUrl?: string;
  confidence: 'observed';
}

export interface LongTaskEvent extends BaseEvent {
  kind: 'long_task';
  /** Task duration in ms. Tasks > 50ms block the main thread. */
  duration: number;
  startTime: number;
  pageUrl?: string;
  confidence: 'observed';
}

export interface MemorySnapshotEvent extends BaseEvent {
  kind: 'memory_snapshot';
  /** Chrome-only: performance.memory */
  usedJSHeapSizeBytes: number;
  totalJSHeapSizeBytes: number;
  jsHeapSizeLimitBytes: number;
  pageUrl?: string;
  confidence: 'observed';
}

export interface DomMetricsEvent extends BaseEvent {
  kind: 'dom_metrics';
  /** Total DOM node count. Google recommends < 1400. */
  nodeCount: number;
  /** Maximum DOM tree depth. Deep nesting hurts rendering. */
  maxDepth: number;
  /** Elements with aria-invalid="true". */
  ariaInvalidCount: number;
  /** img elements missing alt attribute. */
  missingAltCount: number;
  /** Interactive elements without accessible labels. */
  unlabelledInteractiveCount: number;
  pageUrl?: string;
  confidence: 'observed';
}

export interface CspViolationEvent extends BaseEvent {
  kind: 'csp_violation';
  violatedDirective: string;
  blockedURI: string;
  originalPolicy: string;
  pageUrl?: string;
  confidence: 'observed';
}

export interface ResourceSummary {
  name: string;
  initiatorType: string;
  durationMs: number;
  transferSizeBytes: number;
  encodedBodySizeBytes: number;
  failed: boolean;
}

export interface NetworkPayload {
  url: string;
  method: string;
  status: number;
  requestBody?: string;
  responseBody?: string;
  timestamp: number;
  durationMs?: number;
}

export interface NetworkLog extends NetworkPayload {
  id: string;
  sessionId: string;
}

export interface ResourceTimingEvent extends BaseEvent {
  kind: 'resource_timing';
  /** Summary of resources loaded during this page load. */
  resources: ResourceSummary[];
  pageUrl?: string;
  confidence: 'observed';
}

export interface ConsoleErrorEvent extends BaseEvent {
  kind: 'console_error';
  message: string;
  stack?: string;
  pageUrl?: string;
  confidence: 'observed';
}

export interface ConsoleWarnEvent extends BaseEvent {
  kind: 'console_warn';
  message: string;
  stack?: string;
  pageUrl?: string;
  confidence: 'observed';
}

export interface PageErrorEvent extends BaseEvent {
  kind: 'page_error';
  type: 'uncaught' | 'unhandled_rejection';
  message: string;
  source?: string;
  lineno?: number;
  colno?: number;
  pageUrl?: string;
  confidence: 'observed';
}

export interface DomChangeEvent extends BaseEvent {
  kind: 'dom_change';
  summary: string;
  changeSignature: string;
  pageUrl?: string;
  confidence: 'observed';
}

export interface NegativeInferenceEvent extends BaseEvent {
  kind: 'negative_inference';
  confidence: 'inferred-high' | 'inferred-low';
  signals: string[];
  evidenceEventIds: string[];
  testerVerdict?: 'confirmed' | 'rejected';
}

export type EvidenceTrigger =
  | 'manual'
  | 'session_start'
  | 'session_end'
  | 'http_error'
  | 'network_error'
  | 'page_error'
  | 'console_error'
  | 'navigation'
  | 'dom_change'
  /** API completed — viewport captured after React/Vue settles (400ms post-complete) */
  | 'api_complete'
  /** API in-flight > 500ms — captures loading/skeleton state */
  | 'api_loading'
  /** IntersectionObserver: a loaded component just scrolled into viewport */
  | 'component_visible'
  /** User clicked an element — "before state" capture */
  | 'user_action'
  /** State stabilized within N ms after a click — "after state" capture */
  | 'user_action_after';

export type UnavailableReason =
  | 'tab_not_active' | 'restricted_url' | 'paused'
  | 'sensitive_field_focused' | 'throttled' | 'quota_exceeded'
  | 'capture_failed' | 'worker_terminated' | 'tab_not_found';

export interface EvidenceRequestedEvent extends BaseEvent {
  kind: 'evidence_requested';
  trigger: EvidenceTrigger;
  triggerEventId?: string;
  /** If this capture belongs to a click-driven step, the step id. */
  stepId?: string;
  note?: string;
  pageUrl?: string;
  confidence: 'observed';
}

export interface EvidenceStoredEvent extends BaseEvent {
  kind: 'evidence_stored';
  requestedEventId: string;
  trigger: EvidenceTrigger;
  blobKey: string;
  width: number;
  height: number;
  bytes: number;
  format: 'image/webp' | 'image/jpeg' | 'image/png';
  pageUrl?: string;
  note?: string;
  /**
   * Confidence of the SIGNAL that triggered this capture, not of the image.
   * The screenshot itself is always a direct observation; the reason we took
   * it may be inferred (e.g. a heuristic state-change detector).
   */
  confidence: Confidence;
  /**
   * Inferred UI component name derived from the triggering API path.
   * e.g. "Inventory Health", "Order Recommendations".
   * Null for non-API triggered screenshots.
   */
  componentName?: string;
  /**
   * For api_complete screenshots: the requestId of the API that triggered it.
   * Allows the report to correlate screenshot ↔ API ↔ timing ↔ outcome.
   */
  apiRequestId?: string;
  /**
   * Whether this screenshot is the "loading" state (API in-flight)
   * or the "loaded/settled" state (API complete).
   */
  capturePhase?: 'loading' | 'complete';
  /**
   * Whether the captured component was above the fold at capture time.
   * False = it may be partially or fully below the viewport.
   */
  aboveFold?: boolean;
  /**
   * If this screenshot belongs to a click-driven step, the step id.
   * Non-null for user_action and user_action_after triggers; also set on any
   * signal-based capture that landed inside a step's stability window.
   */
  stepId?: string;
  /** Which frame of the step this evidence represents. */
  stepFrame?: 'before' | 'after' | 'system';
}

export interface EvidenceFailedEvent extends BaseEvent {
  kind: 'evidence_failed';
  requestedEventId: string;
  trigger: EvidenceTrigger;
  unavailableReason: UnavailableReason;
  detail?: string;
  confidence: 'observed';
}

export type TestEvent =
  | SessionStartEvent | SessionEndEvent | CheckpointEvent
  | NavigationEvent | UserClickEvent | RageClickEvent
  | NetPhaseEvent | WebVitalEvent | PageTimingEvent
  | LongTaskEvent | MemorySnapshotEvent | DomMetricsEvent
  | CspViolationEvent | ResourceTimingEvent
  | ConsoleErrorEvent | ConsoleWarnEvent | PageErrorEvent
  | DomChangeEvent | NegativeInferenceEvent
  | EvidenceRequestedEvent | EvidenceStoredEvent | EvidenceFailedEvent
  | CapturePausedEvent | CaptureResumedEvent;

// ─── Derived ──────────────────────────────────────────────────────────────────

export type RequestOutcome = 'success' | 'http_error' | 'network_error' | 'pending';

export interface RequestView {
  requestId: string;
  sessionId: string;
  method: string;
  url: string;
  origin: string;
  path: string;
  resourceType: string;
  tabId: number;
  frameId?: number;
  initiator?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: Record<string, string>;
  droppedHeaderCount: number;
  fromCache?: boolean;
  responseSize?: number;
  errorText?: string;
  outcome: RequestOutcome;
  seq: number;
  /** True if initiator is a different origin from the scope origins */
  isThirdParty?: boolean;
}

export type FindingType = 'HTTP_ERROR' | 'NETWORK_ERROR' | 'PAGE_ERROR' | 'CONSOLE_ERROR' | 'CONSOLE_WARN' | 'MANUAL_EVIDENCE' | 'PERFORMANCE' | 'RAGE_CLICK';
export type FindingDisposition = 'observed-failure' | 'expected-negative' | 'tester-marked';

export interface InferredLink {
  eventId: string;
  confidence: Extract<Confidence, 'inferred-high' | 'inferred-low'>;
  rationale: string;
  gapMs: number;
}

export interface Finding {
  id: string;
  type: FindingType;
  disposition: FindingDisposition;
  /** Auto-derived severity. Tester can override. */
  severity: FindingSeverity;
  /** Tester-managed status. */
  status: FindingStatus;
  /** Tester annotation: "expected X, got Y" */
  testerNote?: string;
  ts: number;
  seq: number;
  request?: RequestView;
  primaryEventId: string;
  pageUrl?: string;
  likelyPrecededBy?: InferredLink;
  evidence: EvidenceStoredEvent[];
  unavailable: EvidenceFailedEvent[];
  relatedErrors: Array<ConsoleErrorEvent | ConsoleWarnEvent | PageErrorEvent>;
  domChangeAfter?: DomChangeEvent;
  note?: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  name: string;
  ts: number;
  seq: number;
  source: CheckpointSource;
  pageUrl?: string;
  eventIds: string[];
  note?: string;
}

// ─── Steps (click-driven test primitive) ─────────────────────────────────
// A Step groups a user click (or a coalesced burst of clicks) with its
// "before" screenshot, its "after" screenshot (post-stability), and any
// system-detected evidence that landed inside the step's stability window.

/** Where a note/bug was pinned on a step screenshot. */
export interface StepPin {
  /** Which screenshot the pin belongs to. */
  target: 'before' | 'after';
  /** Horizontal position as a percentage (0-100) of the rendered image. */
  x: number;
  /** Vertical position as a percentage (0-100) of the rendered image. */
  y: number;
}

export interface StepNote {
  id: string;
  text: string;
  /** Present when the note was pinned to a screenshot. */
  pin?: StepPin;
}

export interface StepBug {
  id: string;
  description: string;
  /** Present when the bug was pinned to a screenshot. */
  pin?: StepPin;
}

export interface Step {
  id: string;
  sessionId: string;
  tabId: number;
  /** 1-based step number within the session. */
  index: number;
  /** ts of the first click that opened the step. */
  ts: number;
  seq: number;
  /** Auto-generated label; user-editable in the report. */
  label: string;
  semanticLabel?: string;
  customLabel?: string;
  qaNote?: string;
  /** Multiple QA notes (supersedes `qaNote`, which is kept for back-compat). */
  qaNotes?: StepNote[];
  isBug?: boolean;
  bugDescription?: string;
  bugs?: StepBug[];
  /** Non-empty when the tester overrides `label` in the report. */
  labelOverride?: string;
  /** URL of the page when the step started. */
  pageUrl?: string;
  /** Click event ids grouped into this step (>=1; multiple if coalesced). */
  clickEventIds: string[];
  /** Bounding rect of the first click's target, for post-render highlight. */
  elementRect?: ElementRect;
  /** Evidence event ids captured for this step. */
  beforeEvidenceEventId?: string;
  afterEvidenceEventId?: string;
  /** Signal-engine captures that landed inside this step's stability window. */
  systemEvidenceEventIds: string[];
  /** True if no state change was detected within the stability window. */
  noChangeDetected?: boolean;
  /** Tester-authored note attached to this step. */
  note?: string;
}

export interface SessionReport {
  session: Session;
  events: TestEvent[];
  requests: RequestView[];
  findings: Finding[];
  checkpoints: Checkpoint[];
  steps: Step[];
  negativeInference?: NegativeInferenceEvent;
  correlationVersion: number;
}
