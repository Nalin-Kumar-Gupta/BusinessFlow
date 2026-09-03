import ExcelJS from 'exceljs';

export interface ExcelBugMatrixRow {
  testCase: string;
  stepNum: number;
  description: string;
}

export interface ExcelNetworkTelemetryRow {
  testCase: string;
  stepNum: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

export interface ExcelFeatureData {
  featureName: string;
  passCount: number;
  failCount: number;
  avgLatencyMs: number;
  bugMatrixRows: ExcelBugMatrixRow[];
  networkTelemetryRows: ExcelNetworkTelemetryRow[];
}

export async function generateExcelReport(featureData: ExcelFeatureData): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BusinessFlow';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Executive Summary');
  summarySheet.addRow(['Feature', featureData.featureName]);
  summarySheet.addRow(['Pass Count', featureData.passCount]);
  summarySheet.addRow(['Fail Count', featureData.failCount]);
  summarySheet.addRow(['Avg Latency (ms)', Math.round(featureData.avgLatencyMs)]);

  summarySheet.columns = [
    { width: 28 },
    { width: 30 },
  ];

  const bugSheet = workbook.addWorksheet('Bug Matrix');
  bugSheet.columns = [
    { header: 'Test Case', key: 'testCase', width: 40 },
    { header: 'Step Number', key: 'stepNum', width: 16 },
    { header: 'Bug Description', key: 'description', width: 80 },
  ];

  for (const row of featureData.bugMatrixRows) {
    try {
      bugSheet.addRow({
        testCase: row.testCase || 'Untitled Test Case',
        stepNum: row.stepNum,
        description: row.description || 'No description provided',
      });
    } catch {
      bugSheet.addRow({
        testCase: 'Malformed row',
        stepNum: '',
        description: 'Skipped due to invalid data.',
      });
    }
  }

  const networkSheet = workbook.addWorksheet('Network Telemetry');
  networkSheet.columns = [
    { header: 'Test Case', key: 'testCase', width: 32 },
    { header: 'Step Number', key: 'stepNum', width: 14 },
    { header: 'Method', key: 'method', width: 12 },
    { header: 'URL', key: 'url', width: 80 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Duration (ms)', key: 'durationMs', width: 16 },
  ];

  for (const row of featureData.networkTelemetryRows) {
    try {
      const added = networkSheet.addRow({
        testCase: row.testCase || 'Untitled Test Case',
        stepNum: row.stepNum,
        method: row.method,
        url: row.url,
        status: row.status,
        durationMs: Math.round(row.durationMs),
      });

      const statusCell = added.getCell('status');
      if (typeof row.status === 'number' && row.status >= 400) {
        statusCell.font = { color: { argb: 'FFB91C1C' }, bold: true };
      }
    } catch {
      const added = networkSheet.addRow({
        testCase: 'Malformed row',
        stepNum: '',
        method: '',
        url: '',
        status: '',
        durationMs: '',
      });
      added.getCell('url').value = 'Skipped due to invalid telemetry data.';
    }
  }

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
