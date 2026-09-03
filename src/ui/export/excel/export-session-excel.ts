import type { CanonicalExportModel } from '../../../export/model/canonical.js';
import type { SessionExportBundle } from '../../../storage/db.js';

import {
  buildFeatureExportModel,
  buildTestCaseExportModel,
  type FeatureExportModel,
  type TestCaseExportModel,
} from '../scope-models.js';
import { generateExcelWorkbook } from './generate-workbook.js';
import { prepareExcelProps } from './prepare-excel-props.js';

export interface SessionExcelBuildResult {
  readonly buffer: ArrayBuffer;
  readonly model: CanonicalExportModel;
  readonly scopeModel: FeatureExportModel | TestCaseExportModel;
}

export async function buildSessionExcel(bundle: SessionExportBundle): Promise<SessionExcelBuildResult> {
  return buildExcelFromBundles([bundle], bundle.session.featureName || 'Feature');
}

export async function buildFeatureExcel(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<SessionExcelBuildResult> {
  return buildExcelFromBundles(bundles, featureName);
}

async function buildExcelFromBundles(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<SessionExcelBuildResult> {
  if (bundles.length === 0) {
    throw new Error('Excel export failed: no runs were available for export.');
  }

  const scopeModel = bundles.length === 1
    ? buildTestCaseExportModel(bundles[0]!)
    : buildFeatureExportModel({ bundles, featureName });

  const model = scopeModel.scope === 'test-case'
    ? scopeModel.canonical
    : scopeModel.renderModel;

  const view = prepareExcelProps(model);
  const buffer = await generateExcelWorkbook(view);

  return { buffer, model, scopeModel };
}
