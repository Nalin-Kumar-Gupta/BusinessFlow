export interface WordExportViewModel {
  readonly cover: {
    readonly reportTitle: string;
    readonly generatedAtLabel: string;
    readonly verdictLabel: string;
    readonly verdictSummary: string;
  };
  readonly testIdentity: readonly WordKeyValue[];
  readonly verdict: {
    readonly statusLabel: string;
    readonly testResultLabel: string;
    readonly negativeTestLabel: string;
    readonly notes?: string;
    readonly negativeAssertions: readonly WordNegativeAssertionView[];
  };
  readonly environment: readonly WordKeyValue[];
  readonly executionSummary: {
    readonly stats: readonly WordStatView[];
  };
  readonly featureSummary?: {
    readonly totalTestCases: number;
    readonly rows: readonly WordFeatureSummaryRow[];
  };
  readonly executionStory: readonly WordStepView[];
  readonly testCaseSections?: readonly WordTestCaseSectionView[];
  readonly findings: readonly WordFindingView[];
  readonly technicalEvidence: {
    readonly failedOrSlowRequests: readonly WordRequestSignalView[];
    readonly errorSignals: readonly WordErrorSignalView[];
  };
  readonly appendix: readonly WordAppendixRow[];
  readonly missingScreenshotCount: number;
}

export interface WordFeatureSummaryRow {
  readonly testCase: string;
  readonly verdict: string;
  readonly stepCount: number;
  readonly findingsCount: number;
}

export interface WordTestCaseSectionView {
  readonly title: string;
  readonly verdict: string;
  readonly sessionId?: string;
  readonly startedAtLabel?: string;
  readonly durationLabel?: string;
  readonly steps: readonly WordStepView[];
}

export interface WordKeyValue {
  readonly key: string;
  readonly value: string;
}

export interface WordStatView {
  readonly label: string;
  readonly value: string;
}

export interface WordNegativeAssertionView {
  readonly channel: string;
  readonly expected: string;
  readonly observed: string;
  readonly verdict: string;
}

export interface WordStepImageView {
  readonly label: string;
  readonly dataUrl?: string;
  readonly missing: boolean;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly annotations: readonly string[];
}

export interface WordStepTechnicalSignalView {
  readonly label: string;
  readonly details: readonly string[];
}

export interface WordStepView {
  readonly stepNumber: number;
  readonly action: string;
  readonly pageUrl?: string;
  readonly timestampLabel: string;
  readonly durationLabel?: string;
  readonly before: WordStepImageView;
  readonly after?: WordStepImageView;
  readonly testerNotes: readonly string[];
  readonly testerBugs: readonly string[];
  readonly linkedFindings: readonly string[];
  readonly technicalSignals: readonly WordStepTechnicalSignalView[];
}

export interface WordFindingView {
  readonly severity: string;
  readonly summary: string;
  readonly detail?: string;
  readonly disposition: string;
  readonly stepReference?: string;
  readonly timestampLabel: string;
}

export interface WordRequestSignalView {
  readonly request: string;
  readonly outcome: string;
  readonly duration?: string;
}

export interface WordErrorSignalView {
  readonly source: string;
  readonly message: string;
}

export interface WordAppendixRow {
  readonly label: string;
  readonly value: string;
}

export interface WordEvidenceResolver {
  resolve(blobKey: string): string | undefined;
}
