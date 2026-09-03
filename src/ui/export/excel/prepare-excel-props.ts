import type { CanonicalExportModel } from '../../../export/model/canonical.js';

import type {
  ExcelConsoleRow,
  ExcelEvidenceRow,
  ExcelFindingRow,
  ExcelNetworkRow,
  ExcelPerformanceRow,
  ExcelSessionMetaRow,
  ExcelStepRow,
  ExcelSummaryRow,
  ExcelTechnicalSignalRow,
  ExcelWorkbookViewModel,
} from './excel-view-model.js';
import { isFeatureAggregateModel, selectTestCaseStorySteps } from '../test-case-story.js';

const DISPOSITION_LABEL: Record<string, string> = {
  'observed-failure': 'Observed Failure',
  'expected-negative': 'Expected Negative',
  'tester-marked': 'Tester Marked',
};

export function prepareExcelProps(model: CanonicalExportModel): ExcelWorkbookViewModel {
  const generatedAtLabel = new Date(model.meta.generatedAt).toLocaleString();
  const status = (model.overview.status ?? 'draft').toUpperCase();
  const isFeatureScope = isFeatureAggregateModel(model);
  const stepToCase = new Map<number, string>();
  for (const section of model.sections) {
    const caseName = section.title ?? 'Untitled Test Case';
    for (const step of section.steps) stepToCase.set(step.index, caseName);
  }

  const steps: ExcelStepRow[] = [];
  const evidence: ExcelEvidenceRow[] = [];
  const technicalSignals: ExcelTechnicalSignalRow[] = [];
  const storySteps = isFeatureAggregateModel(model)
    ? model.sections.flatMap((section) => section.steps)
    : selectTestCaseStorySteps(model);

  for (const step of storySteps) {
      const notes = step.testerNotes.map((note) => note.text).join(' | ');

      steps.push({
        ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
        stepNumber: step.index,
        action: step.action.label,
        timestamp: step.timestamp,
        ...(typeof step.durationToNextMs === 'number' ? { durationMs: step.durationToNextMs } : {}),
        ...(step.action.pageUrl ? { url: step.action.pageUrl } : {}),
        status,
        notes,
        bugCount: step.bugs.length,
        failedRequestCount: step.correlated.failedRequests.length,
        consoleErrorCount: step.correlated.consoleErrors.length + step.correlated.pageErrors.length,
      });

      if (step.beforeEvidence) {
        evidence.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          scope: 'step',
          refId: step.id,
          step: step.index,
          kind: 'before',
          mimeType: step.beforeEvidence.mimeType,
          capturedAt: step.beforeEvidence.capturedAt,
          missing: step.beforeEvidence.missing,
        });
      }
      if (step.afterEvidence) {
        evidence.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          scope: 'step',
          refId: step.id,
          step: step.index,
          kind: 'after',
          mimeType: step.afterEvidence.mimeType,
          capturedAt: step.afterEvidence.capturedAt,
          missing: step.afterEvidence.missing,
        });
      }
      for (const item of step.systemEvidence) {
        evidence.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          scope: 'step',
          refId: step.id,
          step: step.index,
          kind: 'system',
          mimeType: item.mimeType,
          capturedAt: item.capturedAt,
          missing: item.missing,
        });
      }

      for (const request of step.correlated.failedRequests.slice(0, 3)) {
        technicalSignals.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          stepNumber: step.index,
          signalType: 'failed-request',
          severity: 'critical',
          detail: `${request.method} ${request.path} -> ${typeof request.statusCode === 'number' ? request.statusCode : request.outcome}`,
          ...(typeof request.startedAt === 'number' ? { timestamp: request.startedAt } : {}),
        });
      }
      for (const request of step.correlated.slowRequests.slice(0, 2)) {
        technicalSignals.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          stepNumber: step.index,
          signalType: 'slow-request',
          severity: 'warn',
          detail: `${request.method} ${request.path} (${Math.round(request.durationMs ?? 0)} ms)`,
          ...(typeof request.startedAt === 'number' ? { timestamp: request.startedAt } : {}),
        });
      }
      for (const signal of step.correlated.consoleErrors.slice(0, 2)) {
        technicalSignals.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          stepNumber: step.index,
          signalType: 'console-error',
          severity: 'critical',
          detail: signal.message,
          ...(typeof signal.timestamp === 'number' ? { timestamp: signal.timestamp } : {}),
        });
      }
      for (const signal of step.correlated.pageErrors.slice(0, 2)) {
        technicalSignals.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          stepNumber: step.index,
          signalType: 'page-error',
          severity: 'critical',
          detail: signal.message,
          ...(typeof signal.timestamp === 'number' ? { timestamp: signal.timestamp } : {}),
        });
      }
      if (step.correlated.navigation) {
        technicalSignals.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          stepNumber: step.index,
          signalType: 'navigation',
          severity: 'info',
          detail: `${step.correlated.navigation.isSpaRouteChange ? 'SPA route' : 'Navigation'} -> ${step.correlated.navigation.url}`,
          timestamp: step.correlated.navigation.timestamp,
        });
      }
      if (step.noVisibleChange) {
        technicalSignals.push({
          ...(isFeatureScope ? { testCase: stepToCase.get(step.index) ?? 'Untitled Test Case' } : {}),
          stepNumber: step.index,
          signalType: 'no-visible-change',
          severity: 'info',
          detail: 'No visible UI state change observed.',
          timestamp: step.timestamp,
        });
      }
    }

  const findings: ExcelFindingRow[] = [...model.findings]
    .sort(compareFindings)
    .map((finding) => ({
    ...(isFeatureScope && typeof finding.stepIndex === 'number' ? { testCase: stepToCase.get(finding.stepIndex) ?? 'Untitled Test Case' } : {}),
    severity: finding.severity.toUpperCase(),
    type: finding.type,
    summary: finding.summary,
    ...(typeof finding.stepIndex === 'number' ? { step: finding.stepIndex } : {}),
    timestamp: finding.timestamp,
    ...(typeof finding.temporalDeltaFromClickMs === 'number'
      ? { temporalRelationship: `${finding.temporalDeltaFromClickMs} ms from correlated click` }
      : {}),
    ...(finding.testerNote ? { testerNote: finding.testerNote } : {}),
    evidenceRef: finding.relatedEvidence.length > 0
      ? `${finding.relatedEvidence.length} attachment${finding.relatedEvidence.length === 1 ? '' : 's'}`
      : '',
    disposition: DISPOSITION_LABEL[finding.disposition] ?? finding.disposition,
  }));

  for (const finding of model.findings) {
    for (const ref of finding.relatedEvidence) {
      evidence.push({
        ...(isFeatureScope && typeof finding.stepIndex === 'number' ? { testCase: stepToCase.get(finding.stepIndex) ?? 'Untitled Test Case' } : {}),
        scope: 'finding',
        refId: finding.id,
        ...(typeof finding.stepIndex === 'number' ? { step: finding.stepIndex } : {}),
        kind: 'finding',
        mimeType: ref.mimeType,
        capturedAt: ref.capturedAt,
        missing: ref.missing,
      });
    }
  }

  const network: ExcelNetworkRow[] = model.appendix.network.map((item) => {
    const failed = item.outcome === 'http_error' || item.outcome === 'network_error';
    const slow = (item.isOverSla ?? false) && !failed;
    const thirdParty = item.isThirdParty ?? false;

    let outcome: ExcelNetworkRow['outcome'] = 'success';
    if (failed) outcome = 'failed';
    else if (slow) outcome = 'slow';
    else if (thirdParty) outcome = 'third-party';

    return {
      requestId: item.requestId,
      method: item.method,
      url: item.url,
      origin: item.origin,
      ...(typeof item.statusCode === 'number' ? { statusCode: item.statusCode } : {}),
      outcome,
      ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
      resourceType: item.resourceType,
      isThirdParty: thirdParty,
    };
  });

  const consoleErrors: ExcelConsoleRow[] = [
    ...model.findings
      .filter((finding) => finding.type === 'CONSOLE_ERROR' || finding.type === 'PAGE_ERROR')
      .map((finding) => ({
        source: finding.type,
        message: finding.summary,
        timestamp: finding.timestamp,
        ...(finding.pageUrl ? { pageUrl: finding.pageUrl } : {}),
      })),
    ...model.appendix.consoleWarnings.map((warning) => ({
      source: warning.kind,
      message: warning.message,
      timestamp: warning.timestamp,
      ...(warning.pageUrl ? { pageUrl: warning.pageUrl } : {}),
    })),
  ];

  const performance: ExcelPerformanceRow[] = [];
  for (const vital of model.appendix.performance.webVitals) {
    performance.push({
      category: 'Web Vitals',
      metric: vital.name,
      value: vital.value,
      unit: vital.name === 'CLS' ? 'score' : 'ms',
      timestamp: vital.timestamp,
    });
  }
  for (const timing of model.appendix.performance.pageTimings) {
    performance.push({ category: 'Page Timing', metric: 'TTFB', value: timing.ttfbMs, unit: 'ms', timestamp: timing.timestamp });
    performance.push({ category: 'Page Timing', metric: 'DOMContentLoaded', value: timing.domContentLoadedMs, unit: 'ms', timestamp: timing.timestamp });
    performance.push({ category: 'Page Timing', metric: 'LoadEvent', value: timing.loadEventMs, unit: 'ms', timestamp: timing.timestamp });
  }
  for (const longTask of model.appendix.performance.longTasks) {
    performance.push({
      category: 'Main Thread',
      metric: 'Long Task',
      value: longTask.durationMs,
      unit: 'ms',
      timestamp: longTask.timestamp,
    });
  }

  const sessionMeta: ExcelSessionMetaRow[] = [
    { category: 'Session', key: isFeatureScope ? 'Feature Export ID' : 'Session ID', value: model.meta.sessionId },
    { category: 'Session', key: 'Generated At', value: generatedAtLabel },
    { category: 'Session', key: 'Correlation Version', value: `v${model.meta.correlationVersion}` },
    { category: 'Session', key: 'Negative Test', value: model.overview.negativeTest },
    { category: 'Environment', key: 'User Agent', value: model.environment.userAgent },
    { category: 'Environment', key: 'Scope Origins', value: model.environment.scopeOrigins.join(', ') || 'n/a' },
  ];

  for (const nav of model.appendix.navigationHistory.slice(0, 200)) {
    sessionMeta.push({
      category: 'Navigation',
      key: new Date(nav.timestamp).toLocaleTimeString(),
      value: nav.url,
    });
  }
  for (const checkpoint of model.appendix.checkpoints.slice(0, 200)) {
    sessionMeta.push({
      category: 'Checkpoint',
      key: checkpoint.name,
      value: new Date(checkpoint.timestamp).toLocaleString(),
    });
  }

  const summaryRows: ExcelSummaryRow[] = [
    { metric: 'Verdict (Workflow Status)', value: status },
    { metric: 'Test Result (Auto)', value: model.overview.testResult.toUpperCase() },
    { metric: 'Feature', value: model.overview.featureName ?? 'n/a' },
    { metric: isFeatureScope ? 'Test Cases' : 'Test Case', value: model.overview.testCaseName ?? 'n/a' },
    { metric: 'Duration', value: model.environment.durationMs ? formatDuration(model.environment.durationMs) : 'n/a' },
    { metric: 'Steps', value: model.stats.steps },
    { metric: 'Bugs', value: model.stats.bugs },
    { metric: 'Findings', value: model.findings.length },
    { metric: 'Failed Requests', value: model.stats.network.failed },
    { metric: 'Slow Requests', value: model.stats.network.slowOverSla },
    { metric: 'Console/Page Errors', value: model.stats.console.errors + model.stats.console.pageErrors },
    { metric: 'LCP', value: model.stats.performance?.lcpMs ?? 'n/a' },
    { metric: 'FCP', value: model.stats.performance?.fcpMs ?? 'n/a' },
    { metric: 'INP', value: model.stats.performance?.inpMs ?? 'n/a' },
    { metric: 'TTFB', value: model.stats.performance?.ttfbMs ?? 'n/a' },
  ];

  const featureCases = isFeatureScope
    ? model.sections.map((section) => ({
      testCase: section.title ?? 'Untitled Test Case',
      result: (section.status ?? section.testResult ?? 'draft').toUpperCase(),
      ...(section.sourceSessionId ? { sessionId: section.sourceSessionId } : {}),
      ...(typeof section.startedAt === 'number' ? { startedAt: section.startedAt } : {}),
      ...(typeof section.durationMs === 'number' ? { durationMs: section.durationMs } : {}),
      stepCount: section.steps.length,
      findingsCount: model.findings.filter((finding) => (
        typeof finding.stepIndex === 'number'
        && section.steps.some((step) => step.index === finding.stepIndex)
      )).length,
    }))
    : undefined;

  return {
    summary: {
      reportTitle: isFeatureScope ? 'QA Feature Analysis Workbook' : 'QA Analysis Workbook',
      generatedAtLabel,
      rows: summaryRows,
    },
    ...(featureCases ? { featureCases } : {}),
    steps,
    findings,
    technicalSignals,
    network,
    consoleErrors,
    evidence,
    performance,
    sessionMeta,
  };
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

function compareFindings(a: CanonicalExportModel['findings'][number], b: CanonicalExportModel['findings'][number]): number {
  const severityRank: Record<CanonicalExportModel['findings'][number]['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  const dispositionRank: Record<CanonicalExportModel['findings'][number]['disposition'], number> = {
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
