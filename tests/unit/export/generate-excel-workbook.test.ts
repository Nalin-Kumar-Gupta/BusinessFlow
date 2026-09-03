import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import type { ExcelWorkbookViewModel } from '../../../src/ui/export/excel/excel-view-model.js';
import { generateExcelWorkbook } from '../../../src/ui/export/excel/generate-workbook.js';

function vmFixture(): ExcelWorkbookViewModel {
  return {
    summary: {
      reportTitle: 'QA Analysis Workbook',
      generatedAtLabel: '2026-09-01 12:00:00',
      rows: [
        { metric: 'Verdict (Workflow Status)', value: 'FAIL' },
        { metric: 'Steps', value: 2 },
      ],
    },
    steps: [
      {
        stepNumber: 1,
        action: '=Click Submit',
        timestamp: 1_000,
        durationMs: 300,
        url: 'https://example.com/checkout',
        status: 'FAIL',
        notes: '+Validation copy unclear',
        bugCount: 1,
        failedRequestCount: 1,
        consoleErrorCount: 0,
      },
    ],
    findings: [
      {
        severity: 'CRITICAL',
        type: 'HTTP_ERROR',
        summary: 'HTTP 500',
        step: 1,
        timestamp: 1_050,
        temporalRelationship: '50 ms from correlated click',
        testerNote: 'Reproducible',
        evidenceRef: 'blob-2',
        disposition: 'Observed Failure',
      },
    ],
    technicalSignals: [
      {
        stepNumber: 1,
        signalType: 'failed-request',
        severity: 'critical',
        detail: 'POST /api -> 500',
        timestamp: 1_055,
      },
    ],
    network: [
      {
        requestId: 'req-1',
        method: 'POST',
        url: 'https://example.com/api',
        origin: 'https://example.com',
        statusCode: 500,
        outcome: 'failed',
        durationMs: 210,
        resourceType: 'fetch',
        isThirdParty: false,
      },
    ],
    consoleErrors: [
      {
        source: 'CONSOLE_ERROR',
        message: 'Unhandled exception',
        timestamp: 1_060,
        pageUrl: 'https://example.com/checkout',
      },
    ],
    evidence: [
      {
        scope: 'step',
        refId: 'step-1',
        step: 1,
        kind: 'before',
        mimeType: 'image/jpeg',
        capturedAt: 1_000,
        missing: false,
      },
    ],
    performance: [
      {
        category: 'Web Vitals',
        metric: 'LCP',
        value: 2200,
        unit: 'ms',
        timestamp: 1_070,
      },
    ],
    sessionMeta: [
      {
        category: 'Session',
        key: 'Session ID',
        value: 'sess-1',
      },
    ],
  };
}

describe('generateExcelWorkbook', () => {
  it('produces structurally valid XLSX with analysis-oriented sheets', async () => {
    const buffer = await generateExcelWorkbook(vmFixture());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const names = workbook.worksheets.map((ws) => ws.name);
    expect(names).toEqual([
      'Summary',
      'Steps',
      'Findings',
      'TechSignals',
      'Network',
      'ConsoleErrors',
      'Evidence',
      'Performance',
      'SessionMeta',
    ]);

    const steps = workbook.getWorksheet('Steps');
    expect(steps?.autoFilter).toBeDefined();
    expect(steps?.views?.[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(steps?.getCell('A1').value).toBe('Step');

    const findings = workbook.getWorksheet('Findings');
    const stepCell = findings?.getCell('D2').value as { text: string; hyperlink: string };
    expect(stepCell?.text).toBe('1');
    expect(stepCell?.hyperlink).toContain('#Steps!A2');

    expect(steps?.getCell('B2').value).toBe("'=Click Submit");
    expect(steps?.getCell('G2').value).toBe("'+Validation copy unclear");
  });
});
