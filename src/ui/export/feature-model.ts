import type {
  CanonicalExportModel,
  ObservedFinding,
} from '../../export/model/canonical.js';
import type { FindingSeverity, SessionStatus, TestResult } from '../../core/types.js';

const ZERO_FINDINGS: Readonly<Record<FindingSeverity, number>> = Object.freeze({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

export function buildFeatureCanonicalModel(
  models: readonly CanonicalExportModel[],
  featureName: string,
): CanonicalExportModel {
  if (models.length === 0) {
    throw new Error('Feature export failed: no session models were available.');
  }

  let globalStepIndex = 1;
  const sectionRows: CanonicalExportModel['sections'][number][] = [];
  const findingRows: ObservedFinding[] = [];
  const mapByModelStepIndex = new Map<number, number>();

  models.forEach((model, modelIndex) => {
    const testCaseLabel = model.overview.testCaseName?.trim() || `Test Case ${modelIndex + 1}`;
    const mergedSteps = model.sections.flatMap((section) => section.steps).map((step) => {
      const nextIndex = globalStepIndex;
      globalStepIndex += 1;
      mapByModelStepIndex.set((modelIndex * 10_000) + step.index, nextIndex);
      return {
        ...step,
        index: nextIndex,
      };
    });

    sectionRows.push({
      id: `case-${modelIndex + 1}`,
      title: testCaseLabel,
      ...(model.overview.testCaseId ? { testCaseId: model.overview.testCaseId } : {}),
      sourceSessionId: model.meta.sessionId,
      ...(model.overview.status ? { status: model.overview.status } : {}),
      testResult: model.overview.testResult,
      startedAt: model.environment.startedAt,
      ...(typeof model.environment.durationMs === 'number' ? { durationMs: model.environment.durationMs } : {}),
      steps: mergedSteps,
    });

    findingRows.push(...model.findings.map((finding) => ({
      ...finding,
      id: `${model.meta.sessionId}-${finding.id}`,
      ...(typeof finding.stepIndex === 'number'
        ? { stepIndex: mapByModelStepIndex.get((modelIndex * 10_000) + finding.stepIndex) ?? finding.stepIndex }
        : {}),
    })));
  });

  const mergedFindings: Record<FindingSeverity, number> = { ...ZERO_FINDINGS };
  for (const model of models) {
    mergedFindings.critical += model.stats.findings.critical ?? 0;
    mergedFindings.high += model.stats.findings.high ?? 0;
    mergedFindings.medium += model.stats.findings.medium ?? 0;
    mergedFindings.low += model.stats.findings.low ?? 0;
    mergedFindings.info += model.stats.findings.info ?? 0;
  }

  const firstModel = models[0]!;
  const startedAt = Math.min(...models.map((model) => model.environment.startedAt));
  const endedAtValues = models
    .map((model) => model.environment.endedAt)
    .filter((value): value is number => typeof value === 'number');
  const endedAt = endedAtValues.length > 0 ? Math.max(...endedAtValues) : undefined;

  return {
    schemaVersion: 1,
    meta: {
      generatedAt: Date.now(),
      generatedBy: firstModel.meta.generatedBy,
      sessionId: `feature:${featureName}:${Date.now()}`,
      correlationVersion: firstModel.meta.correlationVersion,
    },
    overview: {
      featureName,
      testCaseName: `All test cases (${models.length})`,
      testType: models.some((model) => model.overview.testType === 'Negative') ? 'Negative' : 'Positive',
      negativeTest: models.some((model) => model.overview.negativeTest === 'yes') ? 'yes' : 'no',
      status: foldStatus(models.map((model) => model.overview.status).filter((status): status is SessionStatus => typeof status === 'string')),
      testResult: foldResult(models.map((model) => model.overview.testResult)),
      verdictSummary: `${models.length} test cases exported using latest run per test case.`,
    },
    environment: {
      startedAt,
      ...(typeof endedAt === 'number' ? { endedAt } : {}),
      ...(typeof endedAt === 'number' ? { durationMs: Math.max(0, endedAt - startedAt) } : {}),
      userAgent: firstModel.environment.userAgent,
      chromeVersion: firstModel.environment.chromeVersion,
      platform: firstModel.environment.platform,
      extVersion: firstModel.environment.extVersion,
      timeZone: firstModel.environment.timeZone,
      viewport: firstModel.environment.viewport,
      scopeOrigins: [...new Set(models.flatMap((model) => model.environment.scopeOrigins))],
      apiSlaSec: firstModel.environment.apiSlaSec,
    },
    stats: {
      steps: models.reduce((sum, model) => sum + model.stats.steps, 0),
      stepsWithBugs: models.reduce((sum, model) => sum + model.stats.stepsWithBugs, 0),
      stepsNoStateChange: models.reduce((sum, model) => sum + model.stats.stepsNoStateChange, 0),
      bugs: models.reduce((sum, model) => sum + model.stats.bugs, 0),
      findings: mergedFindings,
      network: {
        total: models.reduce((sum, model) => sum + model.stats.network.total, 0),
        failed: models.reduce((sum, model) => sum + model.stats.network.failed, 0),
        slowOverSla: models.reduce((sum, model) => sum + model.stats.network.slowOverSla, 0),
        thirdParty: models.reduce((sum, model) => sum + model.stats.network.thirdParty, 0),
      },
      console: {
        errors: models.reduce((sum, model) => sum + model.stats.console.errors, 0),
        warnings: models.reduce((sum, model) => sum + model.stats.console.warnings, 0),
        pageErrors: models.reduce((sum, model) => sum + model.stats.console.pageErrors, 0),
      },
      userSignals: {
        clicks: models.reduce((sum, model) => sum + model.stats.userSignals.clicks, 0),
        rageClicks: models.reduce((sum, model) => sum + model.stats.userSignals.rageClicks, 0),
        manualCaptures: models.reduce((sum, model) => sum + model.stats.userSignals.manualCaptures, 0),
        screenshots: models.reduce((sum, model) => sum + model.stats.userSignals.screenshots, 0),
      },
      performance: undefined,
    },
    sections: sectionRows,
    findings: findingRows,
    appendix: {
      network: mergeMany(models, (model) => model.appendix.network),
      consoleWarnings: mergeMany(models, (model) => model.appendix.consoleWarnings),
      performance: {
        webVitals: mergeMany(models, (model) => model.appendix.performance.webVitals),
        pageTimings: mergeMany(models, (model) => model.appendix.performance.pageTimings),
        longTasks: mergeMany(models, (model) => model.appendix.performance.longTasks),
        memorySnapshots: mergeMany(models, (model) => model.appendix.performance.memorySnapshots),
      },
      domMetrics: mergeMany(models, (model) => model.appendix.domMetrics),
      cspViolations: mergeMany(models, (model) => model.appendix.cspViolations),
      checkpoints: mergeMany(models, (model) => model.appendix.checkpoints),
      navigationHistory: mergeMany(models, (model) => model.appendix.navigationHistory),
      captureTimeline: {
        pausedAt: models.flatMap((model) => model.appendix.captureTimeline.pausedAt),
        resumedAt: models.flatMap((model) => model.appendix.captureTimeline.resumedAt),
      },
    },
  };
}

function mergeMany<T>(
  models: readonly CanonicalExportModel[],
  picker: (model: CanonicalExportModel) => readonly T[],
): readonly T[] {
  return models.flatMap((model) => picker(model));
}

function foldStatus(statuses: readonly SessionStatus[]): SessionStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('pass')) return 'pass';
  return 'draft';
}

function foldResult(results: readonly TestResult[]): TestResult {
  if (results.includes('fail')) return 'fail';
  if (results.includes('blocked')) return 'blocked';
  if (results.includes('partial')) return 'partial';
  if (results.includes('in_progress')) return 'in_progress';
  return 'pass';
}
