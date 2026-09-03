import type { CanonicalExportModel } from '../../../export/model/canonical.js';
import type { SessionExportBundle } from '../../../storage/db.js';

import {
  buildFeatureExportModel,
  buildTestCaseExportModel,
  collectEvidenceBlobKeys,
  type FeatureExportModel,
  type TestCaseExportModel,
} from '../scope-models.js';
import { loadEvidenceBlobs } from '../pdf/blob-loader.js';
import { generateWordDocx } from './generate-docx.js';
import { prepareWordProps } from './prepare-word-props.js';

export interface SessionWordBuildResult {
  readonly blob: Blob;
  readonly missingScreenshotCount: number;
  readonly loadedScreenshotCount: number;
  readonly model: CanonicalExportModel;
  readonly scopeModel: FeatureExportModel | TestCaseExportModel;
}

export async function buildSessionWord(bundle: SessionExportBundle): Promise<SessionWordBuildResult> {
  return buildWordFromBundles([bundle], bundle.session.featureName || 'Feature');
}

export async function buildFeatureWord(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<SessionWordBuildResult> {
  return buildWordFromBundles(bundles, featureName);
}

async function buildWordFromBundles(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<SessionWordBuildResult> {
  if (bundles.length === 0) {
    throw new Error('Word export failed: no runs were available for export.');
  }

  const scopeModel = bundles.length === 1
    ? buildTestCaseExportModel(bundles[0]!)
    : buildFeatureExportModel({ bundles, featureName });

  const model = scopeModel.scope === 'test-case'
    ? scopeModel.canonical
    : scopeModel.renderModel;

  const requiredBlobKeys = collectEvidenceBlobKeys(model);
  const blobLoad = await loadEvidenceBlobs(requiredBlobKeys);
  const view = prepareWordProps(model, blobLoad.resolver);
  const blob = await generateWordDocx(view);

  return {
    blob,
    model,
    scopeModel,
    missingScreenshotCount: view.missingScreenshotCount,
    loadedScreenshotCount: blobLoad.loadedCount,
  };
}
