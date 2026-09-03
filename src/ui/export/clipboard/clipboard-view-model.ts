import type {
  CanonicalExportModel,
  CanonicalStep,
  NetworkFindingSummary,
  ObservedFinding,
} from '../../../export/model/canonical.js';
import type { FindingSeverity } from '../../../core/types.js';
import { isFeatureAggregateModel } from '../test-case-story.js';

const MAX_STEPS = 12;
const MAX_FINDINGS = 10;
const MAX_EVIDENCE = 8;
const MAX_TECH_LINES = 12;
const MAX_NOTES = 10;

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export interface ClipboardEvidenceViewModel {
  readonly reportTitle: string;
  readonly verdict: string;
  readonly isFeatureScope: boolean;
  readonly isNegativeTest: boolean;
  readonly identityRows: readonly { label: string; value: string }[];
  readonly summaryLine: string;
  readonly contextLine?: string;
  readonly testCaseResults?: readonly { testCase: string; verdict: string; stepCount: number; findingsCount: number }[];
  readonly steps: readonly ClipboardStepRow[];
  readonly findings: readonly ClipboardFindingRow[];
  readonly testerNotes: readonly string[];
  readonly technicalEvidence: readonly string[];
  readonly evidence: readonly ClipboardEvidenceItem[];
}

export interface ClipboardStepRow {
  readonly index: number;
  readonly action: string;
  readonly timestampLabel?: string;
  readonly notes: readonly string[];
}

export interface ClipboardFindingRow {
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly detail?: string;
  readonly stepIndex?: number;
  readonly temporalNote?: string;
}

export interface ClipboardEvidenceItem {
  readonly stepIndex: number;
  readonly label: string;
  readonly blobKey: string;
  readonly mimeType: string;
  readonly missing: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly annotationLines: readonly string[];
}

export function buildClipboardEvidenceView(model: CanonicalExportModel): ClipboardEvidenceViewModel {
  const allSteps = model.sections.flatMap((section) => section.steps);
  const findings = [...model.findings].sort(sortFindings).slice(0, MAX_FINDINGS);
  const isFeatureScope = isFeatureAggregateModel(model);
  const steps = isFeatureScope ? [] : selectStorySteps(allSteps, findings);

  const evidence = collectEvidence(isFeatureScope ? allSteps : steps, findings).slice(0, MAX_EVIDENCE);
  const testerNotes = (isFeatureScope ? allSteps : steps)
    .flatMap((step) => step.testerNotes.map((note) => `Step ${step.index}: ${note.text}`))
    .slice(0, MAX_NOTES);
  const technicalEvidence = collectTechnicalEvidence(isFeatureScope ? allSteps : steps).slice(0, MAX_TECH_LINES);

  const verdict = (model.overview.status ?? model.overview.testResult ?? 'draft').toUpperCase();
  const testCaseResults = isFeatureScope
    ? model.sections.map((section) => ({
      testCase: section.title ?? 'Untitled Test Case',
      verdict: (section.status ?? section.testResult ?? 'draft').toUpperCase(),
      stepCount: section.steps.length,
      findingsCount: model.findings.filter((finding) => (
        typeof finding.stepIndex === 'number'
        && section.steps.some((step) => step.index === finding.stepIndex)
      )).length,
    }))
    : undefined;

  return {
    reportTitle: isFeatureScope
      ? `${model.overview.featureName?.trim() || 'Feature'} — QA Feature Summary`
      : (model.overview.testCaseName?.trim() || 'Untitled Test Case'),
    verdict,
    isFeatureScope,
    isNegativeTest: model.overview.negativeTest === 'yes',
    identityRows: buildIdentityRows(model),
    summaryLine: model.overview.verdictSummary,
    ...(model.overview.testerNotes ? { contextLine: model.overview.testerNotes } : {}),
    ...(testCaseResults ? { testCaseResults } : {}),
    steps: steps.map((step) => ({
      index: step.index,
      action: step.action.label,
      timestampLabel: new Date(step.timestamp).toLocaleString(),
      notes: step.testerNotes.map((note) => note.text),
    })),

    findings: findings.map((finding) => ({
      severity: finding.severity,
      summary: finding.summary,
      ...(finding.detail ? { detail: finding.detail } : {}),
      ...(typeof finding.stepIndex === 'number' ? { stepIndex: finding.stepIndex } : {}),
      ...(typeof finding.temporalDeltaFromClickMs === 'number'
        ? { temporalNote: `Observed about ${Math.abs(finding.temporalDeltaFromClickMs)} ms after the action.` }
        : {}),
    })),
    testerNotes,
    technicalEvidence,
    evidence,
  };

  function selectStorySteps(
    orderedSteps: readonly CanonicalStep[],
    topFindings: readonly ObservedFinding[],
  ): readonly CanonicalStep[] {
    const findingStepIndexes = new Set(topFindings.map((finding) => finding.stepIndex).filter((index): index is number => typeof index === 'number'));

    const interesting = orderedSteps.filter((step) => (
      step.bugs.length > 0
      || step.testerNotes.length > 0
      || step.correlated.failedRequests.length > 0
      || step.correlated.consoleErrors.length > 0
      || step.correlated.pageErrors.length > 0
      || findingStepIndexes.has(step.index)
    ));

    const verdict = model.overview.status ?? model.overview.testResult;
    if (verdict === 'fail' || verdict === 'blocked') {
      if (orderedSteps.length <= MAX_STEPS) return orderedSteps;

      const lastInterestingStep = [...orderedSteps]
        .reverse()
        .find((step) => (
          step.bugs.length > 0
          || step.testerNotes.length > 0
          || step.correlated.failedRequests.length > 0
          || step.correlated.consoleErrors.length > 0
          || step.correlated.pageErrors.length > 0
          || findingStepIndexes.has(step.index)
        ));

      const anchorIndex = lastInterestingStep
        ? Math.max(0, orderedSteps.findIndex((step) => step.id === lastInterestingStep.id))
        : orderedSteps.length - 1;

      const CONTEXT_BEFORE = Math.floor(MAX_STEPS / 2);
      let start = Math.max(0, anchorIndex - CONTEXT_BEFORE);
      const end = Math.min(orderedSteps.length, start + MAX_STEPS);
      if ((end - start) < MAX_STEPS) {
        start = Math.max(0, end - MAX_STEPS);
      }
      return orderedSteps.slice(start, end);
    }

    if (interesting.length > 0) return interesting.slice(0, MAX_STEPS);
    return orderedSteps.slice(0, MAX_STEPS);
  }

  function collectEvidence(
    storySteps: readonly CanonicalStep[],
    topFindings: readonly ObservedFinding[],
  ): ClipboardEvidenceItem[] {
    const out: ClipboardEvidenceItem[] = [];

    for (const step of storySteps) {
      const byTarget = (target: 'before' | 'after' | 'system'): readonly string[] => step.annotations
        .filter((annotation) => annotation.kind === 'pin' && annotation.target === target)
        .map((annotation) => annotation.note || annotation.label || annotation.sourceKind);

      if (step.beforeEvidence) {
        const hasAfter = Boolean(step.afterEvidence);
        out.push({
          stepIndex: step.index,
          label: hasAfter ? `Step ${step.index} — BEFORE` : `Step ${step.index}`,
          blobKey: step.beforeEvidence.blobKey,
          mimeType: step.beforeEvidence.mimeType,
          missing: step.beforeEvidence.missing,
          ...(typeof step.beforeEvidence.width === 'number' ? { width: step.beforeEvidence.width } : {}),
          ...(typeof step.beforeEvidence.height === 'number' ? { height: step.beforeEvidence.height } : {}),
          annotationLines: byTarget('before'),
        });
      }
      if (step.afterEvidence) {
        out.push({
          stepIndex: step.index,
          label: `Step ${step.index} — AFTER`,
          blobKey: step.afterEvidence.blobKey,
          mimeType: step.afterEvidence.mimeType,
          missing: step.afterEvidence.missing,
          ...(typeof step.afterEvidence.width === 'number' ? { width: step.afterEvidence.width } : {}),
          ...(typeof step.afterEvidence.height === 'number' ? { height: step.afterEvidence.height } : {}),
          annotationLines: byTarget('after'),
        });
      }
      for (const evidenceRef of step.systemEvidence) {
        out.push({
          stepIndex: step.index,
          label: `Step ${step.index} — SYSTEM CAPTURE`,
          blobKey: evidenceRef.blobKey,
          mimeType: evidenceRef.mimeType,
          missing: evidenceRef.missing,
          ...(typeof evidenceRef.width === 'number' ? { width: evidenceRef.width } : {}),
          ...(typeof evidenceRef.height === 'number' ? { height: evidenceRef.height } : {}),
          annotationLines: byTarget('system'),
        });
      }
    }

    for (const finding of topFindings) {
      for (const evidenceRef of finding.relatedEvidence) {
        if (out.some((item) => item.blobKey === evidenceRef.blobKey)) continue;
        out.push({
          stepIndex: finding.stepIndex ?? 0,
          label: typeof finding.stepIndex === 'number'
            ? `Finding evidence — Step ${finding.stepIndex}`
            : 'Finding evidence',
          blobKey: evidenceRef.blobKey,
          mimeType: evidenceRef.mimeType,
          missing: evidenceRef.missing,
          ...(typeof evidenceRef.width === 'number' ? { width: evidenceRef.width } : {}),
          ...(typeof evidenceRef.height === 'number' ? { height: evidenceRef.height } : {}),
          annotationLines: [],
        });
      }
    }

    return out;
  }

  function collectTechnicalEvidence(storySteps: readonly CanonicalStep[]): string[] {
    const lines: string[] = [];

    for (const step of storySteps) {
      for (const request of step.correlated.failedRequests.slice(0, 2)) {
        lines.push(formatRequestLine(step.index, request));
      }
      for (const request of step.correlated.slowRequests.slice(0, 1)) {
        const duration = typeof request.durationMs === 'number' ? `${Math.round(request.durationMs)} ms` : 'slow';
        lines.push(`Step ${step.index}: Slow request observed (${duration}) ${request.method} ${request.path}`);
      }
      for (const error of step.correlated.consoleErrors.slice(0, 1)) {
        lines.push(`Step ${step.index}: Console error observed — ${error.message}`);
      }
      for (const error of step.correlated.pageErrors.slice(0, 1)) {
        lines.push(`Step ${step.index}: Page error observed — ${error.message}`);
      }
    }

    return dedupe(lines);
  }
}

function sortFindings(a: ObservedFinding, b: ObservedFinding): number {
  const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severityDelta !== 0) return severityDelta;
  return a.timestamp - b.timestamp;
}

function formatRequestLine(stepIndex: number, request: NetworkFindingSummary): string {
  const status = typeof request.statusCode === 'number' ? `HTTP ${request.statusCode}` : request.outcome;
  const temporal = typeof request.temporalDeltaMs === 'number'
    ? ` about ${Math.abs(Math.round(request.temporalDeltaMs))} ms after the action`
    : '';
  return `Step ${stepIndex}: ${request.method} ${request.path} returned ${status}${temporal}.`;
}

function buildIdentityRows(model: CanonicalExportModel): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (model.overview.featureName) rows.push({ label: 'Feature', value: model.overview.featureName });
  if (model.overview.testCaseName) rows.push({ label: 'Test case', value: model.overview.testCaseName });
  if (model.overview.testCaseId) rows.push({ label: 'Test case ID', value: model.overview.testCaseId });
  if (model.overview.testType) rows.push({ label: 'Test type', value: model.overview.testType });
  rows.push({ label: 'Session', value: model.meta.sessionId });
  rows.push({ label: 'Started', value: new Date(model.environment.startedAt).toLocaleString() });
  if (typeof model.environment.endedAt === 'number') rows.push({ label: 'Ended', value: new Date(model.environment.endedAt).toLocaleString() });
  if (typeof model.environment.durationMs === 'number') rows.push({ label: 'Duration', value: `${Math.round(model.environment.durationMs / 1000)}s` });
  if (model.environment.platform) rows.push({ label: 'Platform', value: model.environment.platform });
  if (model.environment.chromeVersion) rows.push({ label: 'Chrome', value: model.environment.chromeVersion });
  if (model.environment.extVersion) rows.push({ label: 'BusinessFlow', value: model.environment.extVersion });
  return rows;
}

function dedupe(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
