import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { EvidenceStoredEvent, Session, Step, TestEvent } from '../../core/types.js';
import { buildSemanticReport } from '../../core/semantic.js';
import { getAllSessions, getBlob, getEventsForSession, getStepsForSession } from '../../storage/db.js';
import { downloadBusinessFlowReport, exportBusinessFlowReportHtml } from '../export/html-export.js';

interface StepNetworkFailure {
  method: string;
  url: string;
  statusCode: number | 'error';
  durationMs?: number;
}

interface TimelineStep {
  step: Step;
  label: string;
  note?: string;
  beforeScreenshotUrl?: string;
  afterScreenshotUrl?: string;
  transitionBadge?: string;
  issuePills: string[];
  networkFailures: StepNetworkFailure[];
  consoleErrors: string[];
}

function buildTransitionBadge(beforeUrl: string | undefined, afterUrl: string | undefined): string | undefined {
  if (!beforeUrl || !afterUrl) return undefined;
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    if (before.origin !== after.origin) {
      return `Origin changed: ${before.host} -> ${after.host}`;
    }
    const beforePath = `${before.pathname}${before.search}${before.hash}`;
    const afterPath = `${after.pathname}${after.search}${after.hash}`;
    if (beforePath !== afterPath) {
      return `Navigated: ${beforePath || '/'} -> ${afterPath || '/'}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [hiddenStepIds, setHiddenStepIds] = useState<Record<string, true>>({});
  const [timelineSteps, setTimelineSteps] = useState<TimelineStep[]>([]);
  const [testStatus, setTestStatus] = useState<'pass' | 'fail' | 'blocked'>('pass');

  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    void (async () => {
      const all = await getAllSessions();
      setSessions(all);
      if (all.length > 0) setSelectedSessionId(all[0]?.id ?? '');
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selectedSessionId) return;
    setLoading(true);
    void (async () => {
      const [sessionEvents, sessionSteps] = await Promise.all([
        getEventsForSession(selectedSessionId),
        getStepsForSession(selectedSessionId),
      ]);
      setEvents(sessionEvents);
      setSteps(sessionSteps);
      setHiddenStepIds({});
      setLoading(false);
    })();
  }, [selectedSessionId]);

  useEffect(() => {
    void (async () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current = [];

      if (steps.length === 0) {
        setTimelineSteps([]);
        return;
      }

      const evidenceById = new Map<string, EvidenceStoredEvent>();
      for (const ev of events) {
        if (ev.kind === 'evidence_stored') evidenceById.set(ev.id, ev);
      }

      const sorted = [...steps].sort((a, b) => a.index - b.index);
      const nextTsById = new Map<string, number>();
      for (let i = 0; i < sorted.length; i++) {
        nextTsById.set(sorted[i]!.id, sorted[i + 1]?.ts ?? (sorted[i]!.ts + 12_000));
      }

      const built: TimelineStep[] = [];

      for (const step of sorted) {
        const afterEv = step.afterEvidenceEventId ? evidenceById.get(step.afterEvidenceEventId) : undefined;
        const beforeEv = step.beforeEvidenceEventId ? evidenceById.get(step.beforeEvidenceEventId) : undefined;

        let beforeScreenshotUrl: string | undefined;
        if (beforeEv?.blobKey) {
          const blob = await getBlob(beforeEv.blobKey);
          if (blob) {
            const copied = new Uint8Array(new ArrayBuffer(blob.data.byteLength));
            copied.set(blob.data);
            const objectUrl = URL.createObjectURL(new Blob([copied], { type: blob.mimeType }));
            blobUrlsRef.current.push(objectUrl);
            beforeScreenshotUrl = objectUrl;
          }
        }

        let afterScreenshotUrl: string | undefined;
        if (afterEv?.blobKey) {
          const blob = await getBlob(afterEv.blobKey);
          if (blob) {
            const copied = new Uint8Array(new ArrayBuffer(blob.data.byteLength));
            copied.set(blob.data);
            const objectUrl = URL.createObjectURL(new Blob([copied], { type: blob.mimeType }));
            blobUrlsRef.current.push(objectUrl);
            afterScreenshotUrl = objectUrl;
          }
        }

        const startTs = step.ts;
        const endTs = nextTsById.get(step.id) ?? (step.ts + 12_000);

        const failedNetworkEvents = events.filter((ev): ev is Extract<TestEvent, { kind: 'net_phase' }> =>
          ev.tabId === step.tabId
          && ev.ts >= startTs
          && ev.ts <= endTs
          && ev.kind === 'net_phase'
          && ((ev.phase === 'complete' && (ev.statusCode ?? 0) >= 400) || ev.phase === 'error'),
        );

        const networkFailures: StepNetworkFailure[] = failedNetworkEvents.map((ev) => {
          const startEvent = events.find((candidate): candidate is Extract<TestEvent, { kind: 'net_phase' }> =>
            candidate.kind === 'net_phase'
            && candidate.requestId === ev.requestId
            && candidate.phase === 'start'
            && candidate.tabId === ev.tabId
            && candidate.ts <= ev.ts,
          );
          const durationMs = startEvent ? Math.max(0, ev.ts - startEvent.ts) : undefined;
          return {
            method: ev.method,
            url: ev.url,
            statusCode: ev.phase === 'error' ? 'error' : (ev.statusCode ?? 0),
            durationMs,
          };
        });

        const consoleErrorMessages = events
          .filter((ev): ev is Extract<TestEvent, { kind: 'console_error' | 'page_error' }> =>
            ev.tabId === step.tabId
            && ev.ts >= startTs
            && ev.ts <= endTs
            && (ev.kind === 'console_error' || ev.kind === 'page_error'),
          )
          .map((ev) => ev.message);

        const failedNetworkCount = networkFailures.length;
        const consoleErrorCount = consoleErrorMessages.length;

        const issuePills: string[] = [];
        if (failedNetworkCount > 0) {
          issuePills.push(`Warning ${failedNetworkCount} Failed Network Request${failedNetworkCount !== 1 ? 's' : ''}`);
        }
        if (consoleErrorCount > 0) {
          issuePills.push(`Warning ${consoleErrorCount} Console Error${consoleErrorCount !== 1 ? 's' : ''}`);
        }

        const beforeUrl = beforeEv?.pageUrl ?? step.pageUrl;
        const afterUrl = afterEv?.pageUrl;
        const transitionBadge = buildTransitionBadge(beforeUrl, afterUrl);

        built.push({
          step,
          label: step.labelOverride?.trim() || step.label,
          note: step.note,
          beforeScreenshotUrl,
          afterScreenshotUrl,
          transitionBadge,
          issuePills,
          networkFailures,
          consoleErrors: consoleErrorMessages,
        });
      }

      setTimelineSteps(built);
    })();

    return () => {
      for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
      blobUrlsRef.current = [];
    };
  }, [events, steps]);

  const session = sessions.find((s) => s.id === selectedSessionId);

  useEffect(() => {
    if (!session) return;
    if (session.testResult === 'fail' || session.testResult === 'blocked' || session.testResult === 'pass') {
      setTestStatus(session.testResult);
      return;
    }
    setTestStatus('pass');
  }, [session?.id]);

  const visibleSteps = useMemo(
    () => timelineSteps.filter((s) => !hiddenStepIds[s.step.id]),
    [timelineSteps, hiddenStepIds],
  );

  const semantic = useMemo(() => {
    if (!session) return null;
    return buildSemanticReport(session, events);
  }, [session, events]);

  const totalDurationLabel = useMemo(() => {
    if (!session) return '0s';
    const end = session.endedAt ?? Date.now();
    const durationMs = Math.max(0, end - session.startedAt);
    return formatDuration(durationMs);
  }, [session]);

  const totalDetectedIssues = useMemo(
    () => visibleSteps.reduce((sum, s) => sum + s.networkFailures.length + s.consoleErrors.length, 0),
    [visibleSteps],
  );

  const finalPayload = useMemo(() => ({
    sessionId: selectedSessionId,
    testStatus,
    summary: {
      totalDuration: totalDurationLabel,
      totalCapturedSteps: visibleSteps.length,
      totalDetectedIssues,
    },
    includedStepIds: visibleSteps.map((s) => s.step.id),
    steps: visibleSteps.map((s) => ({
      stepId: s.step.id,
      stepIndex: s.step.index,
      label: s.label,
      note: s.note ?? '',
      issuePills: s.issuePills,
      networkFailures: s.networkFailures,
      consoleErrors: s.consoleErrors,
      afterEvidenceEventId: s.step.afterEvidenceEventId,
      beforeEvidenceEventId: s.step.beforeEvidenceEventId,
    })),
  }), [selectedSessionId, testStatus, totalDurationLabel, totalDetectedIssues, visibleSteps]);

  const hideStep = (stepId: string) => {
    setHiddenStepIds((prev) => ({ ...prev, [stepId]: true }));
  };

  const unhideStep = (stepId: string) => {
    setHiddenStepIds((prev) => {
      const next = { ...prev };
      delete next[stepId];
      return next;
    });
  };

  const copyPayload = async () => {
    await navigator.clipboard.writeText(JSON.stringify(finalPayload, null, 2));
  };

  const handleExportHtml = async () => {
    if (!session) return;
    const html = await exportBusinessFlowReportHtml(session, finalPayload);
    downloadBusinessFlowReport(html);
  };

  if (loading) return <div class="report-state">Loading report workspace…</div>;
  if (!session) return <div class="report-state">No sessions available yet.</div>;

  return (
    <div class="workspace-shell">
      <header class="ws-header">
        <div>
          <img class="ws-brand-wordmark" src="../logo/Brand_Name.png" alt="BusinessFlow" />
          <h1>Evidence Review Workspace</h1>
          <p>Executive Summary, Test Evidence, Technical Context</p>
        </div>
        <div class="ws-controls">
          <label htmlFor="session-select" class="sr-only">Select session</label>
          <select id="session-select" aria-label="Select session" value={selectedSessionId} onChange={(e) => setSelectedSessionId((e.target as HTMLSelectElement).value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.testCaseName}</option>
            ))}
          </select>
          <button class="btn btn-primary" onClick={() => void handleExportHtml()}>Export HTML</button>
          <button class="btn btn-outline" onClick={() => void copyPayload()}>Copy Final Payload</button>
        </div>
      </header>

      <section class="summary-card card">
        <div class="summary-header-row">
          <div>
            <h2>Executive Summary</h2>
            <p class="summary-subtitle">Authoritative session overview before export</p>
          </div>
          <label class="status-select-wrap" htmlFor="test-status-select">
            <span>Test Status</span>
            <select id="test-status-select" value={testStatus} onChange={(e) => setTestStatus((e.target as HTMLSelectElement).value as 'pass' | 'fail' | 'blocked')}>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
        </div>
        <div class="summary-grid">
          <div><span>{totalDurationLabel}</span><small>Total Duration</small></div>
          <div><span>{visibleSteps.length}</span><small>Total Captured Steps</small></div>
          <div><span>{totalDetectedIssues}</span><small>Total Detected Issues</small></div>
        </div>
      </section>

      <section class="evidence-section card">
        <h2>Test Evidence</h2>
        <div class="timeline">
          {timelineSteps.map((item) => {
            const hidden = Boolean(hiddenStepIds[item.step.id]);
            return (
              <article key={item.step.id} class={`step-block card ${hidden ? 'step-block--hidden' : ''}`}>
                <div class="step-head">
                  <div>
                    <div class="step-num">Step {item.step.index}</div>
                    <div class="step-label">{item.label}</div>
                    <div class="step-note">QA Note: {item.note?.trim() || 'None'}</div>
                  </div>
                  <div class="step-actions">
                    {!hidden && <button class="btn btn-outline" aria-label={`Hide step ${item.step.index}`} onClick={() => hideStep(item.step.id)}>Hide Step</button>}
                    {!hidden && <button class="btn btn-outline" aria-label={`Remove step ${item.step.index} from export payload`} onClick={() => hideStep(item.step.id)}>Delete</button>}
                    {hidden && <button class="btn btn-outline" aria-label={`Restore step ${item.step.index}`} onClick={() => unhideStep(item.step.id)}>Restore</button>}
                  </div>
                </div>

                {!hidden && (
                  <>
                    <div class="step-shot-wrap">
                      {item.beforeScreenshotUrl && item.afterScreenshotUrl ? (
                        <>
                          <div class="step-shot-pair" aria-label="Before and after evidence">
                            <div class="step-shot-frame">
                              <div class="step-shot-frame__label">[ BEFORE ]</div>
                              <img src={item.beforeScreenshotUrl} class="step-shot screenshot-thumb" alt={`Step ${item.step.index} before evidence`} />
                            </div>
                            <div class="step-shot-arrow" aria-hidden="true">-&gt;</div>
                            <div class="step-shot-frame">
                              <div class="step-shot-frame__label">[ AFTER ]</div>
                              <img src={item.afterScreenshotUrl} class="step-shot screenshot-thumb" alt={`Step ${item.step.index} after evidence`} />
                            </div>
                          </div>
                          {item.transitionBadge && <div class="step-transition-badge badge">{item.transitionBadge}</div>}
                        </>
                      ) : (
                        item.beforeScreenshotUrl
                          ? (
                            <div class="step-shot-frame step-shot-frame--single">
                              <div class="step-shot-frame__label">[ BEFORE ]</div>
                              <img
                                src={item.beforeScreenshotUrl}
                                class="step-shot screenshot-thumb"
                                alt={`Step ${item.step.index} before evidence`}
                              />
                            </div>
                          )
                          : <div class="step-shot-empty">No screenshot available</div>
                      )}
                    </div>
                    <div class="pill-row">
                      {item.issuePills.length === 0
                        ? <span class="pill pill-ok">No issues detected</span>
                        : item.issuePills.map((pill) => <span key={pill} class="pill pill-warn">{pill}</span>)}
                    </div>

                    <details class="tech-details card">
                      <summary>Technical Context ▾</summary>
                      <div class="tech-details__content">
                        <div class="tech-details__section">
                          <div class="tech-details__title">Network Failures</div>
                          {item.networkFailures.length === 0 && <div class="tech-empty">None</div>}
                          {item.networkFailures.length > 0 && (
                            <table class="tech-table">
                              <thead>
                                <tr>
                                  <th>Method</th>
                                  <th>URL</th>
                                  <th>Status</th>
                                  <th>Duration</th>
                                </tr>
                              </thead>
                              <tbody>
                                {item.networkFailures.map((row, i) => (
                                  <tr key={`${item.step.id}-net-${i}`}>
                                    <td>{row.method}</td>
                                    <td title={row.url}>{row.url}</td>
                                    <td>{row.statusCode}</td>
                                    <td>{typeof row.durationMs === 'number' ? `${Math.round(row.durationMs)}ms` : 'n/a'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                        <div class="tech-details__section">
                          <div class="tech-details__title">Console Errors</div>
                          {item.consoleErrors.length === 0 && <div class="tech-empty">None</div>}
                          {item.consoleErrors.length > 0 && (
                            <ul class="tech-errors">
                              {item.consoleErrors.map((err, i) => (
                                <li key={`${item.step.id}-err-${i}`}>{err}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </details>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section class="tech-section card">
        <h2>Technical Context</h2>
        <div class="tech-grid">
          <div><strong>Session:</strong> {session.testCaseName}</div>
          <div><strong>Result:</strong> {session.testResult}</div>
          <div><strong>API calls:</strong> {semantic?.totalApiCalls ?? 0}</div>
          <div><strong>Failed APIs:</strong> {semantic?.failedApiCalls ?? 0}</div>
          <div><strong>Console errors:</strong> {session.counters.consoleErrors}</div>
          <div><strong>Page errors:</strong> {session.counters.pageErrors}</div>
        </div>
      </section>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

const root = document.getElementById('root');
if (root) render(<App />, root);
