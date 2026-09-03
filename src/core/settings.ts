/**
 * TestTrace user-configurable settings.
 *
 * This file is intentionally chrome-API-free (pure core types/defaults).
 * Storage adapters live in src/storage/settings.ts.
 */

export interface TestTraceSettings {
  /** Whether API SLA monitoring is active */
  slaEnabled: boolean;
  /** SLA threshold in seconds (1–30) */
  slaSec: number;
  /**
   * Whether the pipeline may automatically take screenshots.
   * When false, only manual captures are taken; suggestions still show.
   */
  autoCaptureEnabled: boolean;
  /**
   * How many runs to retain per (feature, test case).
   * Oldest run is removed when the limit is exceeded.
   */
  maxRunsPerTestCase: number;
  /**
   * Capture request/response bodies for failed network calls (4xx/5xx/0).
   * Off by default to reduce accidental sensitive-data collection.
   */
  captureNetworkErrorBodies: boolean;
  /** JPEG quality for screenshots (50–100) */
  screenshotQuality: number;
  /**
   * Default export format.
   * 'docx' = OOXML via jszip (current)
   * 'pdf'  = browser print-to-PDF
   */
  exportFormat: 'docx' | 'pdf';
}

export const DEFAULT_SETTINGS: Readonly<TestTraceSettings> = {
  slaEnabled:         false,
  slaSec:             3,
  autoCaptureEnabled: true,
  maxRunsPerTestCase: 10,
  captureNetworkErrorBodies: false,
  screenshotQuality:  82,
  exportFormat:       'docx',
};
