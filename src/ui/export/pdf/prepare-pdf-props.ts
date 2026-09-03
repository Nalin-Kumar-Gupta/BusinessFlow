import type {
  CanonicalExportModel,
  CanonicalStep,
  ConsoleFindingSummary,
  EvidenceRef,
  NavigationSummary,
  NetworkFindingSummary,
  ObservedFinding,
  StepAnnotation,
} from '../../../export/model/canonical.js';
import type { FindingSeverity } from '../../../core/types.js';

import { isFeatureAggregateModel, mapFindingsByStep, selectTestCaseStorySteps } from '../test-case-story.js';
import { SEVERITY_ORDER, VERDICT_COLORS, VERDICT_LABEL } from './pdf-styles.js';
import type {
  PdfAnnotationLegendEntry,
  PdfAppendixConsoleRow,
  PdfAppendixNavigationRow,
  PdfAppendixNetworkRow,
  PdfAppendixView,
  PdfCorrelatedLine,
  PdfCoverRiskItem,
  PdfCoverView,
  PdfEvidenceView,
  PdfFindingView,
  PdfFooterView,
  PdfHighlightRectView,
  PdfKeyValue,
  PdfNegativeAssertionView,
  PdfNegativeInferenceView,
  PdfPinView,
  PdfStat,
  PdfStepBugView,
  PdfStepNoteView,
  PdfStepView,
  PdfViewModel,
} from './pdf-view-model.js';


/**
 * The renderer never touches storage. It is given a resolver that answers
 * "for this blobKey, what's the data URL to draw?" — or `undefined` if the
 * blob is unavailable (missing, corrupted, failed to load).
 */
export interface EvidenceResolver {
  resolve(blobKey: string): string | undefined;
}
export interface PreparePdfPropsOptions {
  /** Injected for testability. Defaults to Intl-based en-US formatting. */
  readonly formatDateTime?: (ts: number) => string;
  readonly formatDuration?: (ms: number) => string;
}
export function preparePdfProps(
  model: CanonicalExportModel,
  evidenceResolver: EvidenceResolver,
  options: PreparePdfPropsOptions = {},
): PdfViewModel {
  const fmt = options.formatDateTime ?? defaultFormatDateTime;
  const fmtDur = options.formatDuration ?? defaultFormatDuration;

  const sortedFindings = sortFindings(model.findings);
  const cover = buildCover(model, sortedFindings, fmt);
  const environment = buildEnvironmentEntries(model, fmt, fmtDur);
  const executionStats = buildExecutionStats(model);
  const allSteps = model.sections.flatMap((section) => section.steps);
  const findingsByStep = mapFindingsByStep(sortedFindings);
  const isFeatureScope = isFeatureAggregateModel(model);

  let missing = 0;
  const stepsForStory = isFeatureScope ? [] : selectTestCaseStorySteps(model);
  const steps = stepsForStory.map((step, idx, all) =>
    buildStepView(step, idx, all.length, findingsByStep, evidenceResolver, fmt, fmtDur, (delta) => { missing += delta; }),
  );

  const testCaseSections = isFeatureScope
    ? model.sections.map((section) => {
      const sectionSteps = section.steps.map((step, idx, all) =>
        buildStepView(step, idx, all.length, findingsByStep, evidenceResolver, fmt, fmtDur, (delta) => { missing += delta; }),
      );
      const verdictKey = section.status ?? section.testResult ?? 'draft';
      const findingsCount = sortedFindings.filter((finding) => (
        typeof finding.stepIndex === 'number'
        && section.steps.some((step) => step.index === finding.stepIndex)
      )).length;

      return {
        id: section.id,
        title: section.title ?? 'Untitled Test Case',
        verdictLabel: VERDICT_LABEL[verdictKey] ?? String(verdictKey).toUpperCase(),
        verdictColor: VERDICT_COLORS[verdictKey] ?? '#5f6368',
        ...(section.sourceSessionId ? { sessionId: section.sourceSessionId } : {}),
        ...(typeof section.startedAt === 'number' ? { startedAtLabel: fmt(section.startedAt) } : {}),
        ...(typeof section.durationMs === 'number' ? { durationLabel: fmtDur(section.durationMs) } : {}),
        stepCount: section.steps.length,
        findingsCount,
        steps: sectionSteps,
      };
    })
    : undefined;

  const featureSummary = isFeatureScope
    ? buildFeatureSummary(model, sortedFindings)
    : undefined;

  const findings = sortedFindings.map((finding) =>
    buildFindingView(finding, allSteps, fmt),
  );
  const appendix = buildAppendix(model, fmt);
  const footer = buildFooter(model, fmt);

  return {
    cover,
    environment,
    executionStats,
    steps,
    findings,
    appendix,
    footer,
    missingScreenshotCount: missing,
    ...(featureSummary ? { featureSummary } : {}),
    ...(testCaseSections ? { testCaseSections } : {}),
  };
}
function buildCover(
  model: CanonicalExportModel,
  findings: readonly ObservedFinding[],
  fmt: (ts: number) => string,
): PdfCoverView {
  const overview = model.overview;
  const isFeatureScope = isFeatureAggregateModel(model);
  // `status` (draft/pass/fail/blocked) is the tester-managed workflow state;
  // `testResult` is the auto-derived verdict. Prefer the human-managed status
  // when present because it's what the tester has actually declared.
  const verdictKey = overview.status ?? overview.testResult;
  const verdictLabel = VERDICT_LABEL[verdictKey] ?? verdictKey.toUpperCase();
  const verdictColor = VERDICT_COLORS[verdictKey] ?? '#5f6368';

  const identity: PdfKeyValue[] = [];
  if (overview.featureName) identity.push({ label: 'Feature', value: overview.featureName });
  if (!isFeatureScope && overview.testCaseId) identity.push({ label: 'Test Case ID', value: overview.testCaseId });
  if (!isFeatureScope && overview.testType) identity.push({ label: 'Test Type', value: overview.testType });
  identity.push({ label: isFeatureScope ? 'Feature Export ID' : 'Session ID', value: model.meta.sessionId });
  identity.push({ label: 'Executed', value: fmt(model.environment.startedAt) });
  identity.push({ label: 'Correlation Version', value: `v${model.meta.correlationVersion}` });

  const negativeTestBanner = overview.negativeTest === 'yes'
    ? 'Negative test — failing responses were the expected behavior for this run.'
    : undefined;

  const atGlance = buildAtGlanceStats(model);
  const topRisks = buildCoverTopRisks(findings, model.sections.flatMap((s) => s.steps));
  const negativeAssertions = buildCoverNegativeAssertions(model);
  const statusContextBanner = buildStatusContextBanner(model, verdictKey);

  return {
    brand: 'BusinessFlow',
    reportTitle: isFeatureScope ? 'QA Feature Report' : 'QA Test Report',
    verdictKey,
    verdictLabel,
    verdictColor,
    testCaseName: isFeatureScope
      ? `${overview.featureName ?? 'Feature'} — Feature summary`
      : (overview.testCaseName ?? 'Untitled Test Case'),
    verdictSummary: overview.verdictSummary,
    identity,
    atGlance,
    topRisks,
    negativeAssertions,
    ...(overview.testerNotes ? { testerNotes: overview.testerNotes } : {}),
    ...(negativeTestBanner ? { negativeTestBanner } : {}),
    ...(statusContextBanner ? { statusContextBanner } : {}),
  };
}

function buildAtGlanceStats(model: CanonicalExportModel): PdfStat[] {
  const s = model.stats;
  const criticalHigh = (s.findings.critical ?? 0) + (s.findings.high ?? 0);
  return [
    { label: 'Steps Tested', value: String(s.steps) },
    { label: 'Bugs', value: String(s.bugs), emphasized: s.bugs > 0 },
    { label: 'Critical/High', value: String(criticalHigh), emphasized: criticalHigh > 0 },
    { label: 'Failed Requests', value: String(s.network.failed), emphasized: s.network.failed > 0 },
  ];
}

function buildFeatureSummary(
  model: CanonicalExportModel,
  findings: readonly ObservedFinding[],
): NonNullable<PdfViewModel['featureSummary']> {
  const resultCounts = {
    PASS: 0,
    FAIL: 0,
    BLOCKED: 0,
    PARTIAL: 0,
    'IN PROGRESS': 0,
    DRAFT: 0,
  } as const;

  const mutableCounts: Record<keyof typeof resultCounts, number> = { ...resultCounts };
  const matrix = model.sections.map((section) => {
    const verdictKey = section.status ?? section.testResult ?? 'draft';
    const verdictLabel = VERDICT_LABEL[verdictKey] ?? String(verdictKey).toUpperCase();
    const findingsCount = findings.filter((finding) => (
      typeof finding.stepIndex === 'number'
      && section.steps.some((step) => step.index === finding.stepIndex)
    )).length;

    if (verdictLabel in mutableCounts) mutableCounts[verdictLabel as keyof typeof mutableCounts] += 1;

    return {
      testCase: section.title ?? 'Untitled Test Case',
      result: verdictLabel,
      stepCount: section.steps.length,
      findingsCount,
    };
  });

  return {
    totalTestCases: model.sections.length,
    resultCounts: mutableCounts,
    matrix,
  };
}

function buildCoverTopRisks(
  findings: readonly ObservedFinding[],
  allSteps: readonly CanonicalStep[],
): PdfCoverRiskItem[] {
  return findings
    .filter((finding) => finding.disposition !== 'expected-negative')
    .filter((finding) => finding.severity === 'critical' || finding.severity === 'high')
    .slice(0, 3)
    .map((finding) => ({
      severity: finding.severity,
      severityLabel: finding.severity.toUpperCase(),
      summary: finding.summary,
      ...(typeof finding.stepIndex === 'number'
        ? { stepReference: formatStepReference(finding.stepIndex, allSteps) }
        : {}),
    }));
}

function buildCoverNegativeAssertions(model: CanonicalExportModel): PdfNegativeAssertionView[] {
  return (model.overview.negativeAssertions ?? []).map((assertion) => ({
    channelLabel: assertion.channel === 'http' ? 'HTTP' : 'UI',
    expected: assertion.expected,
    observed: assertion.observed,
    verdictLabel: assertion.verdict === 'pass' ? 'PASS' : 'FAIL',
    verdictColor: assertion.verdict === 'pass' ? '#0f9d58' : '#c5221f',
  }));
}

function buildStatusContextBanner(model: CanonicalExportModel, verdictKey: string): string | undefined {
  if (verdictKey === 'blocked') {
    return 'Blocked run — tester could not complete execution. Use step evidence below to identify where progression stopped.';
  }
  if (verdictKey === 'in_progress' || verdictKey === 'draft' || model.environment.endedAt === undefined) {
    return 'Incomplete run — session ended before a formal completion signal. Treat missing steps as unknown, not pass.';
  }
  return undefined;
}

function buildEnvironmentEntries(
  model: CanonicalExportModel,
  fmt: (ts: number) => string,
  fmtDur: (ms: number) => string,
): PdfKeyValue[] {
  const env = model.environment;
  const entries: PdfKeyValue[] = [];
  entries.push({ label: 'Started', value: fmt(env.startedAt) });
  if (typeof env.endedAt === 'number') entries.push({ label: 'Ended', value: fmt(env.endedAt) });
  if (typeof env.durationMs === 'number') entries.push({ label: 'Duration', value: fmtDur(env.durationMs) });
  if (env.chromeVersion) entries.push({ label: 'Chrome', value: env.chromeVersion });
  if (env.platform) entries.push({ label: 'Platform', value: env.platform });
  if (env.viewport) {
    entries.push({
      label: 'Viewport',
      value: `${env.viewport.width}×${env.viewport.height} @ ${env.viewport.dpr}x`,
    });
  }
  if (env.timeZone) entries.push({ label: 'Time Zone', value: env.timeZone });
  if (env.scopeOrigins.length > 0) entries.push({ label: 'Tested Origins', value: env.scopeOrigins.join(', ') });
  if (typeof env.apiSlaSec === 'number' && env.apiSlaSec > 0) {
    entries.push({ label: 'API SLA', value: `${env.apiSlaSec}s` });
  }
  if (env.extVersion) entries.push({ label: 'Extension', value: env.extVersion });
  return entries;
}
function buildExecutionStats(model: CanonicalExportModel): PdfStat[] {
  const s = model.stats;
  const stats: PdfStat[] = [];
  stats.push({ label: 'Steps', value: String(s.steps) });
  stats.push({ label: 'Steps with Bugs', value: String(s.stepsWithBugs), emphasized: s.stepsWithBugs > 0 });
  stats.push({ label: 'Bugs', value: String(s.bugs), emphasized: s.bugs > 0 });
  stats.push({ label: 'Findings', value: String(sumSeverities(s.findings)) });
  stats.push({ label: 'Failed Requests', value: String(s.network.failed), emphasized: s.network.failed > 0 });
  stats.push({ label: 'Slow > SLA', value: String(s.network.slowOverSla) });
  stats.push({ label: 'Console Errors', value: String(s.console.errors), emphasized: s.console.errors > 0 });
  stats.push({ label: 'Page Errors', value: String(s.console.pageErrors), emphasized: s.console.pageErrors > 0 });
  stats.push({ label: 'Rage Clicks', value: String(s.userSignals.rageClicks), emphasized: s.userSignals.rageClicks > 0 });
  stats.push({ label: 'Manual Captures', value: String(s.userSignals.manualCaptures) });
  stats.push({ label: 'Screenshots', value: String(s.userSignals.screenshots) });
  stats.push({ label: 'No Visible Change', value: String(s.stepsNoStateChange) });

  if (s.performance) {
    const perf = s.performance;
    if (typeof perf.lcpMs === 'number') stats.push({ label: 'LCP', value: `${Math.round(perf.lcpMs)} ms` });
    if (typeof perf.fcpMs === 'number') stats.push({ label: 'FCP', value: `${Math.round(perf.fcpMs)} ms` });
    if (typeof perf.inpMs === 'number') stats.push({ label: 'INP', value: `${Math.round(perf.inpMs)} ms` });
    if (typeof perf.cls === 'number') stats.push({ label: 'CLS', value: perf.cls.toFixed(3) });
    if (typeof perf.ttfbMs === 'number') stats.push({ label: 'TTFB', value: `${Math.round(perf.ttfbMs)} ms` });
  }
  return stats;
}

function sumSeverities(sev: Record<FindingSeverity, number>): number {
  return SEVERITY_ORDER.reduce((sum, key) => sum + (sev[key] ?? 0), 0);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
function buildStepView(
  step: CanonicalStep,
  positionInOrderedList: number,
  totalSteps: number,
  findingsByStep: ReadonlyMap<number, readonly ObservedFinding[]>,
  evidenceResolver: EvidenceResolver,
  fmt: (ts: number) => string,
  fmtDur: (ms: number) => string,
  reportMissing: (delta: number) => void,
): PdfStepView {
  const indexLabel = `Step ${step.index}`;
  const actionLine = step.action.label;

  const durationLabel = typeof step.durationToNextMs === 'number' && positionInOrderedList < totalSteps - 1
    ? `+${fmtDur(step.durationToNextMs)}`
    : undefined;

  // Pin numbering: assign global step-scoped numbers to pinned notes + bugs.
  // Numbers persist across the legend + on-image pins so the reader can look
  // up "① what did they mean?" at the bottom.
  let pinCounter = 0;
  const numberedNotes = step.testerNotes
    .map((note) => {
      const pinAnnotation = step.annotations.find((a) => a.kind === 'pin' && a.sourceKind === 'note' && a.sourceId === note.id);
      const number = pinAnnotation ? ++pinCounter : undefined;
      return { note, pinAnnotation, number };
    });
  const numberedBugs = step.bugs
    .map((bug) => {
      const pinAnnotation = step.annotations.find((a) => a.kind === 'pin' && a.sourceKind === 'bug' && a.sourceId === bug.id);
      const number = pinAnnotation ? ++pinCounter : undefined;
      return { bug, pinAnnotation, number };
    });

  const legend: PdfAnnotationLegendEntry[] = [];

  const beforeHighlightRect = buildBeforeHighlightRect(step);
  const beforeEvidence = buildEvidenceView(step.beforeEvidence, 'BEFORE', evidenceResolver, fmt, reportMissing,
    pickPinViews(numberedNotes, numberedBugs, 'before'),
    beforeHighlightRect);
  const afterEvidence = step.afterEvidence
    ? buildEvidenceView(step.afterEvidence, 'AFTER', evidenceResolver, fmt, reportMissing,
      pickPinViews(numberedNotes, numberedBugs, 'after'))
    : undefined;
  const systemEvidence = step.systemEvidence.map((ev) =>
    buildEvidenceView(ev, 'SYSTEM', evidenceResolver, fmt, reportMissing,
      pickPinViews(numberedNotes, numberedBugs, 'system')),
  ).filter((v): v is PdfEvidenceView => v !== undefined);

  for (const { note, pinAnnotation, number } of numberedNotes) {
    if (number === undefined || !pinAnnotation) continue;
    legend.push({
      number,
      kind: 'note',
      target: pinAnnotation.target,
      text: note.text || 'Tester note',
    });
  }
  for (const { bug, pinAnnotation, number } of numberedBugs) {
    if (number === undefined || !pinAnnotation) continue;
    legend.push({
      number,
      kind: 'bug',
      target: pinAnnotation.target,
      text: bug.description || 'Bug (no description)',
    });
  }

  const bugsView: PdfStepBugView[] = numberedBugs.map(({ bug, number }) => ({
    id: bug.id,
    description: bug.description || 'No description provided',
    ...(number ? { pinNumber: number } : {}),
  }));
  const notesView: PdfStepNoteView[] = numberedNotes.map(({ note, number }) => ({
    id: note.id,
    text: note.text,
    ...(number ? { pinNumber: number } : {}),
  }));
  const stepFindings = (findingsByStep.get(step.index) ?? []).slice(0, 2).map((finding) => ({
    severityLabel: finding.severity.toUpperCase(),
    summary: finding.summary,
  }));

  return {
    id: step.id,
    indexLabel,
    actionLine,
    timestampLabel: fmt(step.timestamp),
    ...(step.action.pageUrl ? { pageUrl: step.action.pageUrl } : {}),
    ...(durationLabel ? { durationLabel } : {}),
    hasBug: step.bugs.length > 0,
    noVisibleChange: step.noVisibleChange,
    stepFindings,
    ...(beforeEvidence ? { beforeEvidence } : {}),
    ...(afterEvidence ? { afterEvidence } : {}),
    systemEvidence,
    annotationLegend: legend,
    bugs: bugsView,
    notes: notesView,
    correlated: buildCorrelatedLines(step),
  };
}

interface NumberedNoteEntry {
  note: { id: string; text: string };
  pinAnnotation: StepAnnotation | undefined;
  number?: number;
}
interface NumberedBugEntry {
  bug: { id: string; description: string };
  pinAnnotation: StepAnnotation | undefined;
  number?: number;
}

function pickPinViews(
  notes: readonly NumberedNoteEntry[],
  bugs: readonly NumberedBugEntry[],
  target: 'before' | 'after' | 'system',
): PdfPinView[] {
  const pins: PdfPinView[] = [];
  for (const { note, pinAnnotation, number } of notes) {
    if (!pinAnnotation || number === undefined) continue;
    if (pinAnnotation.target !== target) continue;
    if (pinAnnotation.xPercent === undefined || pinAnnotation.yPercent === undefined) continue;
    pins.push({
      kind: 'note',
      xPercent: pinAnnotation.xPercent,
      yPercent: pinAnnotation.yPercent,
      number,
      ...(note.text ? { note: note.text } : {}),
    });
  }
  for (const { bug, pinAnnotation, number } of bugs) {
    if (!pinAnnotation || number === undefined) continue;
    if (pinAnnotation.target !== target) continue;
    if (pinAnnotation.xPercent === undefined || pinAnnotation.yPercent === undefined) continue;
    pins.push({
      kind: 'bug',
      xPercent: pinAnnotation.xPercent,
      yPercent: pinAnnotation.yPercent,
      number,
      ...(bug.description ? { note: bug.description } : {}),
    });
  }
  return pins;
}

function buildBeforeHighlightRect(step: CanonicalStep): PdfHighlightRectView | undefined {
  const rect = step.action.elementRect;
  if (!rect) return undefined;
  if (rect.viewportWidth <= 0 || rect.viewportHeight <= 0) return undefined;

  const xPercent = clampPercent((rect.x / rect.viewportWidth) * 100);
  const yPercent = clampPercent((rect.y / rect.viewportHeight) * 100);
  const widthPercent = clampPercent((rect.width / rect.viewportWidth) * 100);
  const heightPercent = clampPercent((rect.height / rect.viewportHeight) * 100);

  if (widthPercent <= 0 || heightPercent <= 0) return undefined;
  return { xPercent, yPercent, widthPercent, heightPercent };
}

function buildEvidenceView(
  ref: EvidenceRef | undefined,
  caption: PdfEvidenceView['caption'],
  resolver: EvidenceResolver,
  fmt: (ts: number) => string,
  reportMissing: (delta: number) => void,
  pins: readonly PdfPinView[],
  highlightRect?: PdfHighlightRectView,
): PdfEvidenceView | undefined {
  if (!ref) {
    if (caption === 'BEFORE' || caption === 'AFTER') {
      // Before/after slots are known-empty here — the step never captured one.
      // Return a placeholder view so the layout stays consistent.
      return {
        caption,
        missingReason: 'not-captured',
        pins: [],
      };
    }
    return undefined;
  }

  const dimensionsLabel = typeof ref.width === 'number' && typeof ref.height === 'number'
    ? `${ref.width}×${ref.height}`
    : undefined;
  const capturedAtLabel = fmt(ref.capturedAt);

  if (ref.missing) {
    reportMissing(1);
    return {
      caption,
      missingReason: 'blob-lost',
      pins,
      ...(highlightRect ? { highlightRect } : {}),
      capturedAtLabel,
      ...(dimensionsLabel ? { dimensionsLabel } : {}),
      ...(typeof ref.width === 'number' ? { imageWidthPx: ref.width } : {}),
      ...(typeof ref.height === 'number' ? { imageHeightPx: ref.height } : {}),
    };
  }

  const dataUrl = resolver.resolve(ref.blobKey);
  if (!dataUrl) {
    reportMissing(1);
    return {
      caption,
      missingReason: 'load-failed',
      pins,
      ...(highlightRect ? { highlightRect } : {}),
      capturedAtLabel,
      ...(dimensionsLabel ? { dimensionsLabel } : {}),
      ...(typeof ref.width === 'number' ? { imageWidthPx: ref.width } : {}),
      ...(typeof ref.height === 'number' ? { imageHeightPx: ref.height } : {}),
    };
  }

  return {
    caption,
    dataUrl,
    pins,
    ...(highlightRect ? { highlightRect } : {}),
    ...(typeof ref.width === 'number' ? { imageWidthPx: ref.width } : {}),
    ...(typeof ref.height === 'number' ? { imageHeightPx: ref.height } : {}),
    capturedAtLabel,
    ...(dimensionsLabel ? { dimensionsLabel } : {}),
  };
}
function buildCorrelatedLines(step: CanonicalStep): PdfCorrelatedLine[] {
  const lines: PdfCorrelatedLine[] = [];
  for (const req of step.correlated.failedRequests) {
    lines.push({ severity: 'critical', text: describeFailedRequest(req) });
  }
  for (const req of step.correlated.slowRequests) {
    // Skip if already shown as a failed request.
    if (step.correlated.failedRequests.some((r) => r.requestId === req.requestId)) continue;
    lines.push({ severity: 'warn', text: describeSlowRequest(req) });
  }
  for (const err of step.correlated.consoleErrors) {
    lines.push({ severity: 'critical', text: describeConsoleFinding(err, 'Console error') });
  }
  for (const err of step.correlated.pageErrors) {
    lines.push({ severity: 'critical', text: describeConsoleFinding(err, 'Page error') });
  }
  if (step.correlated.rageClicks > 0) {
    lines.push({
      severity: 'warn',
      text: `${step.correlated.rageClicks} rage click${step.correlated.rageClicks === 1 ? '' : 's'} observed around this step.`,
    });
  }
  if (step.correlated.navigation) {
    lines.push({ severity: 'info', text: describeNavigation(step.correlated.navigation) });
  }
  return lines;
}

function describeFailedRequest(req: NetworkFindingSummary): string {
  const status = typeof req.statusCode === 'number' ? `HTTP ${req.statusCode}` : (req.errorText ?? 'Network error');
  const delta = describeDelta(req.temporalDeltaMs);
  return `${status} — ${req.method} ${req.path} observed ${delta}.`;
}

function describeSlowRequest(req: NetworkFindingSummary): string {
  const duration = typeof req.durationMs === 'number' ? `${Math.round(req.durationMs)} ms` : 'slow';
  const delta = describeDelta(req.temporalDeltaMs);
  return `${req.method} ${req.path} took ${duration} (over SLA) observed ${delta}.`;
}

function describeConsoleFinding(err: ConsoleFindingSummary, prefix: string): string {
  const delta = describeDelta(err.temporalDeltaMs);
  const message = truncate(err.message, 160);
  return `${prefix}: "${message}" observed ${delta}.`;
}

function describeNavigation(nav: NavigationSummary): string {
  const kind = nav.isSpaRouteChange ? 'SPA route change' : 'Page navigation';
  const delta = describeDelta(nav.temporalDeltaMs);
  return `${kind} to ${nav.url} observed ${delta}.`;
}

/** Formats a signed millisecond delta into observational language. */
function describeDelta(delta: number | undefined): string {
  if (typeof delta !== 'number') return 'around the same time';
  const abs = Math.abs(delta);
  const magnitude = abs >= 1000 ? `${(abs / 1000).toFixed(2)}s` : `${Math.round(abs)} ms`;
  if (Math.abs(delta) < 50) return 'around the same time as the action';
  return delta >= 0 ? `approximately ${magnitude} after the action` : `approximately ${magnitude} before the action`;
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}
function sortFindings(findings: readonly ObservedFinding[]): ObservedFinding[] {
  const rank: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const dispositionRank: Record<ObservedFinding['disposition'], number> = {
    'tester-marked': 0,
    'observed-failure': 1,
    'expected-negative': 2,
  };

  return [...findings].sort((a, b) => {
    const rankDiff = rank[a.severity] - rank[b.severity];
    if (rankDiff !== 0) return rankDiff;

    const dispositionDiff = dispositionRank[a.disposition] - dispositionRank[b.disposition];
    if (dispositionDiff !== 0) return dispositionDiff;

    return a.timestamp - b.timestamp;
  });
}

function buildFindingView(
  finding: ObservedFinding,
  allSteps: readonly CanonicalStep[],
  fmt: (ts: number) => string,
): PdfFindingView {
  const severityKey = finding.severity;
  const severityColor = require_severity_color(severityKey);
  const severityLabel = severityKey.toUpperCase();
  const stepReference = typeof finding.stepIndex === 'number'
    ? formatStepReference(finding.stepIndex, allSteps)
    : undefined;
  const temporalNote = typeof finding.temporalDeltaFromClickMs === 'number'
    ? `Observed approximately ${Math.round(finding.temporalDeltaFromClickMs)} ms after a preceding click (observed, not causal).`
    : undefined;

  return {
    id: finding.id,
    severity: severityKey,
    severityColor,
    severityLabel,
    dispositionLabel: mapDispositionLabel(finding.disposition),
    summary: finding.summary,
    timestampLabel: fmt(finding.timestamp),
    ...(stepReference ? { stepReference } : {}),
    ...(finding.detail ? { detail: finding.detail } : {}),
    ...(finding.testerNote ? { testerNote: finding.testerNote } : {}),
    ...(temporalNote ? { temporalNote } : {}),
  };
}

function mapDispositionLabel(disposition: ObservedFinding['disposition']): string {
  switch (disposition) {
    case 'expected-negative':
      return 'EXPECTED (NEGATIVE TEST)';
    case 'tester-marked':
      return 'TESTER MARKED';
    default:
      return 'UNEXPECTED';
  }
}

function require_severity_color(severity: FindingSeverity): string {
  // Kept out of the styles module because findings need color at data-prep time
  // (for legend, for the finding block accent). Duplicating the map here would
  // be a DRY violation — pull from a shared table if it grows.
  const map: Record<FindingSeverity, string> = {
    critical: '#c5221f',
    high: '#e37400',
    medium: '#f4b400',
    low: '#1a73e8',
    info: '#5f6368',
  };
  return map[severity];
}

function formatStepReference(stepIndex: number, allSteps: readonly CanonicalStep[]): string | undefined {
  const step = allSteps.find((s) => s.index === stepIndex);
  if (!step) return `Step ${stepIndex}`;
  return `Step ${stepIndex} — ${truncate(step.action.label, 80)}`;
}
function buildAppendix(model: CanonicalExportModel, fmt: (ts: number) => string): PdfAppendixView {
  const slaMs = Math.max(0, model.environment.apiSlaSec ?? 0) * 1000;

  const network: PdfAppendixNetworkRow[] = model.appendix.network.map((req) => ({
    method: req.method,
    path: req.path || req.url,
    origin: req.origin,
    status: typeof req.statusCode === 'number' ? String(req.statusCode) : req.outcome,
    duration: typeof req.durationMs === 'number' ? `${Math.round(req.durationMs)} ms` : '—',
    isFailed: req.outcome === 'http_error' || req.outcome === 'network_error',
    isSlow: slaMs > 0 && typeof req.durationMs === 'number' && req.durationMs > slaMs,
  }));

  const consoleWarnings: PdfAppendixConsoleRow[] = model.appendix.consoleWarnings.map((warn) => ({
    kind: 'warn',
    message: truncate(warn.message, 200),
    timestampLabel: fmt(warn.timestamp),
  }));

  const navigationHistory: PdfAppendixNavigationRow[] = model.appendix.navigationHistory.map((nav) => ({
    url: nav.url,
    kind: nav.isSpaRouteChange ? 'route' : 'load',
    timestampLabel: fmt(nav.timestamp),
  }));

  const webVitals: PdfKeyValue[] = model.appendix.performance.webVitals.map((v) => ({
    label: `${v.name} (${v.rating})`,
    value: v.name === 'CLS' ? v.value.toFixed(3) : `${Math.round(v.value)} ms`,
  }));

  const checkpoints: PdfKeyValue[] = model.appendix.checkpoints.map((cp) => ({
    label: cp.name,
    value: `${cp.source} · ${fmt(cp.timestamp)}`,
  }));

  const negativeInference = model.appendix.negativeInference;
  const negativeInferenceView: PdfNegativeInferenceView | undefined = negativeInference
    ? {
        confidenceLabel: negativeInference.confidence.replace('-', ' '),
        signals: negativeInference.signals,
        ...(negativeInference.testerVerdict ? { testerVerdict: negativeInference.testerVerdict } : {}),
      }
    : undefined;

  return {
    network,
    consoleWarnings,
    navigationHistory,
    webVitals,
    checkpoints,
    ...(negativeInferenceView ? { negativeInference: negativeInferenceView } : {}),
    captureTimeline: {
      pauses: model.appendix.captureTimeline.pausedAt.length,
      resumes: model.appendix.captureTimeline.resumedAt.length,
    },
  };
}
function buildFooter(model: CanonicalExportModel, fmt: (ts: number) => string): PdfFooterView {
  return {
    leftText: 'BusinessFlow — Local-only QA evidence',
    centerText: `Generated ${fmt(model.meta.generatedAt)} · v${model.meta.generatedBy.version}`,
    rightPrefix: 'Page',
  };
}
function defaultFormatDateTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}

function defaultFormatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainderSeconds}s`;
}
