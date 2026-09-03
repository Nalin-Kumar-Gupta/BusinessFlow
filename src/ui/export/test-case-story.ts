import type { CanonicalExportModel, CanonicalStep, ObservedFinding } from '../../export/model/canonical.js';

export function isFeatureAggregateModel(model: CanonicalExportModel): boolean {
  return model.meta.sessionId.startsWith('feature:');
}

export function selectTestCaseStorySteps(model: CanonicalExportModel): readonly CanonicalStep[] {
  return model.sections.flatMap((section) => section.steps);
}

export function mapFindingsByStep(findings: readonly ObservedFinding[]): ReadonlyMap<number, readonly ObservedFinding[]> {
  const map = new Map<number, ObservedFinding[]>();
  for (const finding of findings) {
    if (typeof finding.stepIndex !== 'number') continue;
    const bucket = map.get(finding.stepIndex);
    if (bucket) bucket.push(finding);
    else map.set(finding.stepIndex, [finding]);
  }
  return map;
}
