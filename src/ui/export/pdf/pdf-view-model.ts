import type { FindingSeverity } from '../../../core/types.js';

export interface PdfViewModel {
  readonly cover: PdfCoverView;
  readonly environment: readonly PdfKeyValue[];
  readonly executionStats: readonly PdfStat[];
  readonly steps: readonly PdfStepView[];
  readonly findings: readonly PdfFindingView[];
  readonly appendix: PdfAppendixView;
  readonly footer: PdfFooterView;
  readonly missingScreenshotCount: number;
  readonly featureSummary?: PdfFeatureSummaryView;
  readonly testCaseSections?: readonly PdfTestCaseSectionView[];
}

export interface PdfCoverView {
  readonly brand: string;
  readonly reportTitle: string;
  readonly verdictKey: string;
  readonly verdictLabel: string;
  readonly verdictColor: string;
  readonly testCaseName: string;
  readonly verdictSummary: string;
  readonly identity: readonly PdfKeyValue[];
  readonly atGlance: readonly PdfStat[];
  readonly topRisks: readonly PdfCoverRiskItem[];
  readonly negativeAssertions: readonly PdfNegativeAssertionView[];
  readonly testerNotes?: string;
  readonly negativeTestBanner?: string;
  readonly statusContextBanner?: string;
}

export interface PdfCoverRiskItem {
  readonly severity: FindingSeverity;
  readonly severityLabel: string;
  readonly summary: string;
  readonly stepReference?: string;
}

export interface PdfNegativeAssertionView {
  readonly channelLabel: string;
  readonly expected: string;
  readonly observed: string;
  readonly verdictLabel: 'PASS' | 'FAIL';
  readonly verdictColor: string;
}

export interface PdfKeyValue {
  readonly label: string;
  readonly value: string;
}

export interface PdfStat {
  readonly label: string;
  readonly value: string;
  readonly emphasized?: boolean;
}

export interface PdfStepView {
  readonly id: string;
  readonly indexLabel: string;
  readonly actionLine: string;
  readonly timestampLabel: string;
  readonly pageUrl?: string;
  readonly durationLabel?: string;
  readonly hasBug: boolean;
  readonly noVisibleChange: boolean;
  readonly stepFindings: readonly PdfStepFindingView[];
  readonly beforeEvidence?: PdfEvidenceView;
  readonly afterEvidence?: PdfEvidenceView;
  readonly systemEvidence: readonly PdfEvidenceView[];
  readonly annotationLegend: readonly PdfAnnotationLegendEntry[];
  readonly bugs: readonly PdfStepBugView[];
  readonly notes: readonly PdfStepNoteView[];
  readonly correlated: readonly PdfCorrelatedLine[];
}

export interface PdfStepFindingView {
  readonly severityLabel: string;
  readonly summary: string;
}

export interface PdfEvidenceView {
  readonly caption: 'BEFORE' | 'AFTER' | 'SYSTEM';
  readonly dataUrl?: string;
  readonly missingReason?: 'not-captured' | 'blob-lost' | 'load-failed';
  readonly pins: readonly PdfPinView[];
  readonly highlightRect?: PdfHighlightRectView;
  readonly imageWidthPx?: number;
  readonly imageHeightPx?: number;
  readonly capturedAtLabel?: string;
  readonly dimensionsLabel?: string;
}

export interface PdfHighlightRectView {
  readonly xPercent: number;
  readonly yPercent: number;
  readonly widthPercent: number;
  readonly heightPercent: number;
}

export interface PdfPinView {
  readonly kind: 'note' | 'bug';
  readonly xPercent: number;
  readonly yPercent: number;
  readonly number: number;
  readonly note?: string;
}

export interface PdfAnnotationLegendEntry {
  readonly number: number;
  readonly kind: 'note' | 'bug';
  readonly target: 'before' | 'after' | 'system';
  readonly text: string;
}

export interface PdfStepBugView {
  readonly id: string;
  readonly description: string;
  readonly pinNumber?: number;
}

export interface PdfStepNoteView {
  readonly id: string;
  readonly text: string;
  readonly pinNumber?: number;
}

export interface PdfCorrelatedLine {
  readonly severity: 'critical' | 'warn' | 'info';
  readonly text: string;
}

export interface PdfFindingView {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly severityColor: string;
  readonly severityLabel: string;
  readonly dispositionLabel: string;
  readonly summary: string;
  readonly timestampLabel: string;
  readonly stepReference?: string;
  readonly detail?: string;
  readonly testerNote?: string;
  readonly temporalNote?: string;
}

export interface PdfAppendixView {
  readonly network: readonly PdfAppendixNetworkRow[];
  readonly consoleWarnings: readonly PdfAppendixConsoleRow[];
  readonly navigationHistory: readonly PdfAppendixNavigationRow[];
  readonly webVitals: readonly PdfKeyValue[];
  readonly checkpoints: readonly PdfKeyValue[];
  readonly negativeInference?: PdfNegativeInferenceView;
  readonly captureTimeline: {
    readonly pauses: number;
    readonly resumes: number;
  };
}

export interface PdfAppendixNetworkRow {
  readonly method: string;
  readonly path: string;
  readonly origin: string;
  readonly status: string;
  readonly duration: string;
  readonly isFailed: boolean;
  readonly isSlow: boolean;
}

export interface PdfAppendixConsoleRow {
  readonly kind: string;
  readonly message: string;
  readonly timestampLabel: string;
}

export interface PdfAppendixNavigationRow {
  readonly url: string;
  readonly kind: 'route' | 'load';
  readonly timestampLabel: string;
}

export interface PdfNegativeInferenceView {
  readonly confidenceLabel: string;
  readonly signals: readonly string[];
  readonly testerVerdict?: string;
}

export interface PdfTestCaseSectionView {
  readonly id: string;
  readonly title: string;
  readonly verdictLabel: string;
  readonly verdictColor: string;
  readonly sessionId?: string;
  readonly startedAtLabel?: string;
  readonly durationLabel?: string;
  readonly stepCount: number;
  readonly findingsCount: number;
  readonly steps: readonly PdfStepView[];
}

export interface PdfFeatureSummaryView {
  readonly totalTestCases: number;
  readonly resultCounts: Readonly<Record<'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL' | 'IN PROGRESS' | 'DRAFT', number>>;
  readonly matrix: readonly {
    readonly testCase: string;
    readonly result: string;
    readonly stepCount: number;
    readonly findingsCount: number;
  }[];
}

export interface PdfFooterView {
  readonly leftText: string;
  readonly centerText: string;
  readonly rightPrefix: string;
}
