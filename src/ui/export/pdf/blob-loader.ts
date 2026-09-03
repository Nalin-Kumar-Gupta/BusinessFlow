// Narrow adapter: given a set of blobKeys, return a resolver that answers
// "what data URL should the PDF renderer use for this key?"
//
// Loads sequentially, not in parallel: peak decode-buffer memory is one blob
// at a time. Failed loads produce no entry (renderer draws a placeholder,
// export continues).
//
// This adapter is the ONLY place in the export pipeline that touches
// storage. Business/projection logic lives outside.

import { getBlob } from '../../../storage/db.js';
import type { EvidenceResolver } from './prepare-pdf-props.js';

const CHUNK_SIZE = 0x8000; // 32 KiB — safe for String.fromCharCode.apply spread.

export interface BlobLoadResult {
  readonly resolver: EvidenceResolver;
  readonly loadedCount: number;
  readonly failedKeys: readonly string[];
}

/**
 * Sequentially load every requested blob key into a data URL map.
 *
 * Sequential (not parallel) is deliberate — @react-pdf/renderer will hold all
 * decoded image sources in memory during render regardless, so parallelism
 * would only raise the transient decode buffer. Sequential loading keeps peak
 * transient memory at one image at a time.
 */
export async function loadEvidenceBlobs(blobKeys: Iterable<string>): Promise<BlobLoadResult> {
  const dataUrlByKey = new Map<string, string>();
  const failedKeys: string[] = [];
  const uniqueKeys = Array.from(new Set(blobKeys));

  for (const key of uniqueKeys) {
    try {
      const record = await getBlob(key);
      if (!record) {
        failedKeys.push(key);
        continue;
      }
      const dataUrl = bytesToDataUrl(record.data, record.mimeType);
      dataUrlByKey.set(key, dataUrl);
    } catch (error) {
      // Do not fail the whole export because one screenshot is unreadable.
      // The renderer draws a placeholder; the caller shows a summary toast.
      console.warn('[pdf-export] failed to load blob', key, error);
      failedKeys.push(key);
    }
  }

  const resolver: EvidenceResolver = {
    resolve(blobKey: string): string | undefined {
      return dataUrlByKey.get(blobKey);
    },
  };

  return {
    resolver,
    loadedCount: dataUrlByKey.size,
    failedKeys,
  };
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  // Chunked to avoid `Maximum call stack size exceeded` on large images.
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
