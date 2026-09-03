import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

export interface WordBugMatrixRow {
  testCase: string;
  stepNum: number;
  description: string;
}

export interface WordDevTraceRow {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

export interface WordBuggyStep {
  id: string;
  stepTitle: string;
  stepNum: number;
  bugDescriptions: string[];
  beforeImageDataUrl?: string;
  afterImageDataUrl?: string;
  devTraceRows: WordDevTraceRow[];
}

export interface WordFeatureData {
  featureName: string;
  totalRuns: number;
  passRateLabel: string;
  apiErrorRateLabel: string;
  bugMatrixRows: WordBugMatrixRow[];
  buggySteps: WordBuggyStep[];
}

interface ParsedImageData {
  bytes: Uint8Array;
  type: 'png' | 'jpg' | 'gif' | 'bmp';
}

function dataUrlToBytes(dataUrl: string | undefined): ParsedImageData | null {
  if (!dataUrl) return null;
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) return null;
  const header = dataUrl.slice(0, commaIndex).toLowerCase();
  const base64 = dataUrl.slice(commaIndex + 1);
  if (!base64) return null;

  let type: ParsedImageData['type'] = 'png';
  if (header.includes('image/jpeg') || header.includes('image/jpg')) type = 'jpg';
  else if (header.includes('image/gif')) type = 'gif';
  else if (header.includes('image/bmp')) type = 'bmp';

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { bytes, type };
  } catch {
    return null;
  }
}

function bugMatrixTable(rows: WordBugMatrixRow[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph('Test Case')] }),
          new TableCell({ children: [new Paragraph('Step #')] }),
          new TableCell({ children: [new Paragraph('Description')] }),
        ],
      }),
      ...rows.map((row) => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(row.testCase || 'Untitled Test Case')] }),
          new TableCell({ children: [new Paragraph(String(row.stepNum))] }),
          new TableCell({ children: [new Paragraph(row.description || 'No description provided')] }),
        ],
      })),
    ],
  });
}

function devTraceTable(rows: WordDevTraceRow[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph('Method')] }),
          new TableCell({ children: [new Paragraph('URL')] }),
          new TableCell({ children: [new Paragraph('Status')] }),
          new TableCell({ children: [new Paragraph('Duration (ms)')] }),
        ],
      }),
      ...rows.map((row) => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(row.method)] }),
          new TableCell({ children: [new Paragraph(row.url)] }),
          new TableCell({ children: [new Paragraph(String(row.status))] }),
          new TableCell({ children: [new Paragraph(String(Math.round(row.durationMs)))] }),
        ],
      })),
    ],
  });
}

export async function generateWordReport(featureData: WordFeatureData): Promise<Blob> {
  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({ text: featureData.featureName, heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`Total Runs: ${featureData.totalRuns}`),
    new Paragraph(`Pass Rate: ${featureData.passRateLabel}`),
    new Paragraph(`API Error Rate: ${featureData.apiErrorRateLabel}`),
    new Paragraph({ text: 'Bug Matrix', heading: HeadingLevel.HEADING_1 }),
  );

  children.push(bugMatrixTable(featureData.bugMatrixRows));

  children.push(new Paragraph({ text: 'Developer Trace', heading: HeadingLevel.HEADING_1 }));

  for (const step of featureData.buggySteps) {
    try {
      children.push(
        new Paragraph({ text: `Step ${step.stepNum}: ${step.stepTitle}`, heading: HeadingLevel.HEADING_2 }),
      );

      for (const description of step.bugDescriptions) {
        children.push(new Paragraph(`• ${description || 'No description provided'}`));
      }

      const beforeImage = dataUrlToBytes(step.beforeImageDataUrl);
      if (beforeImage) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: 'Before Screenshot', bold: true }),
          ],
        }));
        children.push(new Paragraph({
          children: [
            new ImageRun({
              data: beforeImage.bytes,
              type: beforeImage.type,
              transformation: { width: 280, height: 180 },
            }),
          ],
        }));
      }

      const afterImage = dataUrlToBytes(step.afterImageDataUrl);
      if (afterImage) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: 'After Screenshot', bold: true }),
          ],
        }));
        children.push(new Paragraph({
          children: [
            new ImageRun({
              data: afterImage.bytes,
              type: afterImage.type,
              transformation: { width: 280, height: 180 },
            }),
          ],
        }));
      }

      const devRows = step.devTraceRows.filter((row) => row.status >= 400 || row.durationMs > 500);
      children.push(new Paragraph({ text: 'Network Telemetry', heading: HeadingLevel.HEADING_2 }));
      if (devRows.length > 0) {
        children.push(devTraceTable(devRows));
      } else {
        children.push(new Paragraph('No slow/failing network requests for this step.'));
      }
    } catch {
      children.push(new Paragraph('Skipped malformed step during document generation.'));
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}
