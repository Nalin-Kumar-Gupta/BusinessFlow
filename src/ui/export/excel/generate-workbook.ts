import ExcelJS from 'exceljs';

import { sanitizeExcelCellText } from '../../../core/security.js';
import type { ExcelWorkbookViewModel } from './excel-view-model.js';

export async function generateExcelWorkbook(view: ExcelWorkbookViewModel): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BusinessFlow';
  workbook.created = new Date();

  addSummarySheet(workbook, view);
  if (view.featureCases && view.featureCases.length > 0) addFeatureCasesSheet(workbook, view);
  addStepsSheet(workbook, view);
  addFindingsSheet(workbook, view);
  addTechnicalSignalsSheet(workbook, view);
  addNetworkSheet(workbook, view);
  addConsoleSheet(workbook, view);
  addEvidenceSheet(workbook, view);
  addPerformanceSheet(workbook, view);
  addSessionMetaSheet(workbook, view);

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

function addSummarySheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('Summary');
  sheet.columns = [
    { header: 'Metric', key: 'metric', width: 36 },
    { header: 'Value', key: 'value', width: 44 },
  ];

  sheet.addRow(['Workbook', view.summary.reportTitle]);
  sheet.addRow(['Generated At', view.summary.generatedAtLabel]);
  sheet.addRow([]);

  for (const row of view.summary.rows) sheet.addRow({ metric: row.metric, value: row.value });

  sheet.addRow([]);
  sheet.addRow(['Quick Links', '']);
  const links = [
    ['Steps', '#Steps!A1'],
    ...(view.featureCases && view.featureCases.length > 0 ? [['TestCases', '#TestCases!A1'] as const] : []),
    ['Findings', '#Findings!A1'],
    ['TechSignals', '#TechSignals!A1'],
    ['Network', '#Network!A1'],
    ['ConsoleErrors', '#ConsoleErrors!A1'],
    ['Evidence', '#Evidence!A1'],
    ['Performance', '#Performance!A1'],
    ['SessionMeta', '#SessionMeta!A1'],
  ] as const;

  for (const [label, target] of links) {
    const row = sheet.addRow([label, 'Open sheet']);
    row.getCell(2).value = { text: 'Open sheet', hyperlink: target };
    row.getCell(2).font = { color: { argb: 'FF0B57D0' }, underline: true };
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'B1' };
}

function addFeatureCasesSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const rows = view.featureCases ?? [];
  if (rows.length === 0) return;

  const sheet = workbook.addWorksheet('TestCases');
  sheet.columns = [
    { header: 'Test Case', key: 'testCase', width: 40 },
    { header: 'Result', key: 'result', width: 14 },
    { header: 'Session ID', key: 'sessionId', width: 28 },
    { header: 'Started', key: 'startedAt', width: 22 },
    { header: 'Duration (ms)', key: 'durationMs', width: 14 },
    { header: 'Step Count', key: 'stepCount', width: 12 },
    { header: 'Findings', key: 'findingsCount', width: 12 },
  ];

  for (const row of rows) {
    const added = sheet.addRow({
      testCase: row.testCase,
      result: row.result,
      sessionId: row.sessionId ?? '',
      startedAt: row.startedAt ? new Date(row.startedAt) : '',
      durationMs: row.durationMs ?? '',
      stepCount: row.stepCount,
      findingsCount: row.findingsCount,
    });
    if (row.startedAt) added.getCell('startedAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'H1' };
}

function addStepsSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('Steps');
  const includeTestCase = view.steps.some((row) => Boolean(row.testCase));
  sheet.columns = [
    ...(includeTestCase ? [{ header: 'Test Case', key: 'testCase', width: 30 }] : []),
    { header: 'Step', key: 'step', width: 10 },
    { header: 'Action', key: 'action', width: 36 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
    { header: 'Duration (ms)', key: 'duration', width: 14 },
    { header: 'URL', key: 'url', width: 48 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Notes', key: 'notes', width: 44 },
    { header: 'Bug Count', key: 'bugCount', width: 12 },
    { header: 'Failed Req Count', key: 'failedReqCount', width: 16 },
    { header: 'Console Err Count', key: 'consoleErrCount', width: 16 },
  ];

  for (const row of view.steps) {
    const added = sheet.addRow({
      ...(includeTestCase ? { testCase: row.testCase ?? '' } : {}),
      step: row.stepNumber,
      action: row.action,
      timestamp: new Date(row.timestamp),
      duration: row.durationMs ?? null,
      url: row.url ?? '',
      status: row.status,
      notes: row.notes,
      bugCount: row.bugCount,
      failedReqCount: row.failedRequestCount,
      consoleErrCount: row.consoleErrorCount,
    });
    added.getCell('timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: includeTestCase ? 'K1' : 'J1' };
}

function addFindingsSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('Findings');
  const includeTestCase = view.findings.some((row) => Boolean(row.testCase));
  sheet.columns = [
    ...(includeTestCase ? [{ header: 'Test Case', key: 'testCase', width: 30 }] : []),
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Type', key: 'type', width: 22 },
    { header: 'Summary', key: 'summary', width: 42 },
    { header: 'Step', key: 'step', width: 10 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
    { header: 'Temporal Relationship', key: 'temporal', width: 26 },
    { header: 'Tester Note', key: 'testerNote', width: 36 },
    { header: 'Evidence Ref', key: 'evidenceRef', width: 40 },
    { header: 'Disposition', key: 'disposition', width: 20 },
  ];

  for (const finding of view.findings) {
    const row = sheet.addRow({
      ...(includeTestCase ? { testCase: finding.testCase ?? '' } : {}),
      severity: finding.severity,
      type: finding.type,
      summary: finding.summary,
      step: finding.step ?? '',
      timestamp: new Date(finding.timestamp),
      temporal: finding.temporalRelationship ?? '',
      testerNote: finding.testerNote ?? '',
      evidenceRef: finding.evidenceRef,
      disposition: finding.disposition,
    });
    row.getCell('timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';

    if (typeof finding.step === 'number') {
      row.getCell('step').value = {
        text: String(finding.step),
        hyperlink: `#Steps!A${finding.step + 1}`,
      };
      row.getCell('step').font = { color: { argb: 'FF0B57D0' }, underline: true };
    }

    const sevCell = row.getCell('severity');
    if (finding.severity === 'CRITICAL' || finding.severity === 'HIGH') {
      sevCell.font = { color: { argb: 'FFB91C1C' }, bold: true };
    }
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: includeTestCase ? 'J1' : 'I1' };
}

function addTechnicalSignalsSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('TechSignals');
  const includeTestCase = view.technicalSignals.some((row) => Boolean(row.testCase));
  sheet.columns = [
    ...(includeTestCase ? [{ header: 'Test Case', key: 'testCase', width: 30 }] : []),
    { header: 'Step', key: 'step', width: 10 },
    { header: 'Signal Type', key: 'signalType', width: 22 },
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Detail', key: 'detail', width: 64 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
  ];

  for (const row of view.technicalSignals) {
    const added = sheet.addRow({
      ...(includeTestCase ? { testCase: row.testCase ?? '' } : {}),
      step: row.stepNumber,
      signalType: row.signalType,
      severity: row.severity,
      detail: row.detail,
      timestamp: row.timestamp ? new Date(row.timestamp) : '',
    });

    if (row.timestamp) added.getCell('timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';
    if (row.severity === 'critical') added.getCell('severity').font = { color: { argb: 'FFB91C1C' }, bold: true };
    if (row.severity === 'warn') added.getCell('severity').font = { color: { argb: 'FFE37400' }, bold: true };

    added.getCell('step').value = {
      text: String(row.stepNumber),
      hyperlink: `#Steps!A${row.stepNumber + 1}`,
    };
    added.getCell('step').font = { color: { argb: 'FF0B57D0' }, underline: true };
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: includeTestCase ? 'F1' : 'E1' };
}

function addNetworkSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('Network');
  sheet.columns = [
    { header: 'Request ID', key: 'requestId', width: 14 },
    { header: 'Method', key: 'method', width: 10 },
    { header: 'URL', key: 'url', width: 52 },
    { header: 'Origin', key: 'origin', width: 30 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Outcome', key: 'outcome', width: 14 },
    { header: 'Duration (ms)', key: 'duration', width: 14 },
    { header: 'Resource Type', key: 'resourceType', width: 16 },
    { header: 'Third-Party', key: 'thirdParty', width: 12 },
  ];

  for (const row of view.network) {
    const added = sheet.addRow({
      requestId: row.requestId,
      method: row.method,
      url: row.url,
      origin: row.origin,
      status: row.statusCode ?? '',
      outcome: row.outcome,
      duration: row.durationMs ?? '',
      resourceType: row.resourceType,
      thirdParty: row.isThirdParty ? 'yes' : 'no',
    });

    if (row.outcome === 'failed') {
      added.getCell('outcome').font = { color: { argb: 'FFB91C1C' }, bold: true };
    } else if (row.outcome === 'slow') {
      added.getCell('outcome').font = { color: { argb: 'FFE37400' }, bold: true };
    }
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'I1' };
}

function addConsoleSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('ConsoleErrors');
  sheet.columns = [
    { header: 'Source', key: 'source', width: 18 },
    { header: 'Message', key: 'message', width: 64 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
    { header: 'Page URL', key: 'pageUrl', width: 44 },
  ];

  for (const row of view.consoleErrors) {
    const added = sheet.addRow({
      source: row.source,
      message: row.message,
      timestamp: new Date(row.timestamp),
      pageUrl: row.pageUrl ?? '',
    });
    added.getCell('timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'D1' };
}

function addEvidenceSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('Evidence');
  const includeTestCase = view.evidence.some((row) => Boolean(row.testCase));
  sheet.columns = [
    ...(includeTestCase ? [{ header: 'Test Case', key: 'testCase', width: 28 }] : []),
    { header: 'Scope', key: 'scope', width: 12 },
    { header: 'Ref ID', key: 'refId', width: 28 },
    { header: 'Step', key: 'step', width: 12 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'MIME', key: 'mime', width: 14 },
    { header: 'Captured At', key: 'capturedAt', width: 22 },
    { header: 'Missing', key: 'missing', width: 12 },
  ];

  for (const row of view.evidence) {
    const added = sheet.addRow({
      ...(includeTestCase ? { testCase: row.testCase ?? '' } : {}),
      scope: row.scope,
      refId: row.refId,
      step: row.step ?? '',
      kind: row.kind,
      mime: row.mimeType,
      capturedAt: new Date(row.capturedAt),
      missing: row.missing ? 'yes' : 'no',
    });
    added.getCell('capturedAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: includeTestCase ? 'H1' : 'G1' };
}

function addPerformanceSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('Performance');
  sheet.columns = [
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Metric', key: 'metric', width: 26 },
    { header: 'Value', key: 'value', width: 12 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
  ];

  for (const row of view.performance) {
    const added = sheet.addRow({
      category: row.category,
      metric: row.metric,
      value: row.value,
      unit: row.unit,
      timestamp: row.timestamp ? new Date(row.timestamp) : '',
    });
    if (row.timestamp) added.getCell('timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'E1' };
}

function addSessionMetaSheet(workbook: ExcelJS.Workbook, view: ExcelWorkbookViewModel): void {
  const sheet = workbook.addWorksheet('SessionMeta');
  sheet.columns = [
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Key', key: 'key', width: 32 },
    { header: 'Value', key: 'value', width: 60 },
  ];

  for (const row of view.sessionMeta) {
    sheet.addRow({
      category: row.category,
      key: row.key,
      value: row.value,
    });
  }

  styleHeader(sheet, 1);
  sanitizeWorksheetTextCells(sheet);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'C1' };
}

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber: number): void {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F3864' },
  };
}

function sanitizeWorksheetTextCells(sheet: ExcelJS.Worksheet): void {
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;
    row.eachCell((cell) => {
      if (typeof cell.value === 'string') {
        cell.value = sanitizeExcelCellText(cell.value);
      }
    });
  });
}
