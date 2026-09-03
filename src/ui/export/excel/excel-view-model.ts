export interface ExcelWorkbookViewModel {
  readonly summary: ExcelSummaryView;
  readonly featureCases?: readonly ExcelFeatureCaseRow[];
  readonly steps: readonly ExcelStepRow[];
  readonly findings: readonly ExcelFindingRow[];
  readonly technicalSignals: readonly ExcelTechnicalSignalRow[];
  readonly network: readonly ExcelNetworkRow[];
  readonly consoleErrors: readonly ExcelConsoleRow[];
  readonly evidence: readonly ExcelEvidenceRow[];
  readonly performance: readonly ExcelPerformanceRow[];
  readonly sessionMeta: readonly ExcelSessionMetaRow[];
}

export interface ExcelFeatureCaseRow {
  readonly testCase: string;
  readonly result: string;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly durationMs?: number;
  readonly stepCount: number;
  readonly findingsCount: number;
}


export interface ExcelSummaryView {
  readonly reportTitle: string;
  readonly generatedAtLabel: string;
  readonly rows: readonly ExcelSummaryRow[];
}

export interface ExcelSummaryRow {
  readonly metric: string;
  readonly value: string | number;
}

export interface ExcelStepRow {
  readonly testCase?: string;
  readonly stepNumber: number;
  readonly action: string;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly url?: string;
  readonly status: string;
  readonly notes: string;
  readonly bugCount: number;
  readonly failedRequestCount: number;
  readonly consoleErrorCount: number;
}

export interface ExcelFindingRow {
  readonly testCase?: string;
  readonly severity: string;
  readonly type: string;
  readonly summary: string;
  readonly step?: number;
  readonly timestamp: number;
  readonly temporalRelationship?: string;
  readonly testerNote?: string;
  readonly evidenceRef: string;
  readonly disposition: string;
}

export interface ExcelNetworkRow {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly origin: string;
  readonly statusCode?: number;
  readonly outcome: 'failed' | 'slow' | 'success' | 'third-party';
  readonly durationMs?: number;
  readonly resourceType: string;
  readonly isThirdParty: boolean;
}

export interface ExcelTechnicalSignalRow {
  readonly testCase?: string;
  readonly stepNumber: number;
  readonly signalType: 'failed-request' | 'slow-request' | 'console-error' | 'page-error' | 'navigation' | 'no-visible-change';
  readonly severity: 'critical' | 'warn' | 'info';
  readonly detail: string;
  readonly timestamp?: number;
}

export interface ExcelConsoleRow {
  readonly source: string;
  readonly message: string;
  readonly timestamp: number;
  readonly pageUrl?: string;
}

export interface ExcelEvidenceRow {
  readonly testCase?: string;
  readonly scope: 'step' | 'finding';
  readonly refId: string;
  readonly step?: number;
  readonly kind: 'before' | 'after' | 'system' | 'finding';
  readonly mimeType: string;
  readonly capturedAt: number;
  readonly missing: boolean;
}

export interface ExcelPerformanceRow {
  readonly category: string;
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly timestamp?: number;
}

export interface ExcelSessionMetaRow {
  readonly category: string;
  readonly key: string;
  readonly value: string;
}
