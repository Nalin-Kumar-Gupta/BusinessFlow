import type {
  CanonicalExportModel,
  CanonicalStep,
  ObservedFinding,
} from '../../../export/model/canonical.js';
import type { FindingDisposition } from '../../../core/types.js';
import { isFeatureAggregateModel, mapFindingsByStep, selectTestCaseStorySteps } from '../test-case-story.js';
import type {
  WordAppendixRow,
  WordEvidenceResolver,
  WordExportViewModel,
  WordFindingView,
  WordKeyValue,
  WordNegativeAssertionView,
  WordRequestSignalView,
  WordStatView,
  WordStepImageView,
  WordStepTechnicalSignalView,
  WordStepView,
} from './word-view-model.js';

const DISPOSITION_LABEL: Record<FindingDisposition, string> = {
  'observed-failure': 'Observed failure',
  'expected-negative': 'Expected negative outcome',
  'tester-marked': 'Tester marked',
};

const OUTCOME_LABEL: Record<string, string> = {
  success: 'Success',
  http_error: 'HTTP error',
  network_error: 'Network error',
  pending: 'Pending',
};

export function prepareWordProps(
  model: CanonicalExportModel,
  resolver: WordEvidenceResolver,
): WordExportViewModel {
  const generatedAt = formatDateTime(model.meta.generatedAt);
  const status = model.overview.status ?? 'draft';
  const testResult = model.overview.testResult;
  const isFeatureScope = isFeatureAggregateModel(model);
  const findingsByStep = mapFindingsByStep(model.findings);

  const stepsForStory = isFeatureScope
    ? []
    : selectTestCaseStorySteps(model);

  const executionStory = stepsForStory.map((step) =>
    mapStep(step, resolver, findingsByStep),
  );

  const testCaseSections = isFeatureScope
    ? model.sections.map((section) => ({
      title: section.title ?? 'Untitled Test Case',
      verdict: (section.status ?? section.testResult ?? 'draft').toUpperCase(),
      ...(section.sourceSessionId ? { sessionId: section.sourceSessionId } : {}),
      ...(typeof section.startedAt === 'number' ? { startedAtLabel: formatDateTime(section.startedAt) } : {}),
      ...(typeof section.durationMs === 'number' ? { durationLabel: formatDuration(section.durationMs) } : {}),
      steps: section.steps.map((step) => mapStep(step, resolver, findingsByStep)),
    }))
    : undefined;

  const findings = [...model.findings]
    .sort(compareFindings)
    .map((finding) => mapFinding(finding));

  const failedOrSlowRequests = model.appendix.network
    .filter((item) => item.outcome !== 'success' || (item.isOverSla ?? false))
    .slice(0, 20)
    .map<WordRequestSignalView>((item) => ({
      request: `${item.method} ${shortenUrl(item.url, 96)}`,
      outcome: OUTCOME_LABEL[item.outcome] ?? item.outcome,
      ...(typeof item.durationMs === 'number' ? { duration: `${Math.round(item.durationMs)} ms` } : {}),
    }));

  const errorSignals = [
    ...model.appendix.consoleWarnings,
    ...model.findings
      .filter((finding) => finding.type === 'CONSOLE_ERROR' || finding.type === 'PAGE_ERROR')
      .map((finding) => ({
        kind: 'derived-finding' as const,
        message: finding.summary,
      })),
  ]
    .slice(0, 20)
    .map((signal) => ({
      source: signal.kind === 'derived-finding' ? 'Finding' : signal.kind,
      message: shortenText(signal.message, 180),
    }));

  const appendix: WordAppendixRow[] = [
    { label: isFeatureScope ? 'Feature Export ID' : 'Session ID', value: model.meta.sessionId },
    { label: 'Correlation Version', value: `v${model.meta.correlationVersion}` },
    { label: 'Schema Version', value: `v${model.schemaVersion}` },
    { label: 'Capture Pauses', value: String(model.appendix.captureTimeline.pausedAt.length) },
    { label: 'Capture Resumes', value: String(model.appendix.captureTimeline.resumedAt.length) },
    { label: 'Navigation Events', value: String(model.appendix.navigationHistory.length) },
    { label: 'Checkpoints', value: String(model.appendix.checkpoints.length) },
    { label: 'DOM Metric Samples', value: String(model.appendix.domMetrics.length) },
    { label: 'CSP Violations', value: String(model.appendix.cspViolations.length) },
  ];

  const missingScreenshotCount = executionStory.reduce(
    (sum, step) => sum + (step.before.missing ? 1 : 0) + (step.after?.missing ? 1 : 0),
    0,
  );

  return {
    cover: {
      reportTitle: isFeatureScope ? 'QA Feature Report' : 'QA Test Report',
      generatedAtLabel: generatedAt,
      verdictLabel: status.toUpperCase(),
      verdictSummary: model.overview.verdictSummary,
    },
    testIdentity: buildIdentity(model),
    verdict: {
      statusLabel: status.toUpperCase(),
      testResultLabel: testResult.toUpperCase(),
      negativeTestLabel: model.overview.negativeTest === 'yes' ? 'Yes' : model.overview.negativeTest === 'no' ? 'No' : 'Unknown',
      ...(model.overview.testerNotes ? { notes: model.overview.testerNotes } : {}),
      negativeAssertions: (model.overview.negativeAssertions ?? []).map<WordNegativeAssertionView>((assertion) => ({
        channel: assertion.channel.toUpperCase(),
        expected: assertion.expected,
        observed: assertion.observed,
        verdict: assertion.verdict.toUpperCase(),
      })),
    },
    environment: buildEnvironment(model),
    executionSummary: {
      stats: buildExecutionStats(model),
    },
    ...(isFeatureScope
      ? {
          featureSummary: {
            totalTestCases: model.sections.length,
            rows: model.sections.map((section) => ({
              testCase: section.title ?? 'Untitled Test Case',
              verdict: (section.status ?? section.testResult ?? 'draft').toUpperCase(),
              stepCount: section.steps.length,
              findingsCount: model.findings.filter((finding) => (
                typeof finding.stepIndex === 'number'
                && section.steps.some((step) => step.index === finding.stepIndex)
              )).length,
            })),
          },
        }
      : {}),
    executionStory,
    ...(testCaseSections ? { testCaseSections } : {}),
    findings,
    technicalEvidence: {
      failedOrSlowRequests,
      errorSignals,
    },
    appendix,
    missingScreenshotCount,
  };
}

function buildIdentity(model: CanonicalExportModel): WordKeyValue[] {
  const rows: WordKeyValue[] = [];
  const isFeatureScope = isFeatureAggregateModel(model);
  if (model.overview.featureName) rows.push({ key: 'Feature', value: model.overview.featureName });
  if (!isFeatureScope && model.overview.testCaseName) rows.push({ key: 'Test Case', value: model.overview.testCaseName });
  if (isFeatureScope && model.overview.testCaseName) rows.push({ key: 'Test Cases', value: model.overview.testCaseName });
  if (!isFeatureScope && model.overview.testCaseId) rows.push({ key: 'Test Case ID', value: model.overview.testCaseId });
  if (!isFeatureScope && model.overview.testType) rows.push({ key: 'Test Type', value: model.overview.testType });
  rows.push({ key: 'Generated', value: formatDateTime(model.meta.generatedAt) });
  return rows;
}

function buildEnvironment(model: CanonicalExportModel): WordKeyValue[] {
  const env = model.environment;
  const rows: WordKeyValue[] = [
    { key: 'Started', value: formatDateTime(env.startedAt) },
    { key: 'User Agent', value: env.userAgent },
    { key: 'Scope Origins', value: env.scopeOrigins.join(', ') || 'n/a' },
  ];
  if (typeof env.endedAt === 'number') rows.push({ key: 'Ended', value: formatDateTime(env.endedAt) });
  if (typeof env.durationMs === 'number') rows.push({ key: 'Duration', value: formatDuration(env.durationMs) });
  if (env.chromeVersion) rows.push({ key: 'Chrome', value: env.chromeVersion });
  if (env.platform) rows.push({ key: 'Platform', value: env.platform });
  if (env.extVersion) rows.push({ key: 'Extension Version', value: env.extVersion });
  if (env.timeZone) rows.push({ key: 'Time Zone', value: env.timeZone });
  if (env.viewport) rows.push({ key: 'Viewport', value: `${env.viewport.width}x${env.viewport.height} @${env.viewport.dpr}x` });
  if (typeof env.apiSlaSec === 'number') rows.push({ key: 'API SLA', value: `${env.apiSlaSec}s` });
  return rows;
}

function buildExecutionStats(model: CanonicalExportModel): WordStatView[] {
  const s = model.stats;
  return [
    { label: 'Steps', value: String(s.steps) },
    { label: 'Bugs', value: String(s.bugs) },
    { label: 'Findings (Critical/High)', value: String((s.findings.critical ?? 0) + (s.findings.high ?? 0)) },
    { label: 'Failed Requests', value: String(s.network.failed) },
    { label: 'Slow Requests', value: String(s.network.slowOverSla) },
    { label: 'Console Errors', value: String(s.console.errors) },
    { label: 'No Visible Change Steps', value: String(s.stepsNoStateChange) },
  ];
}

function mapStep(
  step: CanonicalStep,
  resolver: WordEvidenceResolver,
  findingsByStep: ReadonlyMap<number, readonly ObservedFinding[]>,
): WordStepView {
  const notes = step.testerNotes.map((note) => note.text);
  const bugs = step.bugs.map((bug) => bug.description);

  const technicalSignals: WordStepTechnicalSignalView[] = [];
  if (step.correlated.failedRequests.length > 0) {
    technicalSignals.push({
      label: 'Failed Requests',
      details: step.correlated.failedRequests.slice(0, 4).map((request) => {
        const status = typeof request.statusCode === 'number' ? request.statusCode : request.outcome;
        return `${request.method} ${shortenUrl(request.url, 80)} [${status}]`;
      }),
    });
  }
  if (step.correlated.slowRequests.length > 0) {
    technicalSignals.push({
      label: 'Slow Requests',
      details: step.correlated.slowRequests.slice(0, 4).map((request) =>
        `${request.method} ${shortenUrl(request.url, 80)} (${Math.round(request.durationMs ?? 0)} ms)`),
    });
  }
  if (step.correlated.consoleErrors.length > 0 || step.correlated.pageErrors.length > 0) {
    technicalSignals.push({
      label: 'Error Signals',
      details: [...step.correlated.consoleErrors, ...step.correlated.pageErrors]
        .slice(0, 4)
        .map((signal) => shortenText(signal.message, 100)),
    });
  }
  if (step.noVisibleChange) {
    technicalSignals.push({
      label: 'State Change',
      details: ['No visible state change detected during stabilization window.'],
    });
  }

  const afterImage = step.afterEvidence
    ? mapStepImage('After', step.afterEvidence, step.annotations, resolver)
    : undefined;

  return {
    stepNumber: step.index,
    action: step.action.label,
    ...(step.action.pageUrl ? { pageUrl: step.action.pageUrl } : {}),
    timestampLabel: formatDateTime(step.timestamp),
    ...(typeof step.durationToNextMs === 'number' ? { durationLabel: formatDuration(step.durationToNextMs) } : {}),
    before: mapStepImage('Before', step.beforeEvidence, step.annotations, resolver),
    ...(afterImage ? { after: afterImage } : {}),
    testerNotes: notes,
    testerBugs: bugs,
    linkedFindings: (findingsByStep.get(step.index) ?? []).slice(0, 3).map((finding) => `${finding.severity.toUpperCase()} — ${finding.summary}`),
    technicalSignals,
  };
}

function mapStepImage(
  label: string,
  evidence: CanonicalStep['beforeEvidence'] | undefined,
  annotations: CanonicalStep['annotations'],
  resolver: WordEvidenceResolver,
): WordStepImageView {
  const matchingAnnotations = annotations
    .filter((annotation) => annotation.kind === 'pin' && annotation.target.toLowerCase() === label.toLowerCase())
    .slice(0, 5)
    .map((annotation) => {
      const x = Math.round(annotation.xPercent ?? 0);
      const y = Math.round(annotation.yPercent ?? 0);
      const note = annotation.note ? `: ${shortenText(annotation.note, 70)}` : '';
      return `${annotation.sourceKind} pin @ (${x}%, ${y}%)${note}`;
    });

  if (!evidence) {
    return { label, missing: true, annotations: matchingAnnotations };
  }

  return {
    label,
    dataUrl: resolver.resolve(evidence.blobKey),
    missing: evidence.missing,
    ...(typeof evidence.width === 'number' ? { widthPx: evidence.width } : {}),
    ...(typeof evidence.height === 'number' ? { heightPx: evidence.height } : {}),
    annotations: matchingAnnotations,
  };
}

function mapFinding(finding: ObservedFinding): WordFindingView {
  return {
    severity: finding.severity.toUpperCase(),
    summary: finding.summary,
    ...(finding.detail ? { detail: finding.detail } : {}),
    disposition: DISPOSITION_LABEL[finding.disposition],
    ...(typeof finding.stepIndex === 'number' ? { stepReference: `Step ${finding.stepIndex}` } : {}),
    timestampLabel: formatDateTime(finding.timestamp),
  };
}

function compareFindings(a: ObservedFinding, b: ObservedFinding): number {
  const severityRank: Record<ObservedFinding['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  const dispositionRank: Record<ObservedFinding['disposition'], number> = {
    'tester-marked': 0,
    'observed-failure': 1,
    'expected-negative': 2,
  };

  const severityDelta = severityRank[a.severity] - severityRank[b.severity];
  if (severityDelta !== 0) return severityDelta;

  const dispositionDelta = dispositionRank[a.disposition] - dispositionRank[b.disposition];
  if (dispositionDelta !== 0) return dispositionDelta;

  return a.timestamp - b.timestamp;
}

function shortenUrl(url: string, limit: number): string {
  if (url.length <= limit) return url;
  return `${url.slice(0, Math.max(0, limit - 1))}…`;
}

function shortenText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
