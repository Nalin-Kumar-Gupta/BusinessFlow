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
  readonly includesMarkdown: boolean;
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
      'text/plain': new Blob([rendered.markdown], { type: 'text/plain' }),
      'text/html': new Blob([rendered.html], { type: 'text/html' }),
    };

    basePayload['text/markdown'] = new Blob([rendered.markdown], { type: 'text/markdown' });

    try {
      await clipboard.write([new ClipboardItem(basePayload)]);
      return {
        mode: 'rich',
        imageCount: rendered.resolvedImageCount,
        missingImageCount: rendered.missingImageCount,
        includesMarkdown: true,
      };
    } catch {
      // Fall through to text-only.
    }
  }

  try {
    await clipboard.writeText(rendered.markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('denied') || message.includes('permission')) {
      throw new Error('Clipboard permission blocked. Allow clipboard access and try again.');
    }
    throw new Error('Clipboard write failed. Try again and keep the dashboard tab focused.');
  }
  return {
    mode: 'text',
    imageCount: rendered.resolvedImageCount,
    missingImageCount: rendered.missingImageCount,
    includesMarkdown: true,
  };
}
