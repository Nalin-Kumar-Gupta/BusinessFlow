import type {
  CanonicalExportModel,
  EvidenceRef,
  NetworkFindingSummary,
  ObservedFinding,
} from '../../export/model/canonical.js';
import { buildCanonicalExportModel } from '../../export/model/build-projection.js';
import type { FindingSeverity, SessionStatus, SessionTestType, TestResult } from '../../core/types.js';
import type { SessionExportBundle } from '../../storage/db.js';

import { buildFeatureCanonicalModel } from './feature-model.js';

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const ZERO_SEVERITY: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
};

const ZERO_STATUS_COUNTS: Readonly<Record<SessionStatus | 'unknown', number>> = {
  draft: 0,
  pass: 0,
  fail: 0,
  blocked: 0,
  unknown: 0,
};

const ZERO_RESULT_COUNTS: Readonly<Record<TestResult, number>> = {
  pass: 0,
  fail: 0,
  partial: 0,
  blocked: 0,
  in_progress: 0,
};

export interface ExportEvidenceItem {
  readonly blobKey: string;
  readonly mimeType: string;
  readonly missing: boolean;
  readonly capturedAt: number;
  readonly sourceSessionId: string;
  readonly sourceTestCaseName: string;
  readonly reason:
    | 'finding-support'
    | 'failed-blocked-run'
    | 'before-after-story'
    | 'relevant-system-evidence'
    | 'representative-success';
  readonly stepIndex?: number;
}

export interface TestCaseExportModel {
  readonly scope: 'test-case';
  readonly canonical: CanonicalExportModel;
  readonly identity: {
    readonly featureName?: string;
    readonly testCaseName?: string;
    readonly testCaseId?: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly durationMs?: number;
    readonly testType?: SessionTestType;
    readonly negativeTest: 'yes' | 'no' | 'unknown';
  };
  readonly verdict: {
    readonly status?: SessionStatus;
    readonly testResult: TestResult;
    readonly summary: string;
  };
  readonly summary: {
    readonly steps: number;
    readonly findings: number;
    readonly evidence: number;
    readonly missingEvidence: number;
    readonly failedRequests: number;
    readonly slowRequests: number;
    readonly consoleErrors: number;
    readonly pageErrors: number;
  };
  readonly selectedEvidence: readonly ExportEvidenceItem[];
}

export interface FeatureCaseSummary {
  readonly testCaseName: string;
  readonly testCaseId?: string;
  readonly latestSessionId: string;
  readonly latestStartedAt: number;
  readonly latestStatus?: SessionStatus;
  readonly latestResult: TestResult;
  readonly latestDurationMs?: number;
  readonly latestFindings: number;
  readonly runCount: number;
  readonly findingsAcrossRuns: number;
  readonly severityAcrossRuns: Readonly<Record<FindingSeverity, number>>;
  readonly latestNegativeTest: 'yes' | 'no' | 'unknown';
}

export interface FeatureAggregatedFinding {
  readonly key: string;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly detail?: string;
  readonly type: ObservedFinding['type'];
  readonly disposition: ObservedFinding['disposition'];
  readonly status: ObservedFinding['status'];
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly occurrences: number;
  readonly affectedTestCases: readonly string[];
  readonly affectedSessionIds: readonly string[];
  readonly evidence: readonly ExportEvidenceItem[];
  readonly correlationClaim: 'observed_around_same_time';
}

export interface FeatureExportModel {
  readonly scope: 'feature';
  readonly renderModel: CanonicalExportModel;
  readonly featureName: string;
  readonly exportedAt: number;
  readonly runCount: number;
  readonly testCaseCount: number;
  readonly statusCounts: Readonly<Record<SessionStatus | 'unknown', number>>;
  readonly resultCounts: Readonly<Record<TestResult, number>>;
  readonly severityTotals: Readonly<Record<FindingSeverity, number>>;
  readonly testCases: readonly FeatureCaseSummary[];
  readonly aggregatedFindings: readonly FeatureAggregatedFinding[];
  readonly selectedEvidence: readonly ExportEvidenceItem[];
  readonly technicalSummary: {
    readonly failedRequests: number;
    readonly slowRequests: number;
    readonly consoleErrors: number;
    readonly pageErrors: number;
    readonly blockedOrFailedRuns: number;
  };
}

interface FeatureScopeBuildInput {
  readonly bundles: readonly SessionExportBundle[];
  readonly featureName: string;
  readonly nowMs?: number;
}

interface RunModel {
  readonly canonical: CanonicalExportModel;
  readonly sessionId: string;
  readonly testCaseName: string;
}

export function buildTestCaseExportModel(bundle: SessionExportBundle): TestCaseExportModel {
  const canonical = buildCanonicalFromBundle(bundle);
  const selectedEvidence = selectTestCaseEvidence(canonical);

  return {
    scope: 'test-case',
    canonical,
    identity: {
      ...(canonical.overview.featureName ? { featureName: canonical.overview.featureName } : {}),
      ...(canonical.overview.testCaseName ? { testCaseName: canonical.overview.testCaseName } : {}),
      ...(canonical.overview.testCaseId ? { testCaseId: canonical.overview.testCaseId } : {}),
      sessionId: canonical.meta.sessionId,
      startedAt: canonical.environment.startedAt,
      ...(typeof canonical.environment.endedAt === 'number' ? { endedAt: canonical.environment.endedAt } : {}),
      ...(typeof canonical.environment.durationMs === 'number' ? { durationMs: canonical.environment.durationMs } : {}),
      ...(canonical.overview.testType ? { testType: canonical.overview.testType } : {}),
      negativeTest: canonical.overview.negativeTest,
    },
    verdict: {
      ...(canonical.overview.status ? { status: canonical.overview.status } : {}),
      testResult: canonical.overview.testResult,
      summary: canonical.overview.verdictSummary,
    },
    summary: {
      steps: canonical.stats.steps,
      findings: canonical.findings.length,
      evidence: selectedEvidence.length,
      missingEvidence: selectedEvidence.filter((item) => item.missing).length,
      failedRequests: canonical.appendix.network.filter((item) => item.outcome !== 'success').length,
      slowRequests: canonical.appendix.network.filter((item) => item.isOverSla).length,
      consoleErrors: canonical.appendix.consoleWarnings.filter((item) => item.kind === 'console_error').length,
      pageErrors: canonical.appendix.consoleWarnings.filter((item) => item.kind === 'page_error').length,
    },
    selectedEvidence,
  };
}

export function buildFeatureExportModel(input: FeatureScopeBuildInput): FeatureExportModel {
  if (input.bundles.length === 0) {
    throw new Error('Feature export failed: no runs were available for export.');
  }

  const runModels = input.bundles.map((bundle) => {
    const canonical = buildCanonicalFromBundle(bundle);
    const testCaseName = canonical.overview.testCaseName?.trim() || 'Untitled Test Case';
    return {
      canonical,
      sessionId: canonical.meta.sessionId,
      testCaseName,
    } satisfies RunModel;
  });

  const renderModel = buildFeatureCanonicalModel(
    runModels.map((item) => item.canonical),
    input.featureName,
  );

  const statusCounts = { ...ZERO_STATUS_COUNTS };
  const resultCounts = { ...ZERO_RESULT_COUNTS };
  const severityTotals = { ...ZERO_SEVERITY };

  for (const run of runModels) {
    const status = run.canonical.overview.status ?? 'unknown';
    statusCounts[status] += 1;
    resultCounts[run.canonical.overview.testResult] += 1;
    addSeverityTotals(severityTotals, run.canonical.stats.findings);
  }

  const testCases = buildFeatureCaseSummaries(runModels);
  const aggregatedFindings = aggregateFindings(runModels);
  const selectedEvidence = selectFeatureEvidence(runModels, aggregatedFindings);

  return {
    scope: 'feature',
    renderModel,
    featureName: input.featureName,
    exportedAt: input.nowMs ?? Date.now(),
    runCount: runModels.length,
    testCaseCount: testCases.length,
    statusCounts,
    resultCounts,
    severityTotals,
    testCases,
    aggregatedFindings,
    selectedEvidence,
    technicalSummary: {
      failedRequests: runModels.reduce((sum, run) => sum + run.canonical.appendix.network.filter((req) => req.outcome !== 'success').length, 0),
      slowRequests: runModels.reduce((sum, run) => sum + run.canonical.appendix.network.filter((req) => req.isOverSla).length, 0),
      consoleErrors: runModels.reduce((sum, run) => sum + run.canonical.appendix.consoleWarnings.filter((w) => w.kind === 'console_error').length, 0),
      pageErrors: runModels.reduce((sum, run) => sum + run.canonical.appendix.consoleWarnings.filter((w) => w.kind === 'page_error').length, 0),
      blockedOrFailedRuns: runModels.filter((run) => run.canonical.overview.testResult === 'fail' || run.canonical.overview.testResult === 'blocked').length,
    },
  };
}

function buildCanonicalFromBundle(bundle: SessionExportBundle): CanonicalExportModel {
  return buildCanonicalExportModel({
    session: bundle.session,
    events: bundle.events,
    steps: bundle.steps,
    networkLogs: bundle.networkLogs,
    knownBlobKeys: new Set(bundle.blobs.map((blob) => blob.key)),
  });
}

function buildFeatureCaseSummaries(runModels: readonly RunModel[]): FeatureCaseSummary[] {
  const grouped = new Map<string, RunModel[]>();

  for (const run of runModels) {
    const key = run.testCaseName;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(run);
    else grouped.set(key, [run]);
  }

  const summaries: FeatureCaseSummary[] = [];
  for (const [testCaseName, runs] of grouped.entries()) {
    const sortedByNewest = [...runs].sort((a, b) => b.canonical.environment.startedAt - a.canonical.environment.startedAt);
    const latest = sortedByNewest[0]!;
    const severityAcrossRuns = { ...ZERO_SEVERITY };

    for (const run of runs) {
      addSeverityTotals(severityAcrossRuns, run.canonical.stats.findings);
    }

    summaries.push({
      testCaseName,
      ...(latest.canonical.overview.testCaseId ? { testCaseId: latest.canonical.overview.testCaseId } : {}),
      latestSessionId: latest.sessionId,
      latestStartedAt: latest.canonical.environment.startedAt,
      ...(latest.canonical.overview.status ? { latestStatus: latest.canonical.overview.status } : {}),
      latestResult: latest.canonical.overview.testResult,
      ...(typeof latest.canonical.environment.durationMs === 'number' ? { latestDurationMs: latest.canonical.environment.durationMs } : {}),
      latestFindings: latest.canonical.findings.length,
      runCount: runs.length,
      findingsAcrossRuns: runs.reduce((sum, run) => sum + run.canonical.findings.length, 0),
      severityAcrossRuns,
      latestNegativeTest: latest.canonical.overview.negativeTest,
    });
  }

  return summaries.sort((a, b) => a.testCaseName.localeCompare(b.testCaseName));
}

function aggregateFindings(runModels: readonly RunModel[]): FeatureAggregatedFinding[] {
  interface MutableAggregate {
    readonly key: string;
    severity: FindingSeverity;
    readonly summary: string;
    readonly detail?: string;
    readonly type: ObservedFinding['type'];
    readonly disposition: ObservedFinding['disposition'];
    readonly status: ObservedFinding['status'];
    firstSeenAt: number;
    lastSeenAt: number;
    occurrences: number;
    affectedTestCases: Set<string>;
    affectedSessionIds: Set<string>;
    evidence: Map<string, ExportEvidenceItem>;
  }

  const byKey = new Map<string, MutableAggregate>();

  for (const run of runModels) {
    for (const finding of run.canonical.findings) {
      const key = `${finding.type}|${finding.disposition}|${finding.summary}|${finding.detail ?? ''}`;
      let aggregate = byKey.get(key);
      if (!aggregate) {
        aggregate = {
          key,
          severity: finding.severity,
          summary: finding.summary,
          ...(finding.detail ? { detail: finding.detail } : {}),
          type: finding.type,
          disposition: finding.disposition,
          status: finding.status,
          firstSeenAt: finding.timestamp,
          lastSeenAt: finding.timestamp,
          occurrences: 0,
          affectedTestCases: new Set<string>(),
          affectedSessionIds: new Set<string>(),
          evidence: new Map<string, ExportEvidenceItem>(),
        };
        byKey.set(key, aggregate);
      }

      aggregate.firstSeenAt = Math.min(aggregate.firstSeenAt, finding.timestamp);
      aggregate.lastSeenAt = Math.max(aggregate.lastSeenAt, finding.timestamp);
      aggregate.occurrences += 1;
      aggregate.affectedTestCases.add(run.testCaseName);
      aggregate.affectedSessionIds.add(run.sessionId);
      aggregate.severity = preferHigherSeverity(aggregate.severity, finding.severity);

      for (const evidence of finding.relatedEvidence) {
        addEvidenceItem(aggregate.evidence, toEvidenceItem(evidence, run, 'finding-support', finding.stepIndex));
      }
    }
  }

  return [...byKey.values()]
    .map<FeatureAggregatedFinding>((item) => ({
      key: item.key,
      severity: item.severity,
      summary: item.summary,
      ...(item.detail ? { detail: item.detail } : {}),
      type: item.type,
      disposition: item.disposition,
      status: item.status,
      firstSeenAt: item.firstSeenAt,
      lastSeenAt: item.lastSeenAt,
      occurrences: item.occurrences,
      affectedTestCases: [...item.affectedTestCases].sort((a, b) => a.localeCompare(b)),
      affectedSessionIds: [...item.affectedSessionIds],
      evidence: [...item.evidence.values()],
      correlationClaim: 'observed_around_same_time',
    }))
    .sort((a, b) => {
      const aOrder = SEVERITY_ORDER[a.severity] ?? Number.POSITIVE_INFINITY;
      const bOrder = SEVERITY_ORDER[b.severity] ?? Number.POSITIVE_INFINITY;
      const severityDelta = aOrder - bOrder;
      if (severityDelta !== 0) return severityDelta;
      return a.firstSeenAt - b.firstSeenAt;
    });
}

function selectFeatureEvidence(
  runModels: readonly RunModel[],
  findings: readonly FeatureAggregatedFinding[],
): ExportEvidenceItem[] {
  const selected = new Map<string, ExportEvidenceItem>();

  for (const finding of findings) {
    if (finding.severity !== 'critical' && finding.severity !== 'high') continue;
    for (const evidence of finding.evidence) {
      addEvidenceItem(selected, evidence);
      if (selected.size >= 24) return [...selected.values()];
    }
  }

  if (selected.size === 0) {
    for (const finding of findings) {
      for (const evidence of finding.evidence) {
        addEvidenceItem(selected, evidence);
        if (selected.size >= 24) return [...selected.values()];
      }
    }
  }

  for (const run of runModels) {
    const result = run.canonical.overview.testResult;
    if (result !== 'fail' && result !== 'blocked') continue;
    for (const step of run.canonical.sections.flatMap((section) => section.steps)) {
      if (step.beforeEvidence) addEvidenceItem(selected, toEvidenceItem(step.beforeEvidence, run, 'failed-blocked-run', step.index));
      if (step.afterEvidence) addEvidenceItem(selected, toEvidenceItem(step.afterEvidence, run, 'failed-blocked-run', step.index));
      if (selected.size >= 24) return [...selected.values()];
    }
  }

  const representativePass = runModels.find((run) => run.canonical.overview.testResult === 'pass');
  if (representativePass) {
    for (const step of representativePass.canonical.sections.flatMap((section) => section.steps)) {
      if (!step.afterEvidence && !step.beforeEvidence) continue;
      if (step.beforeEvidence) addEvidenceItem(selected, toEvidenceItem(step.beforeEvidence, representativePass, 'representative-success', step.index));
      if (step.afterEvidence) addEvidenceItem(selected, toEvidenceItem(step.afterEvidence, representativePass, 'representative-success', step.index));
      if (selected.size >= 24) break;
    }
  }

  return [...selected.values()];
}

function selectTestCaseEvidence(model: CanonicalExportModel): ExportEvidenceItem[] {
  const selected = new Map<string, ExportEvidenceItem>();
  const run: RunModel = {
    canonical: model,
    sessionId: model.meta.sessionId,
    testCaseName: model.overview.testCaseName?.trim() || 'Untitled Test Case',
  };

  for (const step of model.sections.flatMap((section) => section.steps)) {
    if (step.beforeEvidence) addEvidenceItem(selected, toEvidenceItem(step.beforeEvidence, run, 'before-after-story', step.index));
    if (step.afterEvidence) addEvidenceItem(selected, toEvidenceItem(step.afterEvidence, run, 'before-after-story', step.index));
    if (selected.size >= 40) return [...selected.values()];
  }

  for (const finding of model.findings) {
    for (const evidence of finding.relatedEvidence) {
      addEvidenceItem(selected, toEvidenceItem(evidence, run, 'finding-support', finding.stepIndex));
      if (selected.size >= 40) return [...selected.values()];
    }
  }

  for (const step of model.sections.flatMap((section) => section.steps)) {
    for (const evidence of step.systemEvidence) {
      addEvidenceItem(selected, toEvidenceItem(evidence, run, 'relevant-system-evidence', step.index));
      if (selected.size >= 40) return [...selected.values()];
    }
  }

  return [...selected.values()];
}

function toEvidenceItem(
  evidence: EvidenceRef,
  run: RunModel,
  reason: ExportEvidenceItem['reason'],
  stepIndex?: number,
): ExportEvidenceItem {
  return {
    blobKey: evidence.blobKey,
    mimeType: evidence.mimeType,
    missing: evidence.missing,
    capturedAt: evidence.capturedAt,
    sourceSessionId: run.sessionId,
    sourceTestCaseName: run.testCaseName,
    reason,
    ...(typeof stepIndex === 'number' ? { stepIndex } : {}),
  };
}

function addEvidenceItem(target: Map<string, ExportEvidenceItem>, item: ExportEvidenceItem): void {
  if (target.has(item.blobKey)) return;
  target.set(item.blobKey, item);
}

function addSeverityTotals(
  target: Record<FindingSeverity, number>,
  source: Readonly<Record<FindingSeverity, number>>,
): void {
  target.critical += source.critical ?? 0;
  target.high += source.high ?? 0;
  target.medium += source.medium ?? 0;
  target.low += source.low ?? 0;
  target.info += source.info ?? 0;
}

function preferHigherSeverity(current: FindingSeverity, incoming: FindingSeverity): FindingSeverity {
  const incomingOrder = SEVERITY_ORDER[incoming] ?? Number.POSITIVE_INFINITY;
  const currentOrder = SEVERITY_ORDER[current] ?? Number.POSITIVE_INFINITY;
  return incomingOrder < currentOrder ? incoming : current;
}

export function collectEvidenceBlobKeys(model: CanonicalExportModel): Set<string> {
  const keys = new Set<string>();
  for (const section of model.sections) {
    for (const step of section.steps) {
      if (step.beforeEvidence?.blobKey) keys.add(step.beforeEvidence.blobKey);
      if (step.afterEvidence?.blobKey) keys.add(step.afterEvidence.blobKey);
      for (const evidence of step.systemEvidence) keys.add(evidence.blobKey);
    }
  }
  for (const finding of model.findings) {
    for (const evidence of finding.relatedEvidence) keys.add(evidence.blobKey);
  }
  return keys;
}

export function countSlowRequests(requests: readonly NetworkFindingSummary[]): number {
  return requests.filter((req) => req.isOverSla).length;
}
