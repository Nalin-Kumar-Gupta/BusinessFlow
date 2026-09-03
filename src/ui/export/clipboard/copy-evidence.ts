import type { SessionExportBundle } from '../../../storage/db.js';

import {
  buildFeatureExportModel,
  buildTestCaseExportModel,
} from '../scope-models.js';

import { loadEvidenceBlobs } from '../pdf/blob-loader.js';
import { buildClipboardEvidenceView } from './clipboard-view-model.js';
import { renderClipboardEvidence } from './render-clipboard.js';

export interface CopyEvidenceResult {
  readonly mode: 'rich' | 'text';
  readonly imageCount: number;
  readonly missingImageCount: number;
}

export async function copySessionEvidence(bundle: SessionExportBundle): Promise<CopyEvidenceResult> {
  return copyEvidenceFromBundles([bundle], bundle.session.featureName || 'Feature');
}

export async function copyFeatureEvidence(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<CopyEvidenceResult> {
  return copyEvidenceFromBundles(bundles, featureName);
}

async function copyEvidenceFromBundles(
  bundles: readonly SessionExportBundle[],
  featureName: string,
): Promise<CopyEvidenceResult> {
  if (bundles.length === 0) {
    throw new Error('Copy evidence failed: no runs were available for export.');
  }

  const scopeModel = bundles.length === 1
    ? buildTestCaseExportModel(bundles[0]!)
    : buildFeatureExportModel({ bundles, featureName });
  const model = scopeModel.scope === 'test-case' ? scopeModel.canonical : scopeModel.renderModel;

  const view = buildClipboardEvidenceView(model);

  const requiredBlobKeys = view.evidence
    .filter((item) => !item.missing)
    .map((item) => item.blobKey);

  const blobLoad = await loadEvidenceBlobs(requiredBlobKeys);
  const rendered = renderClipboardEvidence(view, (blobKey) => blobLoad.resolver.resolve(blobKey));

  const clipboard = navigator.clipboard;
  if (!clipboard) {
    throw new Error('Clipboard is unavailable in this browser context.');
  }

  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    const basePayload: Record<string, Blob> = {
      'text/plain': new Blob([rendered.text], { type: 'text/plain' }),
      'text/html': new Blob([rendered.html], { type: 'text/html' }),
    };

    try {
      await clipboard.write([new ClipboardItem(basePayload)]);
      return {
        mode: 'rich',
        imageCount: rendered.resolvedImageCount,
        missingImageCount: rendered.missingImageCount,
      };
    } catch {
      // Fall through to text-only.
    }
  }

  await clipboard.writeText(rendered.text);
  return {
    mode: 'text',
    imageCount: rendered.resolvedImageCount,
    missingImageCount: rendered.missingImageCount,
  };
}
