import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { EvidenceStoredEvent, NetworkLog, Session, SessionStatus, Step, StepBug, StepNote, StepPin } from '../../core/types.js';
import type { AuthStatusPayload } from '../../core/auth.js';
import { normalizeStepBugs, normalizeStepNotes, stepLabel } from '../../core/step-helpers.js';
import { sanitizeDownloadFilename, sanitizeFilenameSegment } from '../../core/security.js';
import {
  getBlob,
  getEventsForSession,
  getSession,
  getSessionExportData,
} from '../../storage/db.js';
import { Modal } from './Modal.js';
import { ExportModal } from './ExportModal.js';
import { PricingModal } from './PricingModal.js';
import type { ExportModalContext } from './ExportModal.js';
import { AnnotatableScreenshot } from './AnnotatableScreenshot.js';
import type { PinKind, ScreenshotHighlightRect, ScreenshotPin } from './AnnotatableScreenshot.js';
import { buildBflowArchive, importBflowArchiveAtomic } from '../export/bflow/archive.js';
import {
  buildExportPreflightSummary,
  defaultExportFormat,
  exportEligibilityIssue,
  isExportModalContextValid,
  type ExportFormat,
  type ExportPreflightSummary,
  type SessionSelectionMode,
} from './export-ux.js';
import { getNextMenuIndex, isKeyboardActivationKey } from '../shared/a11y.js';
import { copyFeatureEvidence, copySessionEvidence } from '../export/clipboard/copy-evidence.js';

interface WorkspaceStep {
  step: Step;
  beforeScreenshotUrl?: string;
  afterScreenshotUrl?: string;
  transitionBadge?: string;
  noAfterNeeded?: boolean;
}

interface TraceStepRow {
  type: 'step';
  id: string;
  ts: number;
  step: WorkspaceStep;
}

interface TraceLogRow {
  type: 'log';
  id: string;
  ts: number;
  log: NetworkLog;
}

interface TraceConsoleRow {
  type: 'console';
  id: string;
  ts: number;
  level: 'error' | 'warn';
  message: string;
  pageUrl?: string;
}

type TraceTimelineRow = TraceStepRow | TraceLogRow | TraceConsoleRow;

type InspectorTab = 'headers' | 'payload' | 'response';
type WorkspaceViewTab = 'qa' | 'dev';
type FeatureTab = 'Test Cases' | 'Bug Tracker';
type DashboardRouteView = 'dashboard' | 'welcome' | 'pricing';
type TestCaseOutcomeFilter = 'all' | 'pass' | 'fail' | 'blocked' | 'draft';

interface FeatureSummary {
  featureName: string;
  count: number;
  passed: number;
  failed: number;
  blocked: number;
  testCaseCount: number;
  openBugCount: number;
}

interface FeatureNetworkStats {
  totalRequests: number;
  successCount: number;
  warnCount: number;
  errorCount: number;
  fastRequests: number;
  avgRequests: number;
  slowRequests: number;
  avgLatency: number;
  topSlowest: NetworkLog[];
}

/** One issue: a manually reported bug, or a technical step failure. */
interface BugTrackerRow {
  id: string;
  testCase: string;
  runId: string;
  runLabel: string;
  runStartedAt: number;
  stepIndex: number;
  stepTitle: string;
  kind: 'manual' | 'technical';
  status: 'manual' | 'fail' | 'error';
  description: string;
  /** Present when the bug was pinned to a screenshot. */
  pinned: boolean;
}

interface TestCaseGroup {
  testCaseName: string;
  runs: Session[];
}

interface ModalConfig {
  title: string;
  body: string;
  inputPlaceholder?: string;
  inputValue?: string;
  isDanger?: boolean;
  onConfirm: (value: string) => void | Promise<void>;
}

interface UiToast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface DropdownItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  meta?: string;
  badge?: string;
  badgeClass?: 'badge-muted' | 'badge-warning' | 'badge-danger';
}

interface CustomDropdownProps {
  anchorLabel: JSX.Element | string;
  items: DropdownItem[];
  buttonClass?: string;
  buttonAriaLabel?: string;
  disabled?: boolean;
  menuAlign?: 'left' | 'right';
}

function CustomDropdown({
  anchorLabel,
  items,
  buttonClass = 'btn btn-outline',
  buttonAriaLabel,
  disabled = false,
  menuAlign = 'right',
}: CustomDropdownProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dropdownIdRef = useRef(`dropdown-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    const onAnyDropdownOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      if (detail?.id !== dropdownIdRef.current) setIsOpen(false);
    };

    document.addEventListener('tt:dropdown-open', onAnyDropdownOpen as EventListener);
    return () => document.removeEventListener('tt:dropdown-open', onAnyDropdownOpen as EventListener);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const close = (event: MouseEvent): void => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => getNextMenuIndex(prev, items.length, 'ArrowDown'));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => getNextMenuIndex(prev, items.length, 'ArrowUp'));
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(getNextMenuIndex(activeIndex, items.length, 'Home'));
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(getNextMenuIndex(activeIndex, items.length, 'End'));
        return;
      }
      if (isKeyboardActivationKey(event.key) && items[activeIndex]) {
        event.preventDefault();
        setIsOpen(false);
        items[activeIndex]!.onSelect();
      }
    };

    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, isOpen, items]);

  useEffect(() => {
    if (!isOpen) return;
    setActiveIndex(0);
  }, [isOpen]);

  return (
    <div class="custom-dropdown" ref={wrapperRef}>
      <button
        ref={buttonRef}
        class={buttonClass}
        disabled={disabled}
        aria-label={buttonAriaLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={dropdownIdRef.current}
        onClick={(event) => {
          event.stopPropagation();
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          if (nextOpen) {
            document.dispatchEvent(new CustomEvent('tt:dropdown-open', {
              detail: { id: dropdownIdRef.current },
            }));
          }
        }}
      >
        {anchorLabel}
      </button>
      {isOpen && (
        <div id={dropdownIdRef.current} role="menu" class={`custom-dropdown-menu ${menuAlign === 'left' ? 'align-left' : 'align-right'}`}>
          {items.map((item, index) => (
            <button
              key={`${item.label}-${item.meta ?? ''}`}
              class={`custom-dropdown-item ${item.danger ? 'danger' : ''} ${index === activeIndex ? 'active' : ''}`}
              role="menuitem"
              aria-current={index === activeIndex ? 'true' : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={(event) => {
                event.stopPropagation();
                setIsOpen(false);
                item.onSelect();
              }}
            >
              <div class="custom-dropdown-item-main">
                <span>{item.label}</span>
                {item.badge && <span class={`badge ${item.badgeClass ?? 'badge-muted'}`}>{item.badge}</span>}
              </div>
              {item.meta && <div class="custom-dropdown-item-meta">{item.meta}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


function buildTransitionBadge(beforeUrl: string | undefined, afterUrl: string | undefined): string | undefined {
  if (!beforeUrl || !afterUrl) return undefined;
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    if (before.origin !== after.origin) return `Origin changed: ${before.host} -> ${after.host}`;
    const beforePath = `${before.pathname}${before.search}${before.hash}`;
    const afterPath = `${after.pathname}${after.search}${after.hash}`;
    if (beforePath !== afterPath) return `Navigated: ${beforePath || '/'} -> ${afterPath || '/'}`;
    return undefined;
  } catch {
    return undefined;
  }
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function endpointForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function pathnameForUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function runtimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: unknown) => resolve(response as T));
  });
}

async function buildEvidenceMap(sessionId: string): Promise<Map<string, EvidenceStoredEvent>> {
  const events = await getEventsForSession(sessionId);
  const evidenceById = new Map<string, EvidenceStoredEvent>();
  for (const event of events) {
    if (event.kind === 'evidence_stored') evidenceById.set(event.id, event);
  }
  return evidenceById;
}

async function resolveObjectUrl(
  blobKey: string | undefined,
  blobUrlsRef: { current: string[] },
): Promise<string | undefined> {
  if (!blobKey) return undefined;
  const blob = await getBlob(blobKey);
  if (!blob) return undefined;
  const copied = new Uint8Array(new ArrayBuffer(blob.data.byteLength));
  copied.set(blob.data);
  const objectUrl = URL.createObjectURL(new Blob([copied], { type: blob.mimeType }));
  blobUrlsRef.current.push(objectUrl);
  return objectUrl;
}

async function resolveStepScreenshots(
  step: Step,
  evidenceById: Map<string, EvidenceStoredEvent>,
  blobUrlsRef: { current: string[] },
): Promise<{ beforeScreenshotUrl?: string; afterScreenshotUrl?: string; transitionBadge?: string; noAfterNeeded?: boolean }> {
  const beforeEv = step.beforeEvidenceEventId ? evidenceById.get(step.beforeEvidenceEventId) : undefined;
  const afterEv = step.afterEvidenceEventId ? evidenceById.get(step.afterEvidenceEventId) : undefined;

  const beforeScreenshotUrl = await resolveObjectUrl(beforeEv?.blobKey, blobUrlsRef);
  const afterScreenshotUrl = await resolveObjectUrl(afterEv?.blobKey, blobUrlsRef);

  return {
    beforeScreenshotUrl,
    afterScreenshotUrl,
    transitionBadge: buildTransitionBadge(beforeEv?.pageUrl ?? step.pageUrl, afterEv?.pageUrl),
    noAfterNeeded: Boolean(step.noChangeDetected && !afterEv),
  };
}

function networkStatusClass(status: number): 'success' | 'warning' | 'critical' {
  if (status >= 500 || status === 0) return 'critical';
  if (status >= 400) return 'warning';
  return 'success';
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const out = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current];
      if (item === undefined) continue;
      out[current] = await mapper(item, current);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return out;
}



const MAX_STEP_NOTES = 5;
const MAX_STEP_BUGS = 5;
/** Keeps pinned annotations short enough to read in a popover. */
const MAX_ENTRY_CHARS = 220;


function toStepNoteUpdate(notes: StepNote[]): Pick<Step, 'qaNotes' | 'qaNote'> {
  return {
    qaNotes: notes,
    qaNote: notes[0]?.text?.trim() || undefined,
  };
}

/** Pins for one screenshot, from a step's notes and bugs. */
function screenshotPins(step: Step, target: 'before' | 'after'): ScreenshotPin[] {
  return [
    ...normalizeStepNotes(step)
      .filter((note) => note.pin?.target === target)
      .map((note) => ({ id: note.id, kind: 'note' as const, text: note.text, pin: note.pin! })),
    ...normalizeStepBugs(step)
      .filter((bug) => bug.pin?.target === target)
      .map((bug) => ({ id: bug.id, kind: 'bug' as const, text: bug.description, pin: bug.pin! })),
  ];
}

function beforeHighlightRect(step: Step): ScreenshotHighlightRect | undefined {
  const rect = step.elementRect;
  if (!rect || rect.viewportWidth <= 0 || rect.viewportHeight <= 0) return undefined;

  const xPercent = Math.min(100, Math.max(0, (rect.x / rect.viewportWidth) * 100));
  const yPercent = Math.min(100, Math.max(0, (rect.y / rect.viewportHeight) * 100));
  const widthPercent = Math.min(100, Math.max(0, (rect.width / rect.viewportWidth) * 100));
  const heightPercent = Math.min(100, Math.max(0, (rect.height / rect.viewportHeight) * 100));
  if (widthPercent <= 0 || heightPercent <= 0) return undefined;

  return { xPercent, yPercent, widthPercent, heightPercent };
}

function toStepBugUpdate(bugs: StepBug[]): Pick<Step, 'bugs' | 'isBug' | 'bugDescription'> {
  return {
    bugs,
    isBug: bugs.length > 0,
    bugDescription: bugs[0]?.description?.trim() || undefined,
  };
}

function findNearbyNetworkErrors(stepTs: number, logs: readonly NetworkLog[]): NetworkLog[] {
  const windowMs = 4000;
  return logs.filter((log) => log.status >= 400 && Math.abs(log.timestamp - stepTs) <= windowMs);
}

function parseDashboardRouteFromLocation(location: Location): DashboardRouteView {
  const view = new URLSearchParams(location.search).get('view');
  if (view === 'welcome' || view === 'pricing' || view === 'dashboard') return view;

  if (location.pathname === '/welcome') return 'welcome';
  if (location.pathname === '/pricing') return 'pricing';
  return 'dashboard';
}

function buildDashboardUrl(view: DashboardRouteView): string {
  const url = new URL(window.location.href);
  url.pathname = '/ui/dashboard/dashboard.html';
  if (view === 'dashboard') {
    url.searchParams.delete('view');
  } else {
    url.searchParams.set('view', view);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}


interface WorkspaceConsoleEvent {
  id: string;
  ts: number;
  level: 'error' | 'warn';
  message: string;
  pageUrl?: string;
}

function DashboardApp(): JSX.Element {
  const [featureSummaries, setFeatureSummaries] = useState<FeatureSummary[]>([]);
  const [activeFeature, setActiveFeature] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [featureSessions, setFeatureSessions] = useState<Session[]>([]);
  const [featureNetworkStats, setFeatureNetworkStats] = useState<FeatureNetworkStats>({
    totalRequests: 0,
    successCount: 0,
    warnCount: 0,
    errorCount: 0,
    fastRequests: 0,
    avgRequests: 0,
    slowRequests: 0,
    avgLatency: 0,
    topSlowest: [],
  });
  const [workspaceSteps, setWorkspaceSteps] = useState<WorkspaceStep[]>([]);
  const [workspaceNetworkLogs, setWorkspaceNetworkLogs] = useState<NetworkLog[]>([]);
  const [workspaceConsoleEvents, setWorkspaceConsoleEvents] = useState<WorkspaceConsoleEvent[]>([]);
  const [devtoolsFilter, setDevtoolsFilter] = useState('');
  const [viewTab, setViewTab] = useState<WorkspaceViewTab>('qa');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('headers');
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [activeTab, setActiveTab] = useState<FeatureTab>('Test Cases');
  const [bugTrackerRows, setBugTrackerRows] = useState<BugTrackerRow[]>([]);
  const [bugTrackerLoading, setBugTrackerLoading] = useState(false);
  const [showStaleBugs, setShowStaleBugs] = useState(false);
  const [featureSearch, setFeatureSearch] = useState('');
  const [testCaseSearch, setTestCaseSearch] = useState('');
  const [testCaseOutcomeFilter, setTestCaseOutcomeFilter] = useState<TestCaseOutcomeFilter>('all');
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isGeneratingWord, setIsGeneratingWord] = useState(false);
  const [isGeneratingExcel, setIsGeneratingExcel] = useState(false);
  const [isExportingBflow, setIsExportingBflow] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportModalContext, setExportModalContext] = useState<ExportModalContext>('feature');
  const [selectedExportFormat, setSelectedExportFormat] = useState<ExportFormat>(defaultExportFormat());
  const [sessionSelectionMode, setSessionSelectionMode] = useState<SessionSelectionMode>('latest');
  const [isExportPreflighting, setIsExportPreflighting] = useState(false);
  const [exportPreflight, setExportPreflight] = useState<ExportPreflightSummary | null>(null);
  const [exportStatusText, setExportStatusText] = useState<string | null>(null);
  const [isCopyingEvidence, setIsCopyingEvidence] = useState(false);
  const [isBflowDragging, setIsBflowDragging] = useState(false);
  const [isImportingBflow, setIsImportingBflow] = useState(false);
  const [routeView, setRouteView] = useState<DashboardRouteView>(() => parseDashboardRouteFromLocation(window.location));
  const [modalState, setModalState] = useState<ModalConfig | null>(null);
  const [toasts, setToasts] = useState<UiToast[]>([]);
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [routingApplied, setRoutingApplied] = useState(false);
  const blobUrlsRef = useRef<string[]>([]);
  const exportInFlightRef = useRef(false);
  const pendingViewTabRef = useRef<WorkspaceViewTab | null>(null);
  const pendingTraceStepIndexRef = useRef<number | null>(null);
  const lastNonPricingRouteRef = useRef<DashboardRouteView>(routeView === 'pricing' ? 'dashboard' : routeView);

  const clearBlobUrls = (): void => {
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current = [];
  };

  const pushToast = (message: string, tone: UiToast['tone'] = 'success'): void => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 2600);
  };

  const navigateToView = (nextView: DashboardRouteView, mode: 'push' | 'replace' = 'push'): void => {
    const nextUrl = buildDashboardUrl(nextView);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl && nextView === routeView) {
      return;
    }

    if (nextView === 'pricing' && routeView !== 'pricing') {
      lastNonPricingRouteRef.current = routeView;
    } else if (nextView !== 'pricing') {
      lastNonPricingRouteRef.current = nextView;
    }

    if (mode === 'replace') {
      window.history.replaceState({}, '', nextUrl);
    } else {
      window.history.pushState({}, '', nextUrl);
    }
    setRouteView(nextView);
  };

  const openPricing = (): void => {
    navigateToView('pricing');
  };

  const closePricing = (): void => {
    const fallback = lastNonPricingRouteRef.current === 'pricing' ? 'dashboard' : lastNonPricingRouteRef.current;
    navigateToView(fallback, 'replace');
  };

  const refreshAuthStatus = useCallback(async (refreshIfNeeded = true): Promise<void> => {
    setAuthLoading(true);
    const response = await runtimeMessage<{ ok?: boolean; status?: AuthStatusPayload }>({ type: 'TT_AUTH_GET_STATUS', refreshIfNeeded });
    setAuthStatus(response?.ok === true && response.status ? response.status : null);
    setAuthLoading(false);
  }, []);

  useEffect(() => {
    void refreshAuthStatus(true);
  }, [refreshAuthStatus]);

  useEffect(() => {
    if (!routingApplied || authLoading) return;
    const isSignedIn = authStatus?.signedIn === true;
    if (!isSignedIn && activeFeature && routeView !== 'pricing') {
      navigateToView('pricing', 'replace');
    }
  }, [activeFeature, authLoading, authStatus, routeView, routingApplied]);

  useEffect(() => {
    const syncRouteFromBrowser = (): void => {
      const nextView = parseDashboardRouteFromLocation(window.location);
      if (window.location.pathname === '/welcome' || window.location.pathname === '/pricing') {
        window.history.replaceState({}, '', buildDashboardUrl(nextView));
      }
      setRouteView(nextView);
      if (nextView !== 'pricing') {
        lastNonPricingRouteRef.current = nextView;
      }
    };

    syncRouteFromBrowser();
    window.addEventListener('popstate', syncRouteFromBrowser);
    return () => window.removeEventListener('popstate', syncRouteFromBrowser);
  }, []);

  const loadFeatureSummaries = async (): Promise<void> => {
    const resp = await runtimeMessage<unknown>({ type: 'TT_GET_FEATURE_SUMMARIES' });
    if (!Array.isArray(resp)) {
      setFeatureSummaries([]);
      return;
    }

    const rows: FeatureSummary[] = [];
    for (const item of resp) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const featureName = typeof record['featureName'] === 'string' ? record['featureName'].trim() : '';
      if (!featureName) continue;
      const count = typeof record['count'] === 'number' ? record['count'] : 0;
      const passed = typeof record['passed'] === 'number' ? record['passed'] : 0;
      const failed = typeof record['failed'] === 'number' ? record['failed'] : 0;
      const blocked = typeof record['blocked'] === 'number' ? record['blocked'] : 0;
      const testCaseCount = typeof record['testCaseCount'] === 'number' ? record['testCaseCount'] : 0;
      const openBugCount = typeof record['openBugCount'] === 'number' ? record['openBugCount'] : 0;
      rows.push({ featureName, count, passed, failed, blocked, testCaseCount, openBugCount });
    }

    setFeatureSummaries(rows);
  };

  const loadSessionsForFeature = async (featureName: string): Promise<Session[]> => {
    const resp = await runtimeMessage<unknown>({ type: 'TT_GET_SESSIONS_BY_FEATURE', featureName });
    if (!Array.isArray(resp)) {
      setFeatureSessions([]);
      return [];
    }
    const sorted = (resp as Session[]).sort((a, b) => b.startedAt - a.startedAt);
    setFeatureSessions(sorted);
    return sorted;
  };

  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const rawFeature = params.get('feature');
      const rawSession = params.get('session');
      const urlFeature = rawFeature?.trim() ? rawFeature.trim() : null;
      const urlSession = rawSession?.trim() ? rawSession.trim() : null;

      await loadFeatureSummaries();

      if (!urlFeature && !urlSession) {
        setRoutingApplied(true);
        return;
      }

      let routedFeature = urlFeature;
      let routedSession: Session | null = null;

      if (urlSession) {
        routedSession = (await getSession(urlSession)) ?? null;
        const sessionFeature = routedSession?.featureName?.trim();
        if (sessionFeature) {
          // Session URL is source of truth; recover from missing or mismatched feature param.
          routedFeature = sessionFeature;
        }
      }

      if (routedFeature) {
        setActiveFeature(routedFeature);
        const sessions = await loadSessionsForFeature(routedFeature);
        if (routedSession && routedSession.featureName?.trim() === routedFeature) {
          setActiveSession(routedSession);
        } else if (urlSession) {
          const found = sessions.find((session) => session.id === urlSession) ?? null;
          setActiveSession(found);
        }
      }

      setRoutingApplied(true);
    })();
  }, []);

  useEffect(() => {
    if (!activeFeature) return;
    void loadSessionsForFeature(activeFeature);
  }, [activeFeature]);

  useEffect(() => {
    if (!activeFeature) {
      setTestCaseOutcomeFilter('all');
      return;
    }
    setTestCaseOutcomeFilter('all');
  }, [activeFeature]);

  useEffect(() => {
    if (!activeSession) return;
    const latest = featureSessions.find((session) => session.id === activeSession.id);
    if (!latest) {
      setActiveSession(null);
      return;
    }
    if (latest !== activeSession) setActiveSession(latest);
  }, [featureSessions, activeSession]);

  useEffect(() => {
    if (!activeFeature) {
      setFeatureNetworkStats({
        totalRequests: 0,
        successCount: 0,
        warnCount: 0,
        errorCount: 0,
        fastRequests: 0,
        avgRequests: 0,
        slowRequests: 0,
        avgLatency: 0,
        topSlowest: [],
      });
      return;
    }

    let cancelled = false;

    void (async () => {
      const response = await runtimeMessage<unknown>({ type: 'TT_GET_FEATURE_NETWORK_STATS', featureName: activeFeature });
      if (cancelled || typeof response !== 'object' || response === null) return;

      const record = response as Record<string, unknown>;
      const toFiniteNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      const totalRequests = toFiniteNumber(record['totalRequests']);
      const successCount = toFiniteNumber(record['successCount']);
      const warnCount = toFiniteNumber(record['warnCount']);
      const errorCount = toFiniteNumber(record['errorCount']);
      const fastRequests = toFiniteNumber(record['fastRequests']);
      const avgRequests = toFiniteNumber(record['avgRequests']);
      const slowRequests = toFiniteNumber(record['slowRequests']);
      const avgLatency = toFiniteNumber(record['avgLatency']);
      const topSlowest = Array.isArray(record['topSlowest']) ? (record['topSlowest'] as NetworkLog[]) : [];

      setFeatureNetworkStats({
        totalRequests,
        successCount,
        warnCount,
        errorCount,
        fastRequests,
        avgRequests,
        slowRequests,
        avgLatency,
        topSlowest,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFeature, featureSessions.length]);

  useEffect(() => {
    clearBlobUrls();

    if (!activeSession) {
      setWorkspaceSteps([]);
      setWorkspaceNetworkLogs([]);
      setWorkspaceConsoleEvents([]);
      setSelectedLogId(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const [stepsResp, networkResp] = await Promise.all([
        runtimeMessage<unknown>({ type: 'TT_GET_SESSION_STEPS', sessionId: activeSession.id }),
        runtimeMessage<unknown>({ type: 'TT_GET_NETWORK_LOGS', sessionId: activeSession.id }),
      ]);

      if (!Array.isArray(stepsResp) || !Array.isArray(networkResp)) {
        setWorkspaceSteps([]);
        setWorkspaceNetworkLogs([]);
        setWorkspaceConsoleEvents([]);
        return;
      }

      const steps = (stepsResp as Step[]).sort((a, b) => a.ts - b.ts || a.index - b.index);
      const networkLogs = (networkResp as NetworkLog[]).sort((a, b) => a.timestamp - b.timestamp);
      const events = await getEventsForSession(activeSession.id);
      const consoleEvents = events
        .filter((event) => event.kind === 'console_error' || event.kind === 'console_warn')
        .map((event) => ({
          id: event.id,
          ts: event.ts,
          level: event.kind === 'console_error' ? 'error' as const : 'warn' as const,
          message: event.message,
          pageUrl: event.pageUrl,
        }))
        .sort((a, b) => a.ts - b.ts);
      const evidenceById = await buildEvidenceMap(activeSession.id);

      const cards = await mapWithConcurrency<Step, WorkspaceStep>(steps, 6, async (step) => {
        const visuals = await resolveStepScreenshots(step, evidenceById, blobUrlsRef);
        return {
          step,
          ...visuals,
        };
      });

      if (!cancelled) {
        setWorkspaceSteps(cards);
        setWorkspaceNetworkLogs(networkLogs);
        setWorkspaceConsoleEvents(consoleEvents);
        setViewTab(pendingViewTabRef.current ?? 'qa');
        pendingViewTabRef.current = null;
        setSelectedLogId((current) => {
          if (!current) return networkLogs[0]?.id ?? null;
          return networkLogs.some((log) => log.id === current) ? current : (networkLogs[0]?.id ?? null);
        });
      }
    })();

    return () => {
      cancelled = true;
      clearBlobUrls();
    };
  }, [activeSession]);

  useEffect(() => {
    if (!activeFeature || activeTab !== 'Bug Tracker') {
      setBugTrackerRows([]);
      setBugTrackerLoading(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      setBugTrackerLoading(true);
      const sourceSessions = showStaleBugs
        ? featureSessions
        : (() => {
            const latestByCase = new Map<string, Session>();
            for (const session of featureSessions) {
              const testCase = session.testCaseName?.trim() || 'Untitled Test Case';
              const current = latestByCase.get(testCase);
              if (!current || session.startedAt > current.startedAt) {
                latestByCase.set(testCase, session);
              }
            }
            return [...latestByCase.values()];
          })();
      const rowsBySession = await mapWithConcurrency<Session, BugTrackerRow[]>(sourceSessions, 4, async (session) => {
        const stepsResp = await runtimeMessage<unknown>({ type: 'TT_GET_SESSION_STEPS', sessionId: session.id });
        if (!Array.isArray(stepsResp)) return [];
        const steps = (stepsResp as Step[]).sort((a, b) => a.index - b.index);

        const rows: BugTrackerRow[] = [];
        for (const step of steps) {
          const manualBugs = normalizeStepBugs(step);
          const stepStatus = ((step as Step & { status?: string }).status ?? '').toLowerCase();
          const hasTechnicalFailure = stepStatus === 'fail' || stepStatus === 'error';

          if (!manualBugs.length && !hasTechnicalFailure) continue;

          const shared = {
            testCase: session.testCaseName?.trim() || 'Untitled Test Case',
            runId: session.id,
            runLabel: new Date(session.startedAt).toLocaleString(),
            runStartedAt: session.startedAt,
            stepIndex: step.index,
            stepTitle: stepLabel(step),
          };

          // Each manual bug is its own row so testers can triage them individually.
          for (const bug of manualBugs) {
            rows.push({
              ...shared,
              id: `${session.id}-${step.index}-${bug.id}`,
              kind: 'manual',
              status: 'manual',
              description: bug.description || 'No description provided',
              pinned: Boolean(bug.pin),
            });
          }

          if (hasTechnicalFailure) {
            rows.push({
              ...shared,
              id: `${session.id}-${step.index}-technical`,
              kind: 'technical',
              status: stepStatus as 'fail' | 'error',
              description: `Technical step failure (${stepStatus || 'error'}) detected`,
              pinned: false,
            });
          }
        }

        // A failed test run must always be visible in Bug Tracker, even when
        // no step has a manual bug/failure marker yet.
        if ((session.status ?? 'draft') === 'fail' && rows.length === 0) {
          rows.push({
            id: `${session.id}-run-fail`,
            testCase: session.testCaseName?.trim() || 'Untitled Test Case',
            runId: session.id,
            runLabel: new Date(session.startedAt).toLocaleString(),
            runStartedAt: session.startedAt,
            stepIndex: 0,
            stepTitle: 'Run status',
            kind: 'technical',
            status: 'fail',
            description: 'Test case run marked FAILED (no step-level bug captured).',
            pinned: false,
          });
        }

        return rows;
      });

      if (cancelled) return;
      setBugTrackerRows(rowsBySession.flat());
      setBugTrackerLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFeature, activeTab, featureSessions, showStaleBugs]);

  const patchWorkspaceStep = (stepId: string, patch: Partial<Step>): void => {
    setWorkspaceSteps((prev) => prev.map((item) => {
      if (item.step.id !== stepId) return item;
      return { ...item, step: { ...item.step, ...patch } };
    }));
  };

  const persistSessionUpdate = (updates: Partial<Session>): void => {
    if (!activeSession) return;
    const next = { ...activeSession, ...updates };
    setActiveSession(next);
    setFeatureSessions((prev) => prev.map((session) => (session.id === next.id ? next : session)));
    chrome.runtime.sendMessage({ type: 'TT_UPDATE_SESSION', sessionId: next.id, updates });
  };

  const persistStepUpdate = (stepId: string, updates: Partial<Step>): void => {
    patchWorkspaceStep(stepId, updates);
    chrome.runtime.sendMessage({ type: 'TT_UPDATE_STEP', stepId, updates });
  };

  /** Latest run per test case for executive health metrics. */
  const latestFeatureRuns = useMemo(() => {
    const latestByCase = new Map<string, Session>();
    for (const session of featureSessions) {
      const testCase = session.testCaseName?.trim() || 'Untitled Test Case';
      const current = latestByCase.get(testCase);
      if (!current || session.startedAt > current.startedAt) {
        latestByCase.set(testCase, session);
      }
    }
    return [...latestByCase.values()];
  }, [featureSessions]);

  const summary = useMemo(() => {
    const totalCases = latestFeatureRuns.length;
    const passed = latestFeatureRuns.filter((s) => s.status === 'pass').length;
    const failed = latestFeatureRuns.filter((s) => s.status === 'fail').length;
    const blocked = latestFeatureRuns.filter((s) => s.status === 'blocked').length;

    const passPct = totalCases > 0 ? (passed / totalCases) * 100 : 0;
    const failPct = totalCases > 0 ? (failed / totalCases) * 100 : 0;
    const blockedPct = totalCases > 0 ? (blocked / totalCases) * 100 : 0;
    const donutGradient = `conic-gradient(#10b981 0% ${passPct}%, #ef4444 ${passPct}% ${passPct + failPct}%, #f59e0b ${passPct + failPct}% ${passPct + failPct + blockedPct}%, #e5e7eb ${passPct + failPct + blockedPct}% 100%)`;

    return { totalCases, passed, failed, blocked, passPct, failPct, blockedPct, donutGradient };
  }, [latestFeatureRuns]);

  const reliability = useMemo(() => {
    const totalRequests = featureNetworkStats.totalRequests;
    const successPct = totalRequests > 0 ? (featureNetworkStats.successCount / totalRequests) * 100 : 0;
    const warnPct = totalRequests > 0 ? (featureNetworkStats.warnCount / totalRequests) * 100 : 0;
    const criticalPct = totalRequests > 0 ? (featureNetworkStats.errorCount / totalRequests) * 100 : 0;

    return {
      successPct,
      warnPct,
      criticalPct,
      successRateLabel: `${successPct.toFixed(1)}%`,
    };
  }, [featureNetworkStats]);

  const latencyDistribution = useMemo(() => {
    const measuredCount = featureNetworkStats.fastRequests + featureNetworkStats.avgRequests + featureNetworkStats.slowRequests;
    const toPct = (value: number): number => (measuredCount > 0 ? (value / measuredCount) * 100 : 0);

    return {
      measuredCount,
      fastPct: toPct(featureNetworkStats.fastRequests),
      avgPct: toPct(featureNetworkStats.avgRequests),
      slowPct: toPct(featureNetworkStats.slowRequests),
    };
  }, [featureNetworkStats]);

  const testCaseGroups = useMemo<TestCaseGroup[]>(() => {
    const groups = new Map<string, Session[]>();
    for (const session of featureSessions) {
      const name = session.testCaseName?.trim() || 'Untitled Test Case';
      const runs = groups.get(name) ?? [];
      runs.push(session);
      groups.set(name, runs);
    }

    return [...groups.entries()]
      .map(([testCaseName, runs]) => ({
        testCaseName,
        runs: [...runs].sort((a, b) => b.startedAt - a.startedAt),
      }))
      .sort((a, b) => a.testCaseName.localeCompare(b.testCaseName));
  }, [featureSessions]);

  const latestRunsPerTestCase = useMemo<Session[]>(
    () => testCaseGroups
      .map((group) => group.runs[0])
      .filter((session): session is Session => Boolean(session)),
    [testCaseGroups],
  );

  const activeRuns = useMemo<Session[]>(() => {
    if (!activeSession) return [];
    const selected = testCaseGroups.find((group) => group.testCaseName === (activeSession.testCaseName?.trim() || 'Untitled Test Case'));
    return selected?.runs ?? [];
  }, [activeSession, testCaseGroups]);

  const runLabel = (session: Session, index: number, total: number): string => {
    const number = total - index;
    const latest = index === 0 ? ' (Latest)' : '';
    const status = (session.status ?? 'draft').toUpperCase();
    return `Run ${number}${latest} - ${status}`;
  };

  const filteredFeatureSummaries = useMemo(() => {
    const query = featureSearch.trim().toLowerCase();
    if (!query) return featureSummaries;
    return featureSummaries.filter((feature) => feature.featureName.toLowerCase().includes(query));
  }, [featureSummaries, featureSearch]);

  const filteredTestCaseGroups = useMemo(() => {
    const query = testCaseSearch.trim().toLowerCase();
    return testCaseGroups.filter((group) => {
      const latestStatus = group.runs[0]?.status ?? 'draft';
      const matchesStatus = testCaseOutcomeFilter === 'all' || latestStatus === testCaseOutcomeFilter;
      const matchesQuery = !query || group.testCaseName.toLowerCase().includes(query);
      return matchesStatus && matchesQuery;
    });
  }, [testCaseGroups, testCaseSearch, testCaseOutcomeFilter]);

  const selectedRunIndex = useMemo(
    () => activeRuns.findIndex((run) => run.id === activeSession?.id),
    [activeRuns, activeSession?.id],
  );

  const lastTenRuns = useMemo(() => activeRuns.slice(0, 10), [activeRuns]);

  const activeRunTone = useMemo<'pass' | 'fail' | 'warn'>(() => {
    const status = activeSession?.status ?? 'draft';
    if (status === 'pass') return 'pass';
    if (status === 'fail') return 'fail';
    return 'warn';
  }, [activeSession?.status]);

  const activeStatusTone = useMemo<'pass' | 'fail' | 'blocked' | 'draft'>(() => {
    const status = activeSession?.status ?? 'draft';
    if (status === 'pass' || status === 'fail' || status === 'blocked') return status;
    return 'draft';
  }, [activeSession?.status]);

  const activeTypeLabel = useMemo(() => activeSession?.testType ?? 'Positive', [activeSession?.testType]);

  const activeRunNumber = selectedRunIndex >= 0 ? activeRuns.length - selectedRunIndex : activeRuns.length;
  const isLatestRun = selectedRunIndex === 0;

  const activeRunSummary = useMemo(() => {
    const summaryCounts = { pass: 0, fail: 0, blocked: 0, draft: 0 };
    for (const run of activeRuns) {
      if (run.status === 'pass') summaryCounts.pass += 1;
      else if (run.status === 'fail') summaryCounts.fail += 1;
      else if (run.status === 'blocked') summaryCounts.blocked += 1;
      else summaryCounts.draft += 1;
    }
    return summaryCounts;
  }, [activeRuns]);

  const activeRunMix = useMemo(() => {
    const { pass, fail, blocked, draft } = activeRunSummary;
    const total = pass + fail + blocked + draft;
    if (total === 0) {
      return { total: 0, gradient: 'conic-gradient(#e5e7eb 0% 100%)', title: 'No runs yet' };
    }

    const pct = (value: number): number => (value / total) * 100;
    const passEnd = pct(pass);
    const failEnd = passEnd + pct(fail);
    const blockedEnd = failEnd + pct(blocked);

    return {
      total,
      gradient: `conic-gradient(#10b981 0% ${passEnd}%, #ef4444 ${passEnd}% ${failEnd}%, #f59e0b ${failEnd}% ${blockedEnd}%, #cbd5e1 ${blockedEnd}% 100%)`,
      title: `${total} runs - Pass ${pass}, Fail ${fail}, Blocked ${blocked}, Draft ${draft}`,
    };
  }, [activeRunSummary]);

  /** Issues grouped test case -> run, so each failure reads in context. */
  const bugTrackerGroups = useMemo(() => {
    const byTestCase = new Map<string, BugTrackerRow[]>();
    for (const row of bugTrackerRows) {
      const rows = byTestCase.get(row.testCase) ?? [];
      rows.push(row);
      byTestCase.set(row.testCase, rows);
    }

    return [...byTestCase.entries()]
      .map(([testCase, rows]) => {
        const byRun = new Map<string, BugTrackerRow[]>();
        for (const row of rows) {
          const runRows = byRun.get(row.runId) ?? [];
          runRows.push(row);
          byRun.set(row.runId, runRows);
        }

        const runs = [...byRun.entries()]
          .map(([runId, runRows]) => ({
            runId,
            runLabel: runRows[0]?.runLabel ?? 'Unknown run',
            runStartedAt: runRows[0]?.runStartedAt ?? 0,
            rows: [...runRows].sort((a, b) => a.stepIndex - b.stepIndex),
          }))
          .sort((a, b) => b.runStartedAt - a.runStartedAt);

        return {
          testCase,
          runs,
          total: rows.length,
          manualCount: rows.filter((row) => row.kind === 'manual').length,
          technicalCount: rows.filter((row) => row.kind === 'technical').length,
          affectedSteps: new Set(rows.map((row) => `${row.runId}-${row.stepIndex}`)).size,
        };
      })
      .sort((a, b) => b.total - a.total || a.testCase.localeCompare(b.testCase));
  }, [bugTrackerRows]);

  const bugTrackerTotals = useMemo(() => ({
    issues: bugTrackerRows.length,
    manual: bugTrackerRows.filter((row) => row.kind === 'manual').length,
    technical: bugTrackerRows.filter((row) => row.kind === 'technical').length,
    testCases: new Set(bugTrackerRows.map((row) => row.testCase)).size,
  }), [bugTrackerRows]);

  const jumpToDevTrace = (runId: string, stepIndex: number): void => {
    const target = featureSessions.find((session) => session.id === runId);
    if (!target) return;
    pendingViewTabRef.current = 'dev';
    pendingTraceStepIndexRef.current = stepIndex;
    setActiveTab('Test Cases');
    setActiveSession(target);
  };

  useEffect(() => {
    if (viewTab !== 'dev') return;
    const targetStep = pendingTraceStepIndexRef.current;
    if (targetStep === null) return;

    const targetElement = document.getElementById(`dev-step-${targetStep}`);
    if (!targetElement) return;

    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (targetElement instanceof HTMLDetailsElement) {
      targetElement.open = true;
    }
    pendingTraceStepIndexRef.current = null;
  }, [viewTab, workspaceSteps, activeSession]);

  const handleCopyEvidence = async (): Promise<void> => {
    if (exportModalContext === 'feature') {
      if (!activeFeature) {
        pushToast('Select a feature before copying evidence.', 'error');
        return;
      }
      setExportStatusText('Copying feature summary...');
      setIsCopyingEvidence(true);
      try {
        const sessions = resolveStructuredExportSessions('feature', sessionSelectionMode);
        const bundles = await loadBundlesForSessions(sessions);
        if (bundles.length === 0) throw new Error('Could not load runs for feature copy.');
        await copyFeatureEvidence(bundles, activeFeature);
        setExportStatusText('Feature summary copied');
        pushToast('Feature summary copied', 'success');
      } catch (error) {
        const message = error instanceof Error ? error.message : "Couldn't copy feature summary. Try again.";
        setExportStatusText(message);
        pushToast("Couldn't copy feature summary. Try again.", 'error');
        console.error('[dashboard] feature copy failed', error);
      } finally {
        setIsCopyingEvidence(false);
      }
      return;
    }

    if (!activeSession) {
      pushToast('Select a run before copying evidence.', 'error');
      return;
    }

    setExportStatusText('Copying evidence...');
    setIsCopyingEvidence(true);
    try {
      const bundle = await getSessionExportData(activeSession.id);
      if (!bundle) throw new Error('Could not load this run for copy evidence.');

      await copySessionEvidence(bundle);

      setExportStatusText('Evidence copied');
      pushToast('Evidence copied', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't copy evidence. Try again.";
      setExportStatusText(message);
      pushToast("Couldn't copy evidence. Try again.", 'error');
      console.error('[dashboard] copy evidence failed', error);
    } finally {
      setIsCopyingEvidence(false);
    }
  };

  /**
   * Per-step evidence severity. Reuses the 4s correlation window already
   * used by findNearbyNetworkErrors so the Evidence tab and copy-evidence
   * export agree on which errors belong to which step.
   */
  const stepSignals = useMemo(() => {
    const CORRELATION_WINDOW_MS = 4000;
    const map = new Map<string, {
      bugCount: number;
      netFailureCount: number;
      consoleErrorCount: number;
      severity: 'critical' | 'warn' | 'clean';
    }>();
    for (const item of workspaceSteps) {
      const bugCount = normalizeStepBugs(item.step).length;
      const netFailureCount = findNearbyNetworkErrors(item.step.ts, workspaceNetworkLogs).length;
      const consoleErrorCount = workspaceConsoleEvents.filter(
        (ev) => ev.level === 'error' && Math.abs(ev.ts - item.step.ts) <= CORRELATION_WINDOW_MS,
      ).length;
      const severity: 'critical' | 'warn' | 'clean' =
        bugCount > 0 || netFailureCount > 0
          ? 'critical'
          : consoleErrorCount > 0
            ? 'warn'
            : 'clean';
      map.set(item.step.id, { bugCount, netFailureCount, consoleErrorCount, severity });
    }
    return map;
  }, [workspaceSteps, workspaceNetworkLogs, workspaceConsoleEvents]);

  const runSummary = useMemo(() => {
    let bugs = 0;
    let netFailures = 0;
    let consoleErrors = 0;
    let critical = 0;
    let warn = 0;
    for (const [, sig] of stepSignals) {
      bugs += sig.bugCount;
      netFailures += sig.netFailureCount;
      consoleErrors += sig.consoleErrorCount;
      if (sig.severity === 'critical') critical += 1;
      else if (sig.severity === 'warn') warn += 1;
    }
    return { bugs, netFailures, consoleErrors, critical, warn };
  }, [stepSignals]);

  const runDurationLabel = useMemo(() => {
    if (!activeSession) return '—';
    const end = activeSession.endedAt ?? Date.now();
    const ms = Math.max(0, end - activeSession.startedAt);
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m ${rem}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }, [activeSession?.startedAt, activeSession?.endedAt]);

  const jumpToStep = (stepIndex: number): void => {
    const el = document.getElementById(`bf-step-${stepIndex}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('step-card--focus-pulse');
    window.setTimeout(() => el.classList.remove('step-card--focus-pulse'), 1400);
  };


  const downloadFileBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = sanitizeDownloadFilename(filename, 'businessflow-export.bin');
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const buildSessionExportFilename = (session: Session, extension: 'pdf' | 'docx' | 'xlsx'): string => {
    const safeFeature = sanitizeFilenameSegment(session.featureName || activeFeature || 'Session', 'Session');
    const safeCase = sanitizeFilenameSegment(session.testCaseName || 'Untitled', 'Untitled');
    const started = new Date(session.startedAt).toISOString().replace(/[:]/g, '-');
    return `${safeFeature}-${safeCase}-${started}.${extension}`;
  };

  const buildFeatureExportFilename = (extension: 'pdf' | 'docx' | 'xlsx'): string => {
    const safeFeature = sanitizeFilenameSegment(activeFeature || 'Feature', 'Feature');
    const exportedAt = new Date().toISOString().replace(/[:]/g, '-');
    return `${safeFeature}-all-test-cases-${exportedAt}.${extension}`;
  };

  const canUseSelectedRun = activeSession !== null;
  const canUseLatestRun = exportModalContext === 'test-case'
    ? activeRuns.length > 0
    : latestRunsPerTestCase.length > 0;
  const hasAnyExportableData = Boolean(activeFeature) && featureSessions.length > 0;
  const isAnyExportRunning = isGeneratingPdf || isGeneratingWord || isGeneratingExcel || isExportingBflow;

  useEffect(() => {
    if (!isExportModalOpen) return;

    const isValid = isExportModalContextValid(
      exportModalContext,
      Boolean(activeFeature),
      Boolean(activeSession),
    );

    if (!isValid) {
      setIsExportModalOpen(false);
      setExportStatusText(null);
      setExportPreflight(null);
    }
  }, [activeFeature, activeSession, exportModalContext, isExportModalOpen]);

  const loadBundlesForSessions = async (sessions: readonly Session[]) => {
    const bundles = await Promise.all(sessions.map((session) => getSessionExportData(session.id)));
    return bundles.filter((bundle): bundle is NonNullable<typeof bundle> => Boolean(bundle));
  };

  const resolveStructuredExportSessions = (
    context: ExportModalContext,
    mode: SessionSelectionMode,
  ): Session[] => {
    if (context === 'feature') {
      return mode === 'all' ? [...featureSessions] : latestRunsPerTestCase;
    }

    if (mode === 'selected') {
      return activeSession ? [activeSession] : [];
    }

    const latestForCurrentCase = activeRuns[0];
    return latestForCurrentCase ? [latestForCurrentCase] : [];
  };

  const exportPdf = async (sessions: readonly Session[]): Promise<{ filename: string; missingScreenshotCount: number }> => {
    const bundles = await loadBundlesForSessions(sessions);
    if (bundles.length === 0) {
      throw new Error('PDF export failed: selected runs could not be loaded.');
    }

    const { buildSessionPdf, buildFeaturePdf } = await import('../export/pdf/export-session-pdf.js');
    const result = bundles.length === 1
      ? await buildSessionPdf(bundles[0]!)
      : await buildFeaturePdf(bundles, activeFeature || 'Feature');

    const filename = sessions.length === 1
      ? buildSessionExportFilename(sessions[0]!, 'pdf')
      : buildFeatureExportFilename('pdf');
    downloadFileBlob(result.blob, filename);
    return { filename, missingScreenshotCount: result.missingScreenshotCount };
  };

  const exportWord = async (sessions: readonly Session[]): Promise<{ filename: string; missingScreenshotCount: number }> => {
    const bundles = await loadBundlesForSessions(sessions);
    if (bundles.length === 0) {
      throw new Error('Word export failed: selected runs could not be loaded.');
    }

    const { buildSessionWord, buildFeatureWord } = await import('../export/word/export-session-word.js');
    const result = bundles.length === 1
      ? await buildSessionWord(bundles[0]!)
      : await buildFeatureWord(bundles, activeFeature || 'Feature');

    const filename = sessions.length === 1
      ? buildSessionExportFilename(sessions[0]!, 'docx')
      : buildFeatureExportFilename('docx');
    downloadFileBlob(result.blob, filename);
    return { filename, missingScreenshotCount: result.missingScreenshotCount };
  };

  const exportExcel = async (sessions: readonly Session[]): Promise<{ filename: string }> => {
    const bundles = await loadBundlesForSessions(sessions);
    if (bundles.length === 0) {
      throw new Error('Excel export failed: selected runs could not be loaded.');
    }

    const { buildSessionExcel, buildFeatureExcel } = await import('../export/excel/export-session-excel.js');
    const result = bundles.length === 1
      ? await buildSessionExcel(bundles[0]!)
      : await buildFeatureExcel(bundles, activeFeature || 'Feature');

    const blob = new Blob([result.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const filename = sessions.length === 1
      ? buildSessionExportFilename(sessions[0]!, 'xlsx')
      : buildFeatureExportFilename('xlsx');
    downloadFileBlob(blob, filename);
    return { filename };
  };

  const exportFeatureBflow = async (): Promise<{ filename: string }> => {
    if (!activeFeature) throw new Error('Select a feature before exporting .bflow.');
    const { blob, filename } = await buildBflowArchive(activeFeature);
    downloadFileBlob(blob, filename);
    return { filename };
  };

  const loadExportPreflight = async (
    format: ExportFormat,
    mode: SessionSelectionMode,
    context: ExportModalContext,
  ): Promise<void> => {
    if (format === 'bflow') {
      setExportPreflight(null);
      return;
    }

    if (context === 'feature' && mode === 'all') {
      setExportPreflight(null);
      return;
    }

    const sessions = resolveStructuredExportSessions(context, mode);
    const session = sessions[0];
    if (!session) {
      setExportPreflight(null);
      return;
    }

    setIsExportPreflighting(true);
    try {
      const bundle = await getSessionExportData(session.id);
      if (!bundle) {
        setExportPreflight(null);
        return;
      }
      setExportPreflight(buildExportPreflightSummary(session, bundle));
    } finally {
      setIsExportPreflighting(false);
    }
  };

  const openFeatureExportModal = (): void => {
    const preferredFormat = defaultExportFormat();
    const preferredMode: SessionSelectionMode = 'latest';
    setExportModalContext('feature');
    setSelectedExportFormat(preferredFormat);
    setSessionSelectionMode(preferredMode);
    setExportStatusText(null);
    setIsExportModalOpen(true);
    void loadExportPreflight(preferredFormat, preferredMode, 'feature');
  };

  const openTestCaseExportModal = (): void => {
    const preferredFormat = defaultExportFormat();
    const preferredMode: SessionSelectionMode = 'selected';
    setExportModalContext('test-case');
    setSelectedExportFormat(preferredFormat);
    setSessionSelectionMode(preferredMode);
    setExportStatusText(null);
    setIsExportModalOpen(true);
    void loadExportPreflight(preferredFormat, preferredMode, 'test-case');
  };

  const handleExportFormatChange = (format: ExportFormat): void => {
    setSelectedExportFormat(format);
    setExportStatusText(null);
    void loadExportPreflight(format, sessionSelectionMode, exportModalContext);
  };

  const handleExportModeChange = (mode: SessionSelectionMode): void => {
    setSessionSelectionMode(mode);
    setExportStatusText(null);
    void loadExportPreflight(selectedExportFormat, mode, exportModalContext);
  };

  const runUnifiedExport = async (format: ExportFormat): Promise<void> => {
    if (exportInFlightRef.current || isAnyExportRunning) return;

    setExportStatusText('Preparing export...');

    const sessions = resolveStructuredExportSessions(exportModalContext, sessionSelectionMode);
    const eligibilityIssue = format !== 'bflow' && sessions.length === 0
      ? 'No runs are available for the selected export scope.'
      : (format === 'bflow' && !activeFeature ? 'Select a feature before exporting .bflow.' : null);

    if (eligibilityIssue) {
      setExportStatusText(eligibilityIssue);
      pushToast(eligibilityIssue, 'error');
      return;
    }

    if (exportModalContext === 'test-case' && format !== 'bflow') {
      const scopedSession = sessions[0] ?? null;
      const blockingIssue = exportEligibilityIssue(format, scopedSession);
      if (blockingIssue) {
        setExportStatusText(blockingIssue);
        pushToast(blockingIssue, 'error');
        return;
      }
    }

    const setBusy = (busy: boolean): void => {
      if (format === 'pdf') setIsGeneratingPdf(busy);
      if (format === 'word') setIsGeneratingWord(busy);
      if (format === 'excel') setIsGeneratingExcel(busy);
      if (format === 'bflow') setIsExportingBflow(busy);
    };

    exportInFlightRef.current = true;
    setBusy(true);
    try {
      let filename = '';
      if (format === 'pdf') {
        const result = await exportPdf(sessions);
        filename = result.filename;
        if (result.missingScreenshotCount > 0) {
          pushToast(`PDF exported with ${result.missingScreenshotCount} unavailable screenshot${result.missingScreenshotCount === 1 ? '' : 's'}.`, 'info');
        }
      } else if (format === 'word') {
        const result = await exportWord(sessions);
        filename = result.filename;
        if (result.missingScreenshotCount > 0) {
          pushToast(`Word exported with ${result.missingScreenshotCount} unavailable screenshot${result.missingScreenshotCount === 1 ? '' : 's'}.`, 'info');
        }
      } else if (format === 'excel') {
        const result = await exportExcel(sessions);
        filename = result.filename;
      } else {
        const result = await exportFeatureBflow();
        filename = result.filename;
      }

      setExportStatusText(`Export complete: ${filename}`);
      setIsExportModalOpen(false);
      pushToast(`Exported ${filename}. Check your browser Downloads folder.`, 'success');
    } catch (error) {
      console.error('[dashboard] unified export failed', error);
      const message = error instanceof Error ? error.message : 'Export failed. Please try again.';
      setExportStatusText(message);
      pushToast(message, 'error');
    } finally {
      setBusy(false);
      exportInFlightRef.current = false;
    }
  };


  const importBflowFile = async (file: File): Promise<void> => {
    if (isImportingBflow) {
      pushToast('An import is already running. Please wait.', 'info');
      return;
    }

    setIsImportingBflow(true);
    try {
      const result = await importBflowArchiveAtomic(file);
      await loadFeatureSummaries();
      if (activeFeature) {
        await loadSessionsForFeature(activeFeature);
      }
      pushToast(`Imported ${file.name} (.bflow v${result.formatVersion}).`);
    } catch (error) {
      console.error('[dashboard] import failed', error);
      pushToast(error instanceof Error ? error.message : 'Import failed. Please check the .bflow file.', 'error');
    } finally {
      setIsImportingBflow(false);
    }
  };

  const handleDashboardDragOver = (event: DragEvent): void => {
    event.preventDefault();
    setIsBflowDragging(true);
  };

  const handleDashboardDrop = (event: DragEvent): void => {
    event.preventDefault();
    setIsBflowDragging(false);
    const files = event.dataTransfer?.files;
    const file = files && files.length > 0 ? files[0] : null;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.bflow')) {
      pushToast('Only .bflow files can be imported here.', 'info');
      return;
    }
    void importBflowFile(file);
  };

  const filteredNetworkLogs = useMemo(() => {
    const query = devtoolsFilter.trim().toLowerCase();
    if (!query) return workspaceNetworkLogs;
    return workspaceNetworkLogs.filter((log) => {
      const haystack = `${log.method} ${log.url}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [workspaceNetworkLogs, devtoolsFilter]);

  const traceRows = useMemo<TraceTimelineRow[]>(() => {
    const stepRows: TraceStepRow[] = workspaceSteps.map((step) => ({
      type: 'step',
      id: `step-${step.step.id}`,
      ts: step.step.ts,
      step,
    }));

    const logRows: TraceLogRow[] = filteredNetworkLogs.map((log) => ({
      type: 'log',
      id: log.id,
      ts: log.timestamp,
      log,
    }));

    const consoleRows: TraceConsoleRow[] = workspaceConsoleEvents
      .filter((event) => {
        const query = devtoolsFilter.trim().toLowerCase();
        if (!query) return true;
        const haystack = `${event.level} ${event.message} ${event.pageUrl ?? ''}`.toLowerCase();
        return haystack.includes(query);
      })
      .map((event) => ({
        type: 'console',
        id: event.id,
        ts: event.ts,
        level: event.level,
        message: event.message,
        pageUrl: event.pageUrl,
      }));

    return [...stepRows, ...consoleRows, ...logRows].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      const rank = (row: TraceTimelineRow): number => (row.type === 'step' ? 0 : row.type === 'console' ? 1 : 2);
      return rank(a) - rank(b);
    });
  }, [workspaceSteps, filteredNetworkLogs, workspaceConsoleEvents, devtoolsFilter]);

  const selectedLog = useMemo(
    () => workspaceNetworkLogs.find((log) => log.id === selectedLogId) ?? null,
    [workspaceNetworkLogs, selectedLogId],
  );

  const serverErrorCount = useMemo(
    () => workspaceNetworkLogs.filter((log) => log.status >= 500 || log.status === 0).length,
    [workspaceNetworkLogs],
  );

  const warningCount = useMemo(
    () => workspaceNetworkLogs.filter((log) => log.status >= 400 && log.status < 500).length,
    [workspaceNetworkLogs],
  );

  const inspectorPayload = useMemo(() => {
    if (!selectedLog) return 'Select a network row to inspect payloads.';

    if (inspectorTab === 'headers') {
      return [
        `Method: ${selectedLog.method}`,
        `URL: ${selectedLog.url}`,
        `Status: ${selectedLog.status}`,
        `Timestamp: ${fmtDate(selectedLog.timestamp)}`,
        `Duration: ${Math.round(selectedLog.durationMs ?? 0)} ms`,
      ].join('\n');
    }

    const raw = inspectorTab === 'payload' ? selectedLog.requestBody : selectedLog.responseBody;
    if (!raw) return 'n/a';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [selectedLog, inspectorTab]);

  const copyInspectorPayload = async (): Promise<void> => {
    if (!selectedLog) return;
    try {
      await navigator.clipboard.writeText(inspectorPayload);
      setCopyFeedback(true);
      window.setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      // Clipboard access may be unavailable in constrained browser contexts.
    }
  };

  const goHome = (): void => {
    setActiveFeature(null);
    setActiveSession(null);
    setFeatureSessions([]);
    setWorkspaceSteps([]);
    setWorkspaceNetworkLogs([]);
    setWorkspaceConsoleEvents([]);
    setBugTrackerRows([]);
    setBugTrackerLoading(false);
    navigateToView('dashboard');
    void loadFeatureSummaries();
  };

  const navigateToWelcome = (): void => {
    setActiveFeature(null);
    setActiveSession(null);
    setFeatureSessions([]);
    setWorkspaceSteps([]);
    setWorkspaceNetworkLogs([]);
    setWorkspaceConsoleEvents([]);
    navigateToView('welcome');
    pushToast('Checkout complete. Subscription activation is finalized by backend webhook processing.', 'info');
  };

  const createFeatureFromSearch = async (): Promise<void> => {
    const nextFeature = featureSearch.trim();
    if (!nextFeature) return;

    const response = await runtimeMessage<{ ok: boolean; created?: boolean; error?: string }>({
      type: 'TT_CREATE_FEATURE',
      featureName: nextFeature,
    });
    if (!response?.ok) {
      pushToast(response?.error || 'Could not create feature.', 'error');
      return;
    }

    await loadFeatureSummaries();

    setActiveFeature(nextFeature);
    setActiveSession(null);
    setFeatureSessions([]);
    setActiveTab('Test Cases');
    setFeatureSearch('');
    pushToast(response.created ? `Feature "${nextFeature}" created.` : `Opened feature "${nextFeature}".`);
  };

  const openFeatureRenameModal = (featureName: string): void => {
    setModalState({
      title: 'Rename Feature',
      body: `Rename ${featureName}`,
      inputPlaceholder: 'New feature name',
      inputValue: featureName,
      onConfirm: async (value) => {
        const newName = value.trim();
        if (!newName || newName === featureName) {
          setModalState(null);
          return;
        }

        const response = await runtimeMessage<{ ok: boolean; error?: string }>({
          type: 'TT_RENAME_FEATURE',
          oldName: featureName,
          newName,
        });

        if (!response?.ok) {
          pushToast(response?.error || 'Unable to rename feature.', 'error');
          return;
        }

        await loadFeatureSummaries();
        if (activeFeature === featureName) {
          setActiveFeature(newName);
          await loadSessionsForFeature(newName);
        }
        setModalState(null);
        pushToast(`Feature renamed to "${newName}".`);
      },
    });
  };

  const openFeatureDeleteModal = (featureName: string): void => {
    setModalState({
      title: 'Delete Feature',
      body: `Delete ${featureName}? This action cannot be undone.`,
      isDanger: true,
      onConfirm: async () => {
        const response = await runtimeMessage<{ ok: boolean; error?: string }>({
          type: 'TT_DELETE_FEATURE',
          featureName,
        });

        if (!response?.ok) {
          pushToast(response?.error || 'Unable to delete feature.', 'error');
          return;
        }

        await loadFeatureSummaries();
        if (activeFeature === featureName) {
          goHome();
        }
        setModalState(null);
        pushToast(`Feature "${featureName}" deleted.`);
      },
    });
  };

  const openTestCaseRenameModal = (testCaseName: string): void => {
    if (!activeFeature) return;
    setModalState({
      title: 'Rename Test Case',
      body: `Rename ${testCaseName}`,
      inputPlaceholder: 'New test case name',
      inputValue: testCaseName,
      onConfirm: async (value) => {
        const newTestCaseName = value.trim();
        if (!newTestCaseName || newTestCaseName === testCaseName) {
          setModalState(null);
          return;
        }

        const response = await runtimeMessage<{ ok: boolean; error?: string }>({
          type: 'TT_RENAME_TEST_CASE',
          featureName: activeFeature,
          oldTestCaseName: testCaseName,
          newTestCaseName,
        });

        if (!response?.ok) {
          pushToast(response?.error || 'Unable to rename test case.', 'error');
          return;
        }

        const sessions = await loadSessionsForFeature(activeFeature);
        if (activeSession && (activeSession.testCaseName?.trim() || 'Untitled Test Case') === testCaseName) {
          const replacement = sessions.find((session) => (session.testCaseName?.trim() || 'Untitled Test Case') === newTestCaseName) ?? null;
          setActiveSession(replacement);
        }
        await loadFeatureSummaries();
        setModalState(null);
        pushToast(`Test case renamed to "${newTestCaseName}".`);
      },
    });
  };

  const openTestCaseDeleteModal = (group: TestCaseGroup): void => {
    if (!activeFeature) return;
    setModalState({
      title: 'Delete Test Case',
      body: `Delete ${group.testCaseName} and all ${group.runs.length} runs?`,
      isDanger: true,
      onConfirm: async () => {
        for (const run of group.runs) {
          const response = await runtimeMessage<{ ok: boolean; error?: string }>({
            type: 'TT_DELETE_SESSION',
            sessionId: run.id,
          });
          if (!response?.ok) {
            pushToast(response?.error || 'Unable to delete test case runs.', 'error');
            return;
          }
        }

        const sessions = await loadSessionsForFeature(activeFeature);
        if (activeSession && group.runs.some((run) => run.id === activeSession.id)) {
          setActiveSession(sessions[0] ?? null);
        }
        await loadFeatureSummaries();
        setModalState(null);
        pushToast(`Test case "${group.testCaseName}" deleted.`);
      },
    });
  };

  const openTestCaseMoveModal = (testCaseName: string): void => {
    if (!activeFeature) return;
    setModalState({
      title: 'Move Test Case',
      body: `Move ${testCaseName} from ${activeFeature} to another feature`,
      inputPlaceholder: 'Search destination feature',
      inputValue: '',
      onConfirm: async (value) => {
        const requestedFeature = value.trim();
        if (!requestedFeature || requestedFeature.toLowerCase() === activeFeature.toLowerCase()) return;

        const destinationFeature = featureSummaries.find(
          (feature) => feature.featureName.trim().toLowerCase() === requestedFeature.toLowerCase(),
        )?.featureName;

        if (!destinationFeature) {
          pushToast('Destination feature does not exist. Pick an existing feature.', 'error');
          return;
        }

        const response = await runtimeMessage<{ ok: boolean; error?: string }>({
          type: 'TT_MOVE_TEST_CASE',
          oldFeature: activeFeature,
          newFeature: destinationFeature,
          testCaseName,
        });

        if (!response?.ok) {
          pushToast(response?.error || 'Unable to move test case.', 'error');
          return;
        }

        const sessions = await loadSessionsForFeature(activeFeature);
        if (activeSession && (activeSession.testCaseName?.trim() || 'Untitled Test Case') === testCaseName) {
          setActiveSession(sessions[0] ?? null);
        }
        await loadFeatureSummaries();
        setModalState(null);
        pushToast(`Test case "${testCaseName}" moved to "${destinationFeature}".`);
      },
    });
  };


  const toastStack = (
    <div class="toast-stack" aria-live="polite" aria-atomic="false" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} class={`toast toast-${toast.tone}`} role="status">
          {toast.message}
        </div>
      ))}
    </div>
  );

  if (!routingApplied || authLoading) {
    return (
      <div class="dash-shell">
        <main class="dash-main"><p style="color:var(--fg-muted)" role="status" aria-live="polite">{!routingApplied ? 'Loading dashboard...' : 'Restoring session...'}</p></main>
      </div>
    );
  }

  const isWelcomeRoute = routeView === 'welcome';

  if (!activeFeature && isWelcomeRoute) {
    return (
      <div class="dash-shell">
        <main class="dash-main">
          <section class="card welcome-surface">
            <h2>Welcome to BusinessFlow Pro</h2>
            <p>Your checkout completed. Subscription activation is finalized via backend webhook processing.</p>
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
              <button class="btn btn-primary" onClick={() => navigateToView('dashboard')}>Go to Dashboard</button>
              <button class="btn btn-outline" onClick={openPricing}>Manage account & billing</button>
            </div>
          </section>
        </main>
        <PricingModal
          isOpen={false}
          onClose={closePricing}
          onNavigateWelcome={navigateToWelcome}
          onAuthSuccess={() => {
            void refreshAuthStatus(false);
            navigateToView('dashboard', 'replace');
          }}
          onAuthStatusChange={(status) => {
            setAuthStatus(status);
            setAuthLoading(false);
          }}
          runtimeMessage={runtimeMessage}
        />
        {toastStack}
      </div>
    );
  }

  if (!activeFeature) {
    return (
      <div
        class="dash-shell"
        onDragOver={(event) => handleDashboardDragOver(event as unknown as DragEvent)}
        onDragLeave={() => setIsBflowDragging(false)}
        onDrop={(event) => handleDashboardDrop(event as unknown as DragEvent)}
      >
        <main class="dash-main">
          <div class="dash-header-bar dash-header home-hero">
            <div>
              <img class="home-brand-wordmark" src="../../logo/Brand_Name.png" alt="BusinessFlow" />
            </div>
            <button class="btn btn-primary" onClick={openPricing}>View Pricing</button>
          </div>

          {featureSummaries.length === 0 ? (
            <section class="home-empty-state">
              <h3>Welcome to BusinessFlow</h3>
              <p>No test runs found. Open the Chrome Extension to record your first flow.</p>
            </section>
          ) : (
            <>
              <div class="feature-search-wrap">
                <span class="search-icon" aria-hidden="true"></span>
                <input
                  type="text"
                  class="search-input feature-search-input"
                  aria-label="Search features"
                  placeholder="Search features..."
                  value={featureSearch}
                  onInput={(event) => setFeatureSearch((event.target as HTMLInputElement).value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    if (filteredFeatureSummaries.length !== 0) return;
                    void createFeatureFromSearch();
                  }}
                />
              </div>

              {filteredFeatureSummaries.length === 0 ? (
                <section class="card">
                  <p style="margin:0 0 12px;color:var(--fg-muted)">No feature matches "{featureSearch.trim()}".</p>
                  <button class="btn btn-primary" onClick={createFeatureFromSearch}>
                    Create Feature "{featureSearch.trim()}"
                  </button>
                </section>
              ) : (
                <div class="dash-grid">
                  {filteredFeatureSummaries.map((feature) => {
                    const total = Math.max(feature.count, 1);
                    const passRate = (feature.passed / total) * 100;
                    const failRate = (feature.failed / total) * 100;
                    const blockedRate = (feature.blocked / total) * 100;
                    const donutGradient = `conic-gradient(#10b981 0% ${passRate}%, #ef4444 ${passRate}% ${passRate + failRate}%, #f59e0b ${passRate + failRate}% ${passRate + failRate + blockedRate}%, #e5e7eb ${passRate + failRate + blockedRate}% 100%)`;

                    return (
                      <div
                        key={feature.featureName}
                        class="feature-card"
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (!isKeyboardActivationKey(event.key)) return;
                          event.preventDefault();
                          setActiveFeature(feature.featureName);
                          setActiveSession(null);
                          setActiveTab('Test Cases');
                          setTestCaseSearch('');
                        }}
                        onClick={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest('.custom-dropdown')) return;
                          setActiveFeature(feature.featureName);
                          setActiveSession(null);
                          setActiveTab('Test Cases');
                          setTestCaseSearch('');
                        }}
                      >
                        <div class="feature-card-top">
                          <h3 class="feature-card-title">{feature.featureName}</h3>
                          <div onClick={(event) => event.stopPropagation()}>
                            <CustomDropdown
                              anchorLabel="⋮"
                              buttonAriaLabel={`Actions for feature ${feature.featureName}`}
                              buttonClass="btn btn-outline kebab-btn"
                              items={[
                                { label: 'Rename', onSelect: () => openFeatureRenameModal(feature.featureName) },
                                { label: 'Delete', onSelect: () => openFeatureDeleteModal(feature.featureName), danger: true },
                              ]}
                            />
                          </div>
                        </div>

                        <div class="feature-card-body">
                          <div class="feature-card-health">
                            <div class="feature-mini-donut" style={{ background: donutGradient }}>
                              <div class="feature-mini-donut-hole">{Math.round(passRate)}%</div>
                            </div>
                            <div class="feature-card-metrics">
                              <span><strong>Tests Passed:</strong> {feature.passed}</span>
                              <span><strong>Tests Failed:</strong> {feature.failed}</span>
                              <span><strong>Tests Blocked:</strong> {feature.blocked}</span>
                            </div>
                          </div>

                          <div class="feature-card-stats">
                            <div class="feature-stat"><span class="feature-stat-label">Test Cases</span><span class="feature-stat-value">{feature.testCaseCount}</span></div>
                            <div class="feature-stat"><span class="feature-stat-label">Open Bugs</span><span class="feature-stat-value">{feature.openBugCount}</span></div>
                            <div class="feature-stat"><span class="feature-stat-label">Total Runs</span><span class="feature-stat-value">{feature.count}</span></div>
                          </div>
                        </div>

                        <div class="feature-health-bar">
                          <div class="feature-health-pass" style={{ width: `${passRate}%` }} />
                          <div class="feature-health-fail" style={{ width: `${failRate}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </main>

        <div class={`bflow-dropzone ${isBflowDragging ? 'dragging' : ''}`}>
          <div class="bflow-drop-text">Drop .bflow file to import</div>
        </div>
        {modalState && (
          <Modal
            title={modalState.title}
            body={modalState.body}
            inputPlaceholder={modalState.inputPlaceholder}
            inputValue={modalState.inputValue}
            isDanger={modalState.isDanger}
            onCancel={() => setModalState(null)}
            onConfirm={async (value) => {
              await modalState.onConfirm(value);
            }}
          />
        )}
        <ExportModal
          context={exportModalContext}
          isOpen={isExportModalOpen}
          selectedFormat={selectedExportFormat}
          selectionMode={sessionSelectionMode}
          canUseSelectedRun={canUseSelectedRun}
          canUseLatestRun={canUseLatestRun}
          hasAnyExportableData={hasAnyExportableData}
          preflight={exportPreflight}
          isPreflighting={isExportPreflighting}
          isExporting={isAnyExportRunning}
          isCopyingEvidence={isCopyingEvidence}
          exportStatusText={exportStatusText}
          onSelectFormat={handleExportFormatChange}
          onSelectMode={handleExportModeChange}
          onConfirm={() => {
            void runUnifiedExport(selectedExportFormat);
          }}
          onCopyEvidence={() => {
            void handleCopyEvidence();
          }}
          canCopyEvidence={exportModalContext === 'feature' ? hasAnyExportableData : Boolean(activeSession)}
          onClose={() => {
            if (isAnyExportRunning || isCopyingEvidence) return;
            setIsExportModalOpen(false);
          }}
        />
        <PricingModal
          isOpen={routeView === 'pricing'}
          onClose={closePricing}
          onNavigateWelcome={navigateToWelcome}
          onAuthSuccess={() => {
            void refreshAuthStatus(false);
            navigateToView('dashboard', 'replace');
          }}
          onAuthStatusChange={(status) => {
            setAuthStatus(status);
            setAuthLoading(false);
          }}
          runtimeMessage={runtimeMessage}
        />
        {toastStack}
      </div>
    );
  }

  return (
    <>
      <div
        class="dash-shell"
        onDragOver={(event) => handleDashboardDragOver(event as unknown as DragEvent)}
        onDragLeave={() => setIsBflowDragging(false)}
        onDrop={(event) => handleDashboardDrop(event as unknown as DragEvent)}
      >
      <main class="dash-main">
        {!activeSession && (
          <>
            <div class="feature-header">
              <div class="feature-breadcrumbs">
                <button class="breadcrumb" onClick={goHome} type="button">Home</button>
                <span class="breadcrumb-separator">/</span>
                <span>{activeFeature}</span>
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn btn-outline" onClick={openPricing}>
                  Pricing
                </button>
                <button class="btn btn-outline" onClick={openFeatureExportModal}>
                  Export…
                </button>
              </div>
            </div>

            <div class="exec-kpi-row">
              <section class="card-panel">
                <div class="card-title">Test Suite Health</div>
                <div style="font-size:11px;color:var(--fg-muted);margin-top:-4px;margin-bottom:8px;">Based on latest run per test case</div>
                <div class="donut-layout-wrapper">
                  <div class="donut-chart" style={{ background: summary.donutGradient }}>
                    <div class="donut-hole">
                      <span class="donut-total">{summary.totalCases}</span>
                    </div>
                  </div>
                  <div class="donut-legend">
                    <div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:#10b981;font-weight:600;">Pass</span><span>{summary.passed}</span></div>
                    <div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:#ef4444;font-weight:600;">Fail</span><span>{summary.failed}</span></div>
                    <div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:#f59e0b;font-weight:600;">Blocked</span><span>{summary.blocked}</span></div>
                  </div>
                </div>
              </section>

              <section class="card-panel">
                <div class="card-title">API Reliability</div>
                <div class="kpi-value">{reliability.successRateLabel}</div>
                <div style="font-size:12px;color:var(--fg-muted);">Overall Success Rate</div>
                <div class="thick-health-bar">
                  <div class="health-segment segment-success" style={{ width: `${reliability.successPct}%` }} />
                  <div class="health-segment segment-warn" style={{ width: `${reliability.warnPct}%` }} />
                  <div class="health-segment segment-critical" style={{ width: `${reliability.criticalPct}%` }} />
                </div>
                <div style="display:flex;gap:14px;margin-top:12px;font-size:12px;color:var(--fg-muted);flex-wrap:wrap;">
                  <span>2xx/3xx: {featureNetworkStats.successCount}</span>
                  <span>4xx: {featureNetworkStats.warnCount}</span>
                  <span>5xx/0: {featureNetworkStats.errorCount}</span>
                </div>
              </section>
            </div>

            <div class="exec-insights-grid">
              <section class="card-panel">
                <div class="card-title">API Response Time Distribution</div>
                <div class="bar-chart">
                  <div class="bar-row">
                    <span class="bar-label">&lt; 100ms</span>
                    <div class="bar-track"><div class="bar-fill" style={{ width: `${latencyDistribution.fastPct}%` }} /></div>
                    <span class="bar-value">{featureNetworkStats.fastRequests}</span>
                  </div>
                  <div class="bar-row">
                    <span class="bar-label">100 - 500ms</span>
                    <div class="bar-track"><div class="bar-fill" style={{ width: `${latencyDistribution.avgPct}%` }} /></div>
                    <span class="bar-value">{featureNetworkStats.avgRequests}</span>
                  </div>
                  <div class="bar-row">
                    <span class="bar-label">&gt; 500ms</span>
                    <div class="bar-track"><div class="bar-fill" style={{ width: `${latencyDistribution.slowPct}%` }} /></div>
                    <span class="bar-value">{featureNetworkStats.slowRequests}</span>
                  </div>
                </div>
              </section>

              <section class="card-panel">
                <div class="card-title">Performance Outliers (Top 5 Slowest Endpoints)</div>
                <div class="outliers-list">
                  {featureNetworkStats.topSlowest.length === 0 && (
                    <div class="shame-row"><span class="shame-url">No API traffic recorded yet.</span></div>
                  )}
                  {featureNetworkStats.topSlowest.map((log) => {
                    const cleanUrl = pathnameForUrl(log.url);
                    return (
                      <div key={log.id} class="shame-row">
                        <span class="shame-method">{log.method}</span>
                        <span class="shame-url">{cleanUrl}</span>
                        <span class="shame-latency">{Math.round(log.durationMs ?? 0)}ms</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            <div class="tabs-row" role="tablist" aria-label="Feature views">
              <button role="tab" aria-selected={activeTab === 'Test Cases'} aria-controls="feature-tab-test-cases" id="feature-tab-btn-test-cases" class={`tab-btn ${activeTab === 'Test Cases' ? 'active' : ''}`} onClick={() => setActiveTab('Test Cases')}>Test Cases</button>
              <button role="tab" aria-selected={activeTab === 'Bug Tracker'} aria-controls="feature-tab-bug-tracker" id="feature-tab-btn-bug-tracker" class={`tab-btn ${activeTab === 'Bug Tracker' ? 'active' : ''}`} onClick={() => setActiveTab('Bug Tracker')}>Bug Tracker</button>
            </div>

            {activeTab === 'Test Cases' && !activeSession && (
              <div role="tabpanel" id="feature-tab-test-cases" aria-labelledby="feature-tab-btn-test-cases">
                <div class="test-case-toolbar">
                  <input
                    type="text"
                    class="search-input"
                    aria-label="Search test cases"
                    placeholder="Search test cases..."
                    value={testCaseSearch}
                    onInput={(event) => setTestCaseSearch((event.target as HTMLInputElement).value)}
                  />
                  <div class="test-case-filter-group" role="group" aria-label="Filter test cases by latest result">
                    {([
                      { key: 'all', label: 'All' },
                      { key: 'pass', label: 'Pass' },
                      { key: 'fail', label: 'Fail' },
                      { key: 'blocked', label: 'Blocked' },
                      { key: 'draft', label: 'Draft' },
                    ] as const).map((filter) => (
                      <button
                        type="button"
                        key={filter.key}
                        class={`test-case-filter-chip ${testCaseOutcomeFilter === filter.key ? 'active' : ''}`}
                        aria-pressed={testCaseOutcomeFilter === filter.key}
                        onClick={() => setTestCaseOutcomeFilter(filter.key)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>
                {filteredTestCaseGroups.length === 0 && (
                  <div class="card">
                    <p style="margin:0;color:var(--fg-muted)">No test cases found for current filters.</p>
                  </div>
                )}
                {filteredTestCaseGroups.map((group) => {
                  const latestRun = group.runs[0] ?? null;
                  const latestStatus = latestRun?.status ?? 'draft';
                  const statusUi = latestStatus === 'pass'
                    ? { icon: '\u2713', label: 'Passed', rowClass: 'status-pass', badgeClass: 'status-badge-pass' }
                    : latestStatus === 'fail'
                      ? { icon: '\u2715', label: 'Failed', rowClass: 'status-fail', badgeClass: 'status-badge-fail' }
                      : latestStatus === 'blocked'
                        ? { icon: '\u2298', label: 'Blocked', rowClass: 'status-blocked', badgeClass: 'status-badge-blocked' }
                        : { icon: '\u25A3', label: 'Draft', rowClass: 'status-draft', badgeClass: 'status-badge-draft' };

                  return (
                    <div
                      key={group.testCaseName}
                      class={`test-case-row ${statusUi.rowClass}`}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (!isKeyboardActivationKey(event.key)) return;
                        event.preventDefault();
                        if (!latestRun) return;
                        setActiveSession(latestRun);
                      }}
                      onClick={() => {
                        if (!latestRun) return;
                        setActiveSession(latestRun);
                      }}
                    >
                      <div class="test-case-info">
                        <div style="font-weight:600;color:var(--fg-main)">{group.testCaseName}</div>
                        <div style="font-size:12px;color:var(--fg-muted)">{group.runs.length} runs | Latest: {latestRun ? fmtDate(latestRun.startedAt) : 'n/a'}</div>
                      </div>
                      <div class="test-case-actions" onClick={(event) => event.stopPropagation()}>
                        <span class={`test-status-chip ${statusUi.badgeClass}`}>
                          <span class="test-status-icon" aria-hidden="true">{statusUi.icon}</span>
                          <span>{statusUi.label}</span>
                        </span>
                        <CustomDropdown
                          anchorLabel="⋮"
                          buttonAriaLabel={`Actions for test case ${group.testCaseName}`}
                          buttonClass="btn btn-outline kebab-btn"
                          items={[
                            { label: 'Rename', onSelect: () => openTestCaseRenameModal(group.testCaseName) },
                            { label: 'Delete', onSelect: () => openTestCaseDeleteModal(group), danger: true },
                            { label: 'Move', onSelect: () => openTestCaseMoveModal(group.testCaseName) },
                          ]}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === 'Bug Tracker' && (
              <div class="issue-board" role="tabpanel" id="feature-tab-bug-tracker" aria-labelledby="feature-tab-btn-bug-tracker">
                {bugTrackerLoading && <p style="color:var(--fg-muted)" role="status" aria-live="polite">Loading issue matrix...</p>}

                {!bugTrackerLoading && bugTrackerGroups.length === 0 && (
                  <div class="issue-empty">
                    <h3>No issues found</h3>
                    <p>Bugs you pin on screenshots and technical step failures will appear here.</p>
                  </div>
                )}

                {!bugTrackerLoading && bugTrackerGroups.length > 0 && (
                  <>
                    <div class="issue-toolbar">
                      <label class="issue-toggle">
                        <input
                          type="checkbox"
                          checked={showStaleBugs}
                          onChange={(event) => setShowStaleBugs((event.target as HTMLInputElement).checked)}
                        />
                        <span>Show stale bugs from older runs</span>
                      </label>
                    </div>

                    <div class="issue-summary">
                      <div class="issue-stat">
                        <span class="issue-stat-value">{bugTrackerTotals.issues}</span>
                        <span class="issue-stat-label">Total issues</span>
                      </div>
                      <div class="issue-stat">
                        <span class="issue-stat-value danger">{bugTrackerTotals.manual}</span>
                        <span class="issue-stat-label">Reported bugs</span>
                      </div>
                      <div class="issue-stat">
                        <span class="issue-stat-value warning">{bugTrackerTotals.technical}</span>
                        <span class="issue-stat-label">Technical failures</span>
                      </div>
                      <div class="issue-stat">
                        <span class="issue-stat-value">{bugTrackerTotals.testCases}</span>
                        <span class="issue-stat-label">Affected test cases</span>
                      </div>
                    </div>

                    {bugTrackerGroups.map((group) => (
                      <details key={group.testCase} class="issue-group" open>
                        <summary class="issue-group-head">
                          <span class="issue-group-name">{group.testCase}</span>
                          <span class="issue-group-meta">
                            {group.manualCount > 0 && (
                              <span class="badge badge-danger">{group.manualCount} bug{group.manualCount === 1 ? '' : 's'}</span>
                            )}
                            {group.technicalCount > 0 && (
                              <span class="badge badge-warning">{group.technicalCount} failure{group.technicalCount === 1 ? '' : 's'}</span>
                            )}
                            <span class="issue-group-steps">{group.affectedSteps} step{group.affectedSteps === 1 ? '' : 's'}</span>
                          </span>
                        </summary>

                        {group.runs.map((run) => (
                          <div key={run.runId} class="issue-run">
                            <div class="issue-run-head">
                              <span class="issue-run-label">{run.runLabel}</span>
                              <span class="issue-run-count">{run.rows.length} issue{run.rows.length === 1 ? '' : 's'}</span>
                            </div>

                            <ol class="issue-list">
                              {run.rows.map((row) => (
                                <li key={row.id} class={`issue-card ${row.kind}`}>
                                  <div class="issue-card-top">
                                    <span class="issue-step">{row.stepIndex > 0 ? `Step ${row.stepIndex}` : 'Run-level'}</span>
                                    <span class="issue-step-title">{row.stepTitle}</span>
                                    <span class={`issue-kind ${row.kind}`}>
                                      {row.kind === 'manual' ? 'Reported bug' : row.status.toUpperCase()}
                                    </span>
                                  </div>

                                  <p class="issue-description">{row.description}</p>

                                  <div class="issue-card-foot">
                                    {row.pinned && (
                                      <span class="issue-pinned"><i class="pin-swatch bug" />Pinned on screenshot</span>
                                    )}
                                    <button class="btn-link" onClick={() => jumpToDevTrace(row.runId, row.stepIndex)}>
                                      View evidence &rarr;
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </div>
                        ))}
                      </details>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {activeSession && (
          <>
            <div class="case-header">
              <div class="case-header-top">
                <div class="case-identity">
                  <button class="case-back" onClick={() => setActiveSession(null)}>
                    ← Back
                  </button>
                  <div class="case-titles">
                    <h2 class="case-title">{activeSession.testCaseName || 'Untitled Test Case'}</h2>
                    <p class="case-subtitle">
                      {activeFeature} &middot; {workspaceSteps.length} steps &middot; {workspaceNetworkLogs.length} network calls
                      {activeSession.environment?.platform
                        ? ` · ${activeSession.environment.platform}${activeSession.environment.chromeVersion ? ` · Chrome ${activeSession.environment.chromeVersion}` : ''}`
                        : ''}
                    </p>
                  </div>
                </div>

                <div class="case-health">
                  <span class="run-mix-chart" style={{ background: activeRunMix.gradient }} title={activeRunMix.title}>
                    <span class="run-mix-hole">{activeRunMix.total}</span>
                  </span>
                  <div class="case-health-legend">
                    <span><i class="dot pass" />Pass {activeRunSummary.pass}</span>
                    <span><i class="dot fail" />Fail {activeRunSummary.fail}</span>
                    <span><i class="dot blocked" />Blocked {activeRunSummary.blocked}</span>
                    <span><i class="dot draft" />Draft {activeRunSummary.draft}</span>
                  </div>
                </div>
              </div>

              <div class="case-header-bottom">
                <div class="case-controls case-controls--premium">
                  <div class="case-control-group">
                    <span class="case-control-label">Run</span>
                    <CustomDropdown
                      anchorLabel={
                        <span class="run-selector-anchor run-selector-anchor--premium">
                          <span class={`run-status-dot ${activeRunTone}`} />
                          <span class="case-control-value">{`Run ${activeRunNumber}${isLatestRun ? ' (Latest)' : ''}`}</span>
                          <span aria-hidden="true">▾</span>
                        </span>
                      }
                      buttonClass="btn btn-outline case-select-btn"
                      menuAlign="left"
                      items={lastTenRuns.map((run, index) => {
                        const status = run.status ?? 'draft';
                        const statusBadgeClass = status === 'pass' ? 'badge-muted' : status === 'fail' ? 'badge-danger' : 'badge-warning';
                        const durationMs = typeof run.endedAt === 'number' ? Math.max(0, run.endedAt - run.startedAt) : 0;
                        return {
                          label: runLabel(run, index, activeRuns.length),
                          meta: `${fmtDate(run.startedAt)} • ${Math.round(durationMs / 1000)}s`,
                          badge: status.toUpperCase(),
                          badgeClass: statusBadgeClass,
                          onSelect: () => setActiveSession(run),
                        };
                      })}
                    />
                  </div>

                  <div class="case-control-group">
                    <span class="case-control-label">Test type</span>
                    <CustomDropdown
                      anchorLabel={<span class="case-chip case-chip--type">{activeTypeLabel} ▾</span>}
                      buttonClass="btn btn-outline case-select-btn"
                      items={[
                        { label: 'Positive', badge: activeTypeLabel === 'Positive' ? 'Current' : undefined, badgeClass: 'badge-muted', onSelect: () => persistSessionUpdate({ testType: 'Positive' }) },
                        { label: 'Negative', badge: activeTypeLabel === 'Negative' ? 'Current' : undefined, badgeClass: 'badge-warning', onSelect: () => persistSessionUpdate({ testType: 'Negative' }) },
                        { label: 'Edge Case', badge: activeTypeLabel === 'Edge Case' ? 'Current' : undefined, badgeClass: 'badge-warning', onSelect: () => persistSessionUpdate({ testType: 'Edge Case' }) },
                      ]}
                    />
                  </div>

                  <div class="case-control-group">
                    <span class="case-control-label">Status</span>
                    <CustomDropdown
                      anchorLabel={<span class={`case-chip case-chip--status case-chip--${activeStatusTone}`}>{(activeSession.status ?? 'draft').toUpperCase()} ▾</span>}
                      buttonClass="btn btn-outline case-select-btn"
                      items={[
                        { label: 'DRAFT', badge: activeStatusTone === 'draft' ? 'Current' : undefined, badgeClass: 'badge-muted', onSelect: () => persistSessionUpdate({ status: 'draft' as SessionStatus }) },
                        { label: 'PASS', badge: activeStatusTone === 'pass' ? 'Current' : undefined, badgeClass: 'badge-muted', onSelect: () => persistSessionUpdate({ status: 'pass' as SessionStatus }) },
                        { label: 'FAIL', badge: activeStatusTone === 'fail' ? 'Current' : undefined, badgeClass: 'badge-danger', onSelect: () => persistSessionUpdate({ status: 'fail' as SessionStatus }) },
                        { label: 'BLOCKED', badge: activeStatusTone === 'blocked' ? 'Current' : undefined, badgeClass: 'badge-warning', onSelect: () => persistSessionUpdate({ status: 'blocked' as SessionStatus }) },
                      ]}
                    />
                  </div>
                </div>

                <div class="case-trailing">
                  <div class="run-history-timeline" title="Recent run history">
                    {lastTenRuns.map((run) => {
                      const runState = run.status === 'pass' ? 'pass' : run.status === 'fail' ? 'fail' : 'warn';
                      return (
                        <button
                          key={run.id}
                          type="button"
                          class={`run-block ${runState}`}
                          title={fmtDate(run.startedAt)}
                          aria-label={`Open run started ${fmtDate(run.startedAt)} with status ${run.status ?? 'draft'}`}
                          onClick={() => setActiveSession(run)}
                        />
                      );
                    })}
                  </div>

                  <button class="btn btn-primary" onClick={openTestCaseExportModal} disabled={isAnyExportRunning || isCopyingEvidence}>
                    {isAnyExportRunning ? 'Exporting…' : 'Export…'}
                  </button>
                </div>
              </div>
            </div>

            <div class="tabs-row" style="margin-top:12px;" role="tablist" aria-label="Session views">
              <button role="tab" aria-selected={viewTab === 'qa'} aria-controls="session-tab-evidence" id="session-tab-btn-evidence" class={`tab-btn ${viewTab === 'qa' ? 'active' : ''}`} onClick={() => setViewTab('qa')}>Evidence</button>
              <button role="tab" aria-selected={viewTab === 'dev'} aria-controls="session-tab-diagnostics" id="session-tab-btn-diagnostics" class={`tab-btn ${viewTab === 'dev' ? 'active' : ''}`} onClick={() => setViewTab('dev')}>Diagnostics</button>
            </div>

            {viewTab === 'qa' && (
              <section id="session-tab-evidence" role="tabpanel" aria-labelledby="session-tab-btn-evidence" style="display:flex;flex-direction:column;gap:12px;">
                <div class="run-summary card" aria-label="Run summary">
                  <div class="run-summary__header">
                    <div class={`run-summary__verdict verdict-${activeSession.status ?? 'draft'}`}>
                      <span class="run-summary__verdict-label">Verdict</span>
                      <span class="run-summary__verdict-value">{(activeSession.status ?? 'draft').toUpperCase()}</span>
                    </div>
                    <p class="run-summary__caption">
                      Run {activeRunNumber}{isLatestRun ? ' (Latest)' : ''} · {fmtDate(activeSession.startedAt)}
                    </p>
                  </div>
                  <div class="run-summary__grid">
                    <div class="run-summary__stat">
                      <span class="run-summary__stat-value">{workspaceSteps.length}</span>
                      <span class="run-summary__stat-label">Steps</span>
                    </div>
                    <div class="run-summary__stat">
                      <span class="run-summary__stat-value">{runDurationLabel}</span>
                      <span class="run-summary__stat-label">Duration</span>
                    </div>
                    <div class={`run-summary__stat ${runSummary.bugs > 0 ? 'stat-critical' : ''}`}>
                      <span class="run-summary__stat-value">{runSummary.bugs}</span>
                      <span class="run-summary__stat-label">Bugs Reported</span>
                    </div>
                    <div class={`run-summary__stat ${runSummary.netFailures > 0 ? 'stat-critical' : ''}`}>
                      <span class="run-summary__stat-value">{runSummary.netFailures}</span>
                      <span class="run-summary__stat-label">Failed Requests</span>
                    </div>
                    <div class={`run-summary__stat ${runSummary.consoleErrors > 0 ? 'stat-warn' : ''}`}>
                      <span class="run-summary__stat-value">{runSummary.consoleErrors}</span>
                      <span class="run-summary__stat-label">Console Errors</span>
                    </div>
                    <div class={`run-summary__stat ${runSummary.critical > 0 ? 'stat-critical' : runSummary.warn > 0 ? 'stat-warn' : 'stat-clean'}`}>
                      <span class="run-summary__stat-value">{runSummary.critical + runSummary.warn}</span>
                      <span class="run-summary__stat-label">Steps With Issues</span>
                    </div>
                  </div>

                  {workspaceSteps.length > 0 && (
                    <div class="step-nav" role="navigation" aria-label="Jump to step">
                      <span class="step-nav__label">Jump to step</span>
                      <div class="step-nav__chips">
                        {workspaceSteps.map((stepItem) => {
                          const sig = stepSignals.get(stepItem.step.id);
                          const sev = sig?.severity ?? 'clean';
                          const issueSummary = sig
                            ? `${sig.bugCount} bugs · ${sig.netFailureCount} failed requests · ${sig.consoleErrorCount} console errors`
                            : 'No issues detected';
                          return (
                            <button
                              key={`nav-${stepItem.step.id}`}
                              type="button"
                              class={`step-nav__chip step-nav__chip--${sev}`}
                              onClick={() => jumpToStep(stepItem.step.index)}
                              title={`Step ${stepItem.step.index} — ${issueSummary}`}
                            >
                              {stepItem.step.index}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {workspaceSteps.map((stepItem) => {
                  const titleValue = stepLabel(stepItem.step);
                  const bugs = normalizeStepBugs(stepItem.step);
                  const notes = normalizeStepNotes(stepItem.step);
                  const canAddNote = notes.length < MAX_STEP_NOTES;
                  const canAddBug = bugs.length < MAX_STEP_BUGS;
                  const stepId = stepItem.step.id;

                  const pinsFor = (target: 'before' | 'after'): ScreenshotPin[] =>
                    screenshotPins(stepItem.step, target);

                  const createPin = (kind: PinKind, text: string, pin: StepPin): void => {
                    if (kind === 'note') {
                      persistStepUpdate(stepId, toStepNoteUpdate([...notes, { id: crypto.randomUUID(), text, pin }]));
                      return;
                    }
                    persistStepUpdate(stepId, toStepBugUpdate([...bugs, { id: crypto.randomUUID(), description: text, pin }]));
                  };

                  const updatePin = (id: string, kind: PinKind, text: string): void => {
                    if (kind === 'note') {
                      persistStepUpdate(stepId, toStepNoteUpdate(
                        notes.map((note) => (note.id === id ? { ...note, text } : note)),
                      ));
                      return;
                    }
                    persistStepUpdate(stepId, toStepBugUpdate(
                      bugs.map((bug) => (bug.id === id ? { ...bug, description: text } : bug)),
                    ));
                  };

                  const deletePin = (id: string, kind: PinKind): void => {
                    if (kind === 'note') {
                      persistStepUpdate(stepId, toStepNoteUpdate(notes.filter((note) => note.id !== id)));
                      return;
                    }
                    persistStepUpdate(stepId, toStepBugUpdate(bugs.filter((bug) => bug.id !== id)));
                  };

                  const movePin = (id: string, kind: PinKind, pin: StepPin): void => {
                    if (kind === 'note') {
                      persistStepUpdate(stepId, toStepNoteUpdate(
                        notes.map((note) => (note.id === id ? { ...note, pin } : note)),
                      ));
                      return;
                    }
                    persistStepUpdate(stepId, toStepBugUpdate(
                      bugs.map((bug) => (bug.id === id ? { ...bug, pin } : bug)),
                    ));
                  };

                  const annotationProps = {
                    maxChars: MAX_ENTRY_CHARS,
                    canAddNote,
                    canAddBug,
                    onCreate: createPin,
                    onUpdate: updatePin,
                    onDelete: deletePin,
                    onMove: movePin,
                  };

                  const unpinnedNotes = notes.filter((note) => !note.pin);
                  const unpinnedBugs = bugs.filter((bug) => !bug.pin);
                  const signal = stepSignals.get(stepItem.step.id);
                  const severity = signal?.severity ?? 'clean';

                  return (
                    <article
                      key={stepItem.step.id}
                      id={`bf-step-${stepItem.step.index}`}
                      class={`card step-card step-card--${severity}`}
                    >
                      <div class="step-header">
                        <div class="step-title-container">
                          <span class="badge badge-muted step-number">Step {stepItem.step.index}</span>
                          <input
                            type="text"
                            class="editable-title"
                            value={titleValue}
                          onInput={(e) => patchWorkspaceStep(stepItem.step.id, { customLabel: (e.target as HTMLInputElement).value })}
                          onBlur={(e) => {
                            const next = (e.target as HTMLInputElement).value.trim();
                            if (next === (stepItem.step.customLabel ?? '').trim()) return;
                            persistStepUpdate(stepItem.step.id, { customLabel: next || undefined });
                          }}
                        />
                        </div>
                        {signal && (
                          <div class="step-signal-chips" aria-label="Step signals">
                            {signal.bugCount > 0 && (
                              <span class="step-chip step-chip--critical" title="Bugs reported on this step">
                                {signal.bugCount} bug{signal.bugCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {signal.netFailureCount > 0 && (
                              <span class="step-chip step-chip--critical" title="Failed network requests near this step">
                                {signal.netFailureCount} failed request{signal.netFailureCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {signal.consoleErrorCount > 0 && (
                              <span class="step-chip step-chip--warn" title="Console errors near this step">
                                {signal.consoleErrorCount} console error{signal.consoleErrorCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {signal.bugCount === 0 && signal.netFailureCount === 0 && signal.consoleErrorCount === 0 && (
                              <span class="step-chip step-chip--clean">Clean</span>
                            )}
                          </div>
                        )}
                      </div>

                      {stepItem.step.pageUrl && <div class="step-url-bar">{stepItem.step.pageUrl}</div>}

                      <div class="step-evidence-visual">
                      {stepItem.afterScreenshotUrl ? (
                        <div class="step-screenshots-row">
                          <div class="step-screenshot-container">
                            <div style="font-size:11px;color:var(--fg-muted);font-weight:600;margin-bottom:6px">[ BEFORE ]</div>
                            {stepItem.beforeScreenshotUrl
                              ? <AnnotatableScreenshot
                                  src={stepItem.beforeScreenshotUrl}
                                  alt={`Step ${stepItem.step.index} before`}
                                  target="before"
                                  pins={pinsFor('before')}
                                  highlightRect={beforeHighlightRect(stepItem.step)}
                                  {...annotationProps}
                                />
                              : <div style="color:var(--fg-muted)">No screenshot available</div>}
                          </div>
                          <div style="color:var(--fg-muted);font-weight:700">-&gt;</div>
                          <div class="step-screenshot-container">
                            <div style="font-size:11px;color:var(--fg-muted);font-weight:600;margin-bottom:6px">[ AFTER ]</div>
                            <AnnotatableScreenshot
                              src={stepItem.afterScreenshotUrl}
                              alt={`Step ${stepItem.step.index} after`}
                              target="after"
                              pins={pinsFor('after')}
                              {...annotationProps}
                            />
                          </div>
                        </div>
                      ) : stepItem.beforeScreenshotUrl ? (
                        <div class="step-screenshot-solo">
                          <AnnotatableScreenshot
                            src={stepItem.beforeScreenshotUrl}
                            alt={`Step ${stepItem.step.index} screenshot`}
                            target="before"
                            pins={pinsFor('before')}
                            highlightRect={beforeHighlightRect(stepItem.step)}
                            {...annotationProps}
                          />
                          {stepItem.noAfterNeeded && (
                            <div class="step-no-change-caption" title="The click completed but the DOM and URL did not change within the stability window">
                              No visible state change after this action
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style="color:var(--fg-muted)">No screenshot available</div>
                      )}

                      <div class="step-annotation-bar">
                        <span class="step-annotation-hint">
                          Click a screenshot to pin a note or bug &middot; hold a pin 2s to move it
                        </span>
                        <span class="step-annotation-counts">
                          <span><i class="pin-swatch note" />{notes.length}/{MAX_STEP_NOTES}</span>
                          <span><i class="pin-swatch bug" />{bugs.length}/{MAX_STEP_BUGS}</span>
                        </span>
                      </div>

                      {(unpinnedNotes.length > 0 || unpinnedBugs.length > 0) && (
                        <div class="step-unpinned-list">
                          {unpinnedNotes.map((note) => (
                            <div key={note.id} class="step-unpinned-item">
                              <span class="pin-swatch note" />
                              <p>{note.text}</p>
                              <button
                                class="step-entry-action danger"
                                onClick={() => deletePin(note.id, 'note')}
                              >
                                Delete
                              </button>
                            </div>
                          ))}
                          {unpinnedBugs.map((bug) => (
                            <div key={bug.id} class="step-unpinned-item">
                              <span class="pin-swatch bug" />
                              <p>{bug.description}</p>
                              <button
                                class="step-entry-action danger"
                                onClick={() => deletePin(bug.id, 'bug')}
                              >
                                Delete
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {stepItem.transitionBadge && (
                        <div style="margin-top:10px">
                          <span class="badge badge-muted">{stepItem.transitionBadge}</span>
                        </div>
                      )}
                      </div>
                    </article>
                  );
                })}
              </section>
            )}

            {viewTab === 'dev' && (
              <section id="session-tab-diagnostics" role="tabpanel" aria-labelledby="session-tab-btn-diagnostics" style="display:flex;flex-direction:column;gap:12px;">
                <div class="devtools-toolbar">
                  <input
                    class="input-field"
                    style="margin-top:0;max-width:360px"
                    aria-label="Filter diagnostics by URL or method"
                    placeholder="Filter by URL or method"
                    value={devtoolsFilter}
                    onInput={(e) => setDevtoolsFilter((e.target as HTMLInputElement).value)}
                  />
                  <div style="display:flex;gap:8px;align-items:center;">
                    <span class="badge badge-muted">{filteredNetworkLogs.length} Requests</span>
                    <span class="badge badge-danger">{serverErrorCount} Server Errors</span>
                    <span class="badge badge-warning">{warningCount} Warnings</span>
                  </div>
                </div>

                <div class="devtools-table-container">
                  <table class="devtools-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Method</th>
                        <th>Endpoint / URL</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {traceRows.map((row) => {
                        if (row.type === 'step') {
                          const step = row.step;
                          return (
                            <tr key={row.id}>
                              <td colSpan={4}>
                                <details
                                  id={`dev-step-${step.step.index}`}
                                  class="dev-step-accordion"
                                  open={pendingTraceStepIndexRef.current === step.step.index}
                                >
                                  <summary>Step: {stepLabel(step.step)} (Click to view screenshots)</summary>
                                  <div style="padding:12px;display:flex;flex-direction:column;gap:10px;">
                                    {step.afterScreenshotUrl ? (
                                      <div class="step-screenshots-row">
                                        <div class="step-screenshot-container">
                                          {step.beforeScreenshotUrl && (
                                            <AnnotatableScreenshot
                                              src={step.beforeScreenshotUrl}
                                              alt="Before"
                                              target="before"
                                              pins={screenshotPins(step.step, 'before')}
                                              highlightRect={beforeHighlightRect(step.step)}
                                              maxChars={MAX_ENTRY_CHARS}
                                              readOnly
                                            />
                                          )}
                                        </div>
                                        <div style="color:var(--fg-muted);font-weight:700">-&gt;</div>
                                        <div class="step-screenshot-container">
                                          <AnnotatableScreenshot
                                            src={step.afterScreenshotUrl}
                                            alt="After"
                                            target="after"
                                            pins={screenshotPins(step.step, 'after')}
                                            maxChars={MAX_ENTRY_CHARS}
                                            readOnly
                                          />
                                        </div>
                                      </div>
                                    ) : step.beforeScreenshotUrl ? (
                                      <AnnotatableScreenshot
                                        src={step.beforeScreenshotUrl}
                                        alt="Step screenshot"
                                        target="before"
                                        pins={screenshotPins(step.step, 'before')}
                                        highlightRect={beforeHighlightRect(step.step)}
                                        maxChars={MAX_ENTRY_CHARS}
                                        readOnly
                                      />
                                    ) : (
                                      <div style="color:var(--fg-muted)">No screenshot available</div>
                                    )}
                                    {normalizeStepBugs(step.step).map((bug) => (
                                      <div key={bug.id} class="bug-panel">
                                        {bug.description || 'Bug flagged without description.'}
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              </td>
                            </tr>
                          );
                        }

                        if (row.type === 'console') {
                          return (
                            <tr key={row.id} class={`devtools-row ${row.level === 'error' ? 'critical' : 'warning'}`}>
                              <td><span class={`dev-log-status ${row.level === 'error' ? 'critical' : 'warning'}`}>{row.level.toUpperCase()}</span></td>
                              <td>CONSOLE</td>
                              <td>{row.message}</td>
                              <td>{formatClock(row.ts)}</td>
                            </tr>
                          );
                        }

                        const severity = networkStatusClass(row.log.status);
                        return (
                          <tr
                            key={row.id}
                            class={`devtools-row ${severity === 'warning' ? 'warning' : ''} ${severity === 'critical' ? 'critical' : ''} ${selectedLogId === row.log.id ? 'selected' : ''}`}
                            role="button"
                            tabIndex={0}
                            aria-label={`${row.log.method} ${endpointForLog(row.log.url)} status ${row.log.status || 'error'}`}
                            onKeyDown={(event) => {
                              if (!isKeyboardActivationKey(event.key)) return;
                              event.preventDefault();
                              setSelectedLogId(row.log.id);
                              setInspectorTab('headers');
                            }}
                            onClick={() => {
                              setSelectedLogId(row.log.id);
                              setInspectorTab('headers');
                            }}
                          >
                            <td><span class={`dev-log-status ${severity}`}>{row.log.status || 'ERR'}</span></td>
                            <td>{row.log.method}</td>
                            <td>{endpointForLog(row.log.url)}</td>
                            <td>{formatClock(row.log.timestamp)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div class="payload-inspector">
                  <div class="inspector-tabs">
                    <button class={`inspector-tab ${inspectorTab === 'headers' ? 'active' : ''}`} onClick={() => setInspectorTab('headers')}>
                      Request Headers
                    </button>
                    <button class={`inspector-tab ${inspectorTab === 'payload' ? 'active' : ''}`} onClick={() => setInspectorTab('payload')}>
                      Payload/Body
                    </button>
                    <button class={`inspector-tab ${inspectorTab === 'response' ? 'active' : ''}`} onClick={() => setInspectorTab('response')}>
                      Response
                    </button>
                  </div>
                  <div class="json-viewer-container">
                    <button class="copy-btn" onClick={() => void copyInspectorPayload()}>
                      {copyFeedback ? 'Copied!' : 'Copy'}
                    </button>
                    <pre class="json-viewer">{inspectorPayload}</pre>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </main>
      <div class={`bflow-dropzone ${isBflowDragging ? 'dragging' : ''}`}>
        <div class="bflow-drop-text">Drop .bflow file to import</div>
      </div>
      </div>
    {modalState && (
      <Modal
        title={modalState.title}
        body={modalState.body}
        inputPlaceholder={modalState.inputPlaceholder}
        inputValue={modalState.inputValue}
        isDanger={modalState.isDanger}
        onCancel={() => setModalState(null)}
        onConfirm={async (value) => {
          await modalState.onConfirm(value);
        }}
      />
    )}
    <ExportModal
      context={exportModalContext}
      isOpen={isExportModalOpen}
      selectedFormat={selectedExportFormat}
      selectionMode={sessionSelectionMode}
      canUseSelectedRun={canUseSelectedRun}
      canUseLatestRun={canUseLatestRun}
      hasAnyExportableData={hasAnyExportableData}
      preflight={exportPreflight}
      isPreflighting={isExportPreflighting}
      isExporting={isAnyExportRunning}
      isCopyingEvidence={isCopyingEvidence}
      exportStatusText={exportStatusText}
      onSelectFormat={handleExportFormatChange}
      onSelectMode={handleExportModeChange}
      onConfirm={() => {
        void runUnifiedExport(selectedExportFormat);
      }}
      onCopyEvidence={() => {
        void handleCopyEvidence();
      }}
      canCopyEvidence={exportModalContext === 'feature' ? hasAnyExportableData : Boolean(activeSession)}
      onClose={() => {
        if (isAnyExportRunning || isCopyingEvidence) return;
        setIsExportModalOpen(false);
      }}
    />
    <PricingModal
      isOpen={routeView === 'pricing'}
      onClose={closePricing}
      onNavigateWelcome={navigateToWelcome}
      onAuthSuccess={() => {
        void refreshAuthStatus(false);
        navigateToView('dashboard', 'replace');
      }}
      onAuthStatusChange={(status) => {
        setAuthStatus(status);
        setAuthLoading(false);
      }}
      runtimeMessage={runtimeMessage}
    />
    {toastStack}
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<DashboardApp />, root);
