import { escapeHtml } from '../../../core/security.js';
import { redactUrl } from '../../../core/url.js';

import type { ClipboardEvidenceItem, ClipboardEvidenceViewModel } from './clipboard-view-model.js';

export interface ClipboardRenderResult {
  readonly html: string;
  readonly text: string;
  readonly resolvedImageCount: number;
  readonly missingImageCount: number;
}

const TARGET_IMAGE_WIDTH_PX = 450;
const TARGET_IMAGE_HEIGHT_PX = 396;

export function renderClipboardEvidence(
  view: ClipboardEvidenceViewModel,
  resolveDataUrl: (blobKey: string) => string | undefined,
): ClipboardRenderResult {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  let resolvedImageCount = 0;
  let missingImageCount = 0;

  htmlParts.push('<div>');
  htmlParts.push(`<h2>${escapeHtml(view.reportTitle)}</h2>`);
  htmlParts.push(`<p><strong>Verdict:</strong> ${escapeHtml(view.verdict)}</p>`);
  textParts.push(view.reportTitle);
  textParts.push(`Verdict: ${view.verdict}`);

  if (view.isFeatureScope && view.testCaseResults && view.testCaseResults.length > 0) {
    htmlParts.push('<h3>Test case results</h3><ul>');
    textParts.push('');
    textParts.push('Test case results:');
    for (const row of view.testCaseResults) {
      htmlParts.push(`<li><strong>${escapeHtml(row.verdict)}</strong> — ${escapeHtml(row.testCase)} (${row.stepCount} steps, ${row.findingsCount} findings)</li>`);
      textParts.push(`- ${row.verdict} — ${row.testCase} (${row.stepCount} steps, ${row.findingsCount} findings)`);
    }
    htmlParts.push('</ul>');
  }

  if (view.isNegativeTest) {
    htmlParts.push('<p><em>Negative test context: failing responses may be expected by design for this run.</em></p>');
    textParts.push('Negative test context: failing responses may be expected by design for this run.');
  }

  if (view.identityRows.length > 0) {
    htmlParts.push('<h3>Test identity</h3><ul>');
    textParts.push('');
    textParts.push('Test identity:');
    for (const row of view.identityRows) {
      htmlParts.push(`<li><strong>${escapeHtml(row.label)}:</strong> ${escapeHtml(row.value)}</li>`);
      textParts.push(`- ${row.label}: ${row.value}`);
    }
    htmlParts.push('</ul>');
  }

  htmlParts.push(`<p>${escapeHtml(view.summaryLine)}</p>`);
  textParts.push('');
  textParts.push(view.summaryLine);

  if (view.contextLine) {
    htmlParts.push(`<h3>Tester context</h3><p>${escapeHtml(view.contextLine)}</p>`);
    textParts.push('');
    textParts.push('Tester context:');
    textParts.push(view.contextLine);
  }

  if (view.steps.length > 0) {
    htmlParts.push('<h3>Execution steps</h3><ol>');
    textParts.push('');
    textParts.push('Execution steps:');
    for (const step of view.steps) {
      const safeAction = redactPotentialUrl(step.action);
      const suffix = step.timestampLabel ? ` <span style="color: #57606a;">(${escapeHtml(step.timestampLabel)})</span>` : '';
      htmlParts.push(`<li>${escapeHtml(safeAction)}${suffix}</li>`);
      textParts.push(`${step.index}. ${safeAction}${step.timestampLabel ? ` (${step.timestampLabel})` : ''}`);
      if (step.notes.length > 0) {
        const noteLine = step.notes.map((note) => redactPotentialUrl(note)).join(' | ');
        htmlParts.push(`<div style="margin: 0 0 8px 16px; font-size: 12px; color: #57606a;">Notes: ${escapeHtml(noteLine)}</div>`);
        textParts.push(`   Notes: ${noteLine}`);
      }
    }
    htmlParts.push('</ol>');
  }

  if (view.findings.length > 0) {
    htmlParts.push('<h3>Findings</h3><ul>');
    textParts.push('');
    textParts.push('Findings:');
    for (const finding of view.findings) {
      const detail = [
        `${finding.severity.toUpperCase()} — ${redactPotentialUrl(finding.summary)}`,
        finding.stepIndex ? `(Step ${finding.stepIndex})` : '',
        finding.temporalNote ? redactPotentialUrl(finding.temporalNote) : '',
      ].filter(Boolean).join(' ');
      htmlParts.push(`<li>${escapeHtml(detail)}</li>`);
      textParts.push(`- ${detail}`);
      if (finding.detail) {
        const safeDetail = redactPotentialUrl(finding.detail);
        htmlParts.push(`<div>${escapeHtml(safeDetail)}</div>`);
        textParts.push(`  ${safeDetail}`);
      }
    }
    htmlParts.push('</ul>');
  }

  if (view.testerNotes.length > 0) {
    htmlParts.push('<h3>Tester notes</h3><ul>');
    textParts.push('');
    textParts.push('Tester notes:');
    for (const note of view.testerNotes) {
      const safeNote = redactPotentialUrl(note);
      htmlParts.push(`<li>${escapeHtml(safeNote)}</li>`);
      textParts.push(`- ${safeNote}`);
    }
    htmlParts.push('</ul>');
  }

  if (view.technicalEvidence.length > 0) {
    htmlParts.push('<h3>Relevant technical evidence</h3><ul>');
    textParts.push('');
    textParts.push('Relevant technical evidence:');
    for (const line of view.technicalEvidence) {
      const safeLine = redactPotentialUrl(line);
      htmlParts.push(`<li>${escapeHtml(safeLine)}</li>`);
      textParts.push(`- ${safeLine}`);
    }
    htmlParts.push('</ul>');
  }

  if (view.evidence.length > 0) {
    htmlParts.push('<h3>Relevant screenshots</h3>');
    textParts.push('');
    textParts.push('Relevant screenshots:');
    for (const item of view.evidence) {
      const resolved = !item.missing ? resolveDataUrl(item.blobKey) : undefined;
      const annotationLine = item.annotationLines.length > 0
        ? `Annotations: ${item.annotationLines.join(' | ')}`
        : undefined;
      const stepTitle = `Step ${item.stepIndex}`;
      const evidenceRole = item.label.replace(/^Step\s+\d+\s+—\s+/i, '').trim();
      const captionRole = evidenceRole && evidenceRole !== `Step ${item.stepIndex}` ? evidenceRole : '';
      const textLabel = captionRole
        ? `${stepTitle} — ${captionRole}${annotationLine ? ` — ${annotationLine}` : ''}`
        : `${stepTitle}${annotationLine ? ` — ${annotationLine}` : ''}`;


      if (resolved) {
        resolvedImageCount += 1;
        const size = computeEvidenceDisplaySize(item);
        const dimensionAttrs = ` width="${size.width}" height="${size.height}"`;
        const dimensionStyle = size.hasIntrinsic
          ? `width: ${size.width}px; height: ${size.height}px;`
          : `width: ${TARGET_IMAGE_WIDTH_PX}px; height: ${TARGET_IMAGE_HEIGHT_PX}px;`;

        htmlParts.push('<div style="margin: 0 0 14px 0;">');
        htmlParts.push(`<p style="margin: 0 0 4px 0;"><strong>${escapeHtml(stepTitle)}</strong></p>`);
        if (captionRole) {
          htmlParts.push(`<p style="margin: 0 0 6px 0; font-size: 12px; color: #57606a;"><strong>${escapeHtml(captionRole)}</strong></p>`);
        }
        htmlParts.push(`<img src="${escapeHtml(resolved)}" alt="${escapeHtml(item.label)}"${dimensionAttrs} style="${dimensionStyle} max-width: ${TARGET_IMAGE_WIDTH_PX}px; max-height: ${TARGET_IMAGE_HEIGHT_PX}px; object-fit: contain; display: block; border: 1px solid #d0d7de; border-radius: 4px;" />`);
        if (annotationLine) htmlParts.push(`<div style="font-size: 12px; margin-top: 4px;">${escapeHtml(annotationLine)}</div>`);
        htmlParts.push('</div>');
        textParts.push(`- ${textLabel} (image attached in rich paste when supported)`);
      } else {
        missingImageCount += 1;
        htmlParts.push(`<p><strong>${escapeHtml(stepTitle)}</strong>${captionRole ? ` — ${escapeHtml(captionRole)}` : ''}: screenshot unavailable.</p>`);
        textParts.push(`- ${textLabel} (screenshot unavailable)`);
      }
    }
  }

  htmlParts.push('</div>');

  return {
    html: htmlParts.join(''),
    text: textParts.join('\n'),
    resolvedImageCount,
    missingImageCount,
  };
}

function redactPotentialUrl(input: string): string {
  return input.replace(/https?:\/\/[^\s)]+/gi, (match) => redactUrl(match));
}

function computeEvidenceDisplaySize(item: ClipboardEvidenceItem): { width: number; height: number; hasIntrinsic: boolean } {
  const intrinsicWidth = item.width;
  const intrinsicHeight = item.height;

  if (typeof intrinsicWidth !== 'number' || typeof intrinsicHeight !== 'number' || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return { width: TARGET_IMAGE_WIDTH_PX, height: TARGET_IMAGE_HEIGHT_PX, hasIntrinsic: false };
  }

  const ratio = Math.min(TARGET_IMAGE_WIDTH_PX / intrinsicWidth, TARGET_IMAGE_HEIGHT_PX / intrinsicHeight, 1);
  return {
    width: Math.max(1, Math.round(intrinsicWidth * ratio)),
    height: Math.max(1, Math.round(intrinsicHeight * ratio)),
    hasIntrinsic: true,
  };
}

