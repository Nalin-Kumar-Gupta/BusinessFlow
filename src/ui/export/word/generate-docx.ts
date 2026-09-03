import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type {
  WordExportViewModel,
  WordKeyValue,
  WordStepImageView,
  WordStepView,
} from './word-view-model.js';

const IMAGE_MAX_WIDTH = 300;
const IMAGE_MAX_HEIGHT = 190;

export async function generateWordDocx(view: WordExportViewModel): Promise<Blob> {
  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({ text: view.cover.reportTitle, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `Generated: ${view.cover.generatedAtLabel}` }),
    new Paragraph({ text: `Verdict: ${view.cover.verdictLabel}`, spacing: { after: 120 } }),
    new Paragraph({ text: view.cover.verdictSummary, spacing: { after: 240 } }),
  );

  pushSectionHeading(children, '1. Cover / Executive Summary');
  children.push(summaryStatsTable(view.executionSummary.stats));

  pushSectionHeading(children, '2. Test Identity');
  children.push(keyValueTable(view.testIdentity));

  pushSectionHeading(children, '3. Verdict');
  children.push(keyValueTable([
    { key: 'Status', value: view.verdict.statusLabel },
    { key: 'Auto Result', value: view.verdict.testResultLabel },
    { key: 'Negative Test', value: view.verdict.negativeTestLabel },
    ...(view.verdict.notes ? [{ key: 'Tester Notes', value: view.verdict.notes }] : []),
  ]));
  if (view.verdict.negativeAssertions.length > 0) {
    children.push(negativeAssertionsTable(view.verdict.negativeAssertions));
  }

  pushSectionHeading(children, '4. Environment');
  children.push(keyValueTable(view.environment));

  pushSectionHeading(children, '5. Execution Story');
  if (view.featureSummary) {
    children.push(featureSummaryTable(view.featureSummary.rows));
    for (const section of view.testCaseSections ?? []) {
      children.push(new Paragraph({ text: `Test Case — ${section.title}`, heading: HeadingLevel.HEADING_2, pageBreakBefore: true }));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `Result: ${section.verdict}`, bold: true }),
          new TextRun({ text: section.startedAtLabel ? ` • Started: ${section.startedAtLabel}` : '' }),
          new TextRun({ text: section.durationLabel ? ` • Duration: ${section.durationLabel}` : '' }),
        ],
      }));
      if (section.sessionId) children.push(new Paragraph({ text: `Session: ${section.sessionId}` }));
      for (const step of section.steps) pushStep(children, step);
    }
  } else {
    for (const step of view.executionStory) {
      pushStep(children, step);
    }
  }

  pushSectionHeading(children, '6. Findings');
  children.push(findingsTable(view));

  pushSectionHeading(children, '7. Technical Evidence');
  children.push(technicalEvidenceTable(view));

  pushSectionHeading(children, '8. Appendix');
  children.push(keyValueTable(view.appendix.map((row) => ({ key: row.label, value: row.value }))));
  if (view.missingScreenshotCount > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: `Missing screenshots: ${view.missingScreenshotCount}`, bold: true })],
    }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBlob(doc);
}

function pushSectionHeading(target: Array<Paragraph | Table>, title: string): void {
  target.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 120 } }));
}

function pushStep(target: Array<Paragraph | Table>, step: WordStepView): void {
  target.push(new Paragraph({ text: `Step ${step.stepNumber} — ${step.action}`, heading: HeadingLevel.HEADING_2 }));
  target.push(new Paragraph({ text: `Timestamp: ${step.timestampLabel}${step.durationLabel ? ` • Duration to next: ${step.durationLabel}` : ''}` }));
  if (step.pageUrl) target.push(new Paragraph({ text: `URL: ${step.pageUrl}` }));

  target.push(new Paragraph({ text: 'Screenshots', heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 80 } }));
  target.push(stepImagesTable(step.before, step.after));

  if (step.testerNotes.length > 0) {
    target.push(new Paragraph({ text: 'Tester Notes', heading: HeadingLevel.HEADING_3 }));
    for (const note of step.testerNotes) target.push(new Paragraph({ text: `• ${note}` }));
  }

  if (step.testerBugs.length > 0) {
    target.push(new Paragraph({ text: 'Tester Bugs', heading: HeadingLevel.HEADING_3 }));
    for (const bug of step.testerBugs) target.push(new Paragraph({ text: `• ${bug}` }));
  }

  if (step.linkedFindings.length > 0) {
    target.push(new Paragraph({ text: 'Linked Findings', heading: HeadingLevel.HEADING_3 }));
    for (const finding of step.linkedFindings) target.push(new Paragraph({ text: `• ${finding}` }));
  }

  if (step.technicalSignals.length > 0) {
    target.push(new Paragraph({ text: 'Relevant Technical Signals', heading: HeadingLevel.HEADING_3 }));
    for (const signal of step.technicalSignals) {
      target.push(new Paragraph({ children: [new TextRun({ text: `${signal.label}:`, bold: true })] }));
      for (const line of signal.details) target.push(new Paragraph({ text: `  - ${line}` }));
    }
  }
}

function keyValueTable(rows: readonly WordKeyValue[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: rows.map((row) =>
      new TableRow({
        children: [
          new TableCell({ width: { size: 28, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: row.key, bold: true })] })] }),
          new TableCell({ width: { size: 72, type: WidthType.PERCENTAGE }, children: [new Paragraph(row.value)] }),
        ],
      })),
  });
}

function summaryStatsTable(stats: readonly { label: string; value: string }[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Metric', bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Value', bold: true })] })] }),
        ],
      }),
      ...stats.map((stat) =>
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(stat.label)] }),
            new TableCell({ children: [new Paragraph(stat.value)] }),
          ],
        })),
    ],
  });
}

function featureSummaryTable(rows: readonly { testCase: string; verdict: string; stepCount: number; findingsCount: number }[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: ['Test Case', 'Result', 'Steps', 'Findings']
          .map((h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })),
      }),
      ...rows.map((row) => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(row.testCase)] }),
          new TableCell({ children: [new Paragraph(row.verdict)] }),
          new TableCell({ children: [new Paragraph(String(row.stepCount))] }),
          new TableCell({ children: [new Paragraph(String(row.findingsCount))] }),
        ],
      })),
    ],
  });
}

function negativeAssertionsTable(assertions: readonly { channel: string; expected: string; observed: string; verdict: string }[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Channel', bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Expected', bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Observed', bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Verdict', bold: true })] })] }),
        ],
      }),
      ...assertions.map((assertion) =>
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(assertion.channel)] }),
            new TableCell({ children: [new Paragraph(assertion.expected)] }),
            new TableCell({ children: [new Paragraph(assertion.observed)] }),
            new TableCell({ children: [new Paragraph(assertion.verdict)] }),
          ],
        })),
    ],
  });
}

function stepImagesTable(before: WordStepImageView, after?: WordStepImageView): Table {
  if (!after) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: before.label, bold: true })] })] }),
          ],
        }),
        new TableRow({
          children: [
            new TableCell({ children: buildImageCell(before) }),
          ],
        }),
      ],
    });
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: before.label, bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: after.label, bold: true })] })] }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({ children: buildImageCell(before) }),
          new TableCell({ children: buildImageCell(after) }),
        ],
      }),
    ],
  });
}

function buildImageCell(view: WordStepImageView): Paragraph[] {
  const paras: Paragraph[] = [];
  const image = view.dataUrl ? parseImageData(view.dataUrl, view.widthPx, view.heightPx) : null;
  if (image) {
    paras.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({
        data: image.bytes,
        type: image.type,
        transformation: image.transformation,
      })],
    }));
  } else {
    const reason = view.missing ? 'Screenshot unavailable in storage.' : 'No screenshot captured.';
    paras.push(new Paragraph({ children: [new TextRun({ text: reason, italics: true })] }));
  }

  if (view.annotations.length > 0) {
    paras.push(new Paragraph({ children: [new TextRun({ text: 'Annotations', bold: true })] }));
    for (const ann of view.annotations) paras.push(new Paragraph({ text: `• ${ann}` }));
  }
  return paras;
}

function findingsTable(view: WordExportViewModel): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: ['Severity', 'Summary', 'Disposition', 'Step', 'Timestamp']
          .map((h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })),
      }),
      ...view.findings.map((finding) => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(finding.severity)] }),
          new TableCell({ children: [new Paragraph(finding.summary)] }),
          new TableCell({ children: [new Paragraph(finding.disposition)] }),
          new TableCell({ children: [new Paragraph(finding.stepReference ?? '—')] }),
          new TableCell({ children: [new Paragraph(finding.timestampLabel)] }),
        ],
      })),
    ],
  });
}

function technicalEvidenceTable(view: WordExportViewModel): Table {
  const reqRows = view.technicalEvidence.failedOrSlowRequests.map((req) => ({
    source: 'Request',
    detail: `${req.request} • ${req.outcome}${req.duration ? ` • ${req.duration}` : ''}`,
  }));
  const errRows = view.technicalEvidence.errorSignals.map((err) => ({
    source: err.source,
    detail: err.message,
  }));
  const rows = [...reqRows, ...errRows].slice(0, 40);

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Source', bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Detail', bold: true })] })] }),
        ],
      }),
      ...rows.map((row) => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(row.source)] }),
          new TableCell({ children: [new Paragraph(row.detail)] }),
        ],
      })),
    ],
  });
}

interface ParsedImageData {
  readonly bytes: Uint8Array;
  readonly type: 'png' | 'jpg' | 'gif' | 'bmp';
  readonly transformation: { width: number; height: number };
}

function parseImageData(dataUrl: string, widthPx?: number, heightPx?: number): ParsedImageData | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma).toLowerCase();
  const base64 = dataUrl.slice(comma + 1);
  if (!base64) return null;

  const type = header.includes('image/jpeg') || header.includes('image/jpg')
    ? 'jpg'
    : header.includes('image/gif')
      ? 'gif'
      : header.includes('image/bmp')
        ? 'bmp'
        : 'png';

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return {
      bytes,
      type,
      transformation: fitWithinBox(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, widthPx, heightPx),
    };
  } catch {
    return null;
  }
}

function fitWithinBox(
  maxWidth: number,
  maxHeight: number,
  intrinsicWidth?: number,
  intrinsicHeight?: number,
): { width: number; height: number } {
  if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return { width: maxWidth, height: maxHeight };
  }

  const ratio = Math.min(maxWidth / intrinsicWidth, maxHeight / intrinsicHeight, 1);
  return {
    width: Math.max(1, Math.round(intrinsicWidth * ratio)),
    height: Math.max(1, Math.round(intrinsicHeight * ratio)),
  };
}
