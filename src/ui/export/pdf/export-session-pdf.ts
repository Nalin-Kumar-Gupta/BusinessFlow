import { createElement } from 'react';

import type { CanonicalExportModel } from '../../../export/model/canonical.js';
import type { SessionExportBundle } from '../../../storage/db.js';

import {
  buildFeatureExportModel,
  buildTestCaseExportModel,
  collectEvidenceBlobKeys,
  type FeatureExportModel,
  type TestCaseExportModel,
} from '../scope-models.js';
import { loadEvidenceBlobs } from './blob-loader.js';
import { preparePdfProps } from './prepare-pdf-props.js';

export interface SessionPdfBuildResult {
  readonly blob: Blob;
  readonly missingScreenshotCount: number;
  readonly loadedScreenshotCount: number;
  readonly model: CanonicalExportModel;
  readonly scopeModel: FeatureExportModel | TestCaseExportModel;
}

/**
 * Build a single-session QA evidence PDF from storage bundle -> canonical
 * model -> PDF view model -> Blob.
 */
export async function buildSessionPdf(bundle: SessionExportBundle): Promise<SessionPdfBuildResult> {
  return buildPdfFromBundles([bundle], bundle.session.featureName || 'Feature');
}

export async function buildFeaturePdf(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<SessionPdfBuildResult> {
  return buildPdfFromBundles(bundles, featureName);
}

async function buildPdfFromBundles(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<SessionPdfBuildResult> {
  if (bundles.length === 0) {
    throw new Error('PDF export failed: no runs were available for export.');
  }

  const scopeModel = bundles.length === 1
    ? buildTestCaseExportModel(bundles[0]!)
    : buildFeatureExportModel({ bundles, featureName });

  const model = scopeModel.scope === 'test-case'
    ? scopeModel.canonical
    : scopeModel.renderModel;

  const requiredBlobKeys = collectEvidenceBlobKeys(model);
  const blobLoad = await loadEvidenceBlobs(requiredBlobKeys);
  const viewModel = preparePdfProps(model, blobLoad.resolver);

  const [{ pdf }, { QaReportPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./QaReportPdf.js'),
  ]);

  const doc = createElement(QaReportPdf, { viewModel }) as unknown as Parameters<typeof pdf>[0];
  const blob = await pdf(doc).toBlob();

  return {
    blob,
    model,
    scopeModel,
    missingScreenshotCount: viewModel.missingScreenshotCount,
    loadedScreenshotCount: blobLoad.loadedCount,
  };
}
