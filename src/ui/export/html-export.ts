// TestTrace HTML Export — Word/PDF quality document.
//
// Design goals:
//   - Looks like a professional Word document on screen
//   - Prints perfectly to PDF via window.print()
//   - Opens in Microsoft Word (HTML→DOC format)
//   - Each test step on its own section with screenshot + API context
//   - Self-contained: no external resources, all images inline as base64

import type { EvidenceStoredEvent, Session } from '../../core/types.js';
import type { GuidedStep, SemanticReport, IssueItem } from '../../core/semantic.js';
import { buildSemanticReport } from '../../core/semantic.js';
import { escapeHtml, isAllowedImageMimeType } from '../../core/security.js';
import { getBlob, getEventsForSession } from '../../storage/db.js';

// ─── Main export functions ────────────────────────────────────────────────────

export async function exportGuidedReportHtml(session: Session): Promise<string> {
  const events = await getEventsForSession(session.id);
  const report = buildSemanticReport(session, events);
  return generateDocHtml(report);
}

export async function exportCombinedReportHtml(sessions: Session[]): Promise<string> {
  const reports: SemanticReport[] = [];
  for (const s of sessions) {
    const events = await getEventsForSession(s.id);
    reports.push(buildSemanticReport(s, events));
  }
  return generateCombinedDocHtml(reports);
}

// ─── Screenshot loading ───────────────────────────────────────────────────────

const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + BASE64_CHUNK_SIZE)));
  }
  return btoa(binary);
}

async function screenshotToBase64(
  shot: EvidenceStoredEvent,
  cache?: Map<string, Promise<string>>,
): Promise<string> {
  if (cache) {
    const cached = cache.get(shot.blobKey);
    if (cached) return cached;
  }

  const task = (async () => {
    try {
      const blob = await getBlob(shot.blobKey);
      if (!blob || !isAllowedImageMimeType(blob.mimeType)) return '';
      const b64 = bytesToBase64(blob.data);
      return `data:${blob.mimeType};base64,${b64}`;
    } catch {
      return '';
    }
  })();

  cache?.set(shot.blobKey, task);
  return task;
}

// ─── Single session document ──────────────────────────────────────────────────

async function generateDocHtml(report: SemanticReport): Promise<string> {
  const { session, result, issues, guidedSteps, performance, apiSummary, executiveSummary } = report;
  const slaMs = (session.apiSlaSec ?? 3) * 1000;

  // Load all screenshot images
  const imgMap = new Map<string, string>();
  const imageCache = new Map<string, Promise<string>>();
  if (guidedSteps) {
    for (const step of guidedSteps) {
      const url = await screenshotToBase64(step.screenshot, imageCache);
      if (url) imgMap.set(step.screenshot.blobKey, url);
      for (const es of step.errorScreenshots) {
        const eu = await screenshotToBase64(es, imageCache);
        if (eu) imgMap.set(es.blobKey, eu);
      }
    }
  }

  const resultColors: Record<string, string> = {
    pass: '#27ae60', partial: '#e67e22', fail: '#c0392b', blocked: '#7f8c8d', in_progress: '#2980b9',
  };
  const color = resultColors[result] ?? '#7f8c8d';
  const resultLabel = { pass: 'PASS', partial: 'PARTIAL PASS', fail: 'FAIL', blocked: 'BLOCKED', in_progress: 'IN PROGRESS' }[result] ?? result.toUpperCase();

  const stepsHtml = guidedSteps ? await renderSteps(guidedSteps, imgMap, slaMs) : '';
  const issuesHtml = renderIssues(issues);
  const apiTableHtml = renderApiTable(apiSummary, slaMs);
  const perfHtml = renderPerfSummary(performance, session.apiSlaSec ?? 3);

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      lang="en">
<head>
<meta charset="UTF-8">
<meta name="Generator" content="BusinessFlow QA Reporter">
<meta name="ProgId" content="Word.Document">
<title>BusinessFlow Report — ${esc(session.testCaseName)}</title>
${docStyles(color)}
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="doc-header">
    <div class="doc-header__brand">BusinessFlow</div>
    <div class="doc-header__title">TEST EXECUTION REPORT</div>
  </div>

  <!-- Result banner -->
  <div class="result-banner" style="border-color:${color}">
    <div class="result-label" style="color:${color}">${resultLabel}</div>
    <div class="result-name">${esc(session.testCaseName)}</div>
    ${session.testCaseId ? `<div class="result-id">Test Case ID: ${esc(session.testCaseId)}</div>` : ''}
  </div>

  <!-- Test Case Info Table -->
  <table class="info-table">
    <tr><td class="info-label">Executed</td><td>${fmtDate(session.startedAt)}</td>
        <td class="info-label">Result</td><td style="color:${color};font-weight:700">${resultLabel}</td></tr>
    <tr><td class="info-label">Duration</td><td>${session.endedAt ? fmtDur(session.endedAt - session.startedAt) : '—'}</td>
        <td class="info-label">Mode</td><td style="text-transform:capitalize">${esc(session.mode)}</td></tr>
    <tr><td class="info-label">Browser</td><td>Chrome ${esc(String(session.environment.chromeVersion ?? ''))}</td>
        <td class="info-label">Platform</td><td>${esc(session.environment.platform)}</td></tr>
    <tr><td class="info-label">Viewport</td>
        <td>${session.environment.viewport ? `${session.environment.viewport.width}×${session.environment.viewport.height}` : '—'}</td>
        <td class="info-label">Timezone</td><td>${esc(session.environment.timeZone)}</td></tr>
    <tr><td class="info-label">API SLA</td><td>${session.apiSlaSec ?? 3}s threshold</td>
        <td class="info-label">Origin</td><td>${session.scopeOrigins.map((origin) => esc(origin)).join(', ')}</td></tr>
  </table>

  <!-- Executive Summary -->
  <div class="section-title">EXECUTIVE SUMMARY</div>
  <div class="summary-grid">
    <div class="summary-stat"><span class="summary-num">${report.totalApiCalls}</span><span class="summary-lbl">API Calls</span></div>
    <div class="summary-stat"><span class="summary-num" style="color:${report.failedApiCalls > 0 ? '#c0392b' : '#27ae60'}">${report.failedApiCalls}</span><span class="summary-lbl">Failures</span></div>
    <div class="summary-stat"><span class="summary-num" style="color:${performance.slaPercent < 90 ? '#e67e22' : '#27ae60'}">${performance.slaPercent}%</span><span class="summary-lbl">SLA Compliance</span></div>
    <div class="summary-stat"><span class="summary-num">${executiveSummary.screenshotCount}</span><span class="summary-lbl">Screenshots</span></div>
    <div class="summary-stat"><span class="summary-num">${report.totalScreens}</span><span class="summary-lbl">Screens</span></div>
    <div class="summary-stat"><span class="summary-num" style="color:${issues.filter(i=>i.severity==='critical'||i.severity==='high').length > 0 ? '#c0392b' : '#27ae60'}">${issues.length}</span><span class="summary-lbl">Issues Found</span></div>
  </div>

  ${issues.length > 0 ? `
  <p style="margin:8px 0 4px;font-size:12px;color:#666">
    ${issues.filter(i=>i.severity==='critical').length > 0 ? `🔴 ${issues.filter(i=>i.severity==='critical').length} Critical &nbsp;` : ''}
    ${issues.filter(i=>i.severity==='high').length > 0 ? `🟠 ${issues.filter(i=>i.severity==='high').length} High &nbsp;` : ''}
    ${issues.filter(i=>i.severity==='medium').length > 0 ? `🟡 ${issues.filter(i=>i.severity==='medium').length} Medium &nbsp;` : ''}
    ${issues.filter(i=>i.severity==='low').length > 0 ? `🔵 ${issues.filter(i=>i.severity==='low').length} Low` : ''}
  </p>` : `<p style="color:#27ae60;font-weight:600;margin:8px 0">✓ No issues found</p>`}

  ${perfHtml}

  <!-- Test Steps -->
  ${guidedSteps && guidedSteps.length > 0 ? `
  <div class="page-break"></div>
  <div class="section-title">TEST EXECUTION STEPS</div>
  <p class="section-sub">Each numbered step represents an evidence capture by the tester.</p>
  ${stepsHtml}` : ''}

  <!-- Findings -->
  ${issues.length > 0 ? `
  <div class="page-break"></div>
  ${issuesHtml}` : ''}

  <!-- Appendix: API Log -->
  <div class="page-break"></div>
  <div class="section-title">APPENDIX — API CALL LOG</div>
  ${apiTableHtml}

  <!-- Footer -->
  <div class="doc-footer">
    <div>BusinessFlow · Privacy-first QA · All data local · Nothing sent anywhere</div>
    <div>Session ID: ${session.id} · Exported ${new Date().toISOString()}</div>
  </div>

</div><!-- .page -->

<script>
// Print to PDF button
document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('print-btn');
  if (btn) btn.addEventListener('click', function() { window.print(); });
});
</script>

<!-- Print/PDF button (hidden on print) -->
<div class="no-print" style="position:fixed;bottom:20px;right:20px;display:flex;gap:8px;z-index:999">
  <button id="print-btn" onclick="window.print()" style="padding:10px 20px;background:#2c3e50;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.2)">
    🖨 Print / Save as PDF
  </button>
</div>

</body>
</html>`;
}

// ─── Step renderer ────────────────────────────────────────────────────────────

async function renderSteps(steps: GuidedStep[], imgMap: Map<string, string>, slaMs: number): Promise<string> {
  const parts: string[] = [];

  for (const step of steps) {
    const img = imgMap.get(step.screenshot.blobKey) ?? '';
    const isBaseline = step.screenshot.trigger === 'session_start';
    const hasIssue = step.hasIssue;

    parts.push(`
    <div class="step ${hasIssue ? 'step--issue' : ''}">
      <div class="step-header">
        <div class="step-num">${isBaseline ? 'BASELINE' : `STEP ${step.stepNumber - 1}`}</div>
        <div class="step-info">
          <div class="step-screen">${esc(step.screenName)}${step.sectionName ? ` › ${esc(step.sectionName)}` : ''}</div>
          ${step.precedingAction ? `<div class="step-action">Action: "${esc(step.precedingAction)}"</div>` : ''}
          ${step.note ? `<div class="step-note">📝 ${esc(step.note)}</div>` : ''}
        </div>
        <div class="step-time">${fmtTime(step.ts)}</div>
      </div>

      ${img ? `<img src="${img}" class="step-screenshot" alt="Step ${step.stepNumber} screenshot">` : '<div class="step-no-screenshot">No screenshot available</div>'}

      ${step.apisAround.length > 0 ? `
      <div class="step-apis">
        <div class="apis-label">API Activity</div>
        <table class="apis-table">
          ${step.apisAround.slice(0, 8).map((r) => `
          <tr class="${r.outcome !== 'success' ? 'api-err' : (r.durationMs ?? 0) > slaMs ? 'api-slow' : ''}">
            <td class="api-method">${r.method}</td>
            <td class="api-status">${r.statusCode ?? (r.outcome === 'network_error' ? 'ERR' : '…')}</td>
            <td class="api-path">${esc(r.path)}</td>
            <td class="api-dur">${r.durationMs ? `${Math.round(r.durationMs)}ms` : '—'}</td>
          </tr>`).join('')}
        </table>
        ${step.apisAround.length > 8 ? `<p style="font-size:10px;color:#666;margin:4px 0">+ ${step.apisAround.length - 8} more API calls</p>` : ''}
      </div>` : ''}

      ${step.uiSummary ? `<div class="step-ui">UI State: ${esc(step.uiSummary)}</div>` : ''}

      ${step.errorsInWindow.length > 0 ? `
      <div class="step-errors">
        ${step.errorsInWindow.slice(0, 3).map((e) => `
        <div class="step-error">⚠ ${esc('message' in e ? e.message : '').slice(0, 120)}</div>`).join('')}
      </div>` : ''}

      ${step.errorScreenshots.length > 0 ? `
      <div class="step-error-shots">
        <div class="apis-label">Error Evidence</div>
        ${await Promise.all(step.errorScreenshots.map(async (es) => {
          const eu = imgMap.get(es.blobKey) ?? '';
          return eu ? `<img src="${eu}" class="error-screenshot" alt="Error evidence">` : '';
        })).then((imgs) => imgs.join(''))}
      </div>` : ''}

      ${hasIssue ? `<div class="step-issue-flag">⚠ Issues detected at this step — see Findings section</div>` : ''}
    </div>`);
  }

  return parts.join('\n');
}

// ─── Findings renderer ────────────────────────────────────────────────────────

function renderIssues(issues: IssueItem[]): string {
  if (!issues.length) return '';
  const sevColor: Record<string, string> = {
    critical: '#c0392b', high: '#e67e22', medium: '#f39c12', low: '#3498db', info: '#7f8c8d',
  };
  const sevIcon: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

  return `<div class="section-title">FINDINGS</div>
  ${issues.map((iss) => `
  <div class="finding" style="border-left:4px solid ${sevColor[iss.severity] ?? '#999'}">
    <div class="finding-header">
      <span class="finding-sev" style="color:${sevColor[iss.severity] ?? '#999'}">${sevIcon[iss.severity] ?? ''} ${iss.severity.toUpperCase()}</span>
      <span class="finding-title">${esc(iss.title)}</span>
      ${iss.screen ? `<span class="finding-screen">${esc(iss.screen)}</span>` : ''}
      <span class="finding-time">${fmtTime(iss.ts)}</span>
    </div>
    <div class="finding-detail">${esc(iss.detail)}</div>
    ${iss.apiPath ? `<div class="finding-api"><code>${esc(iss.apiMethod ?? '')} ${esc(iss.apiPath)}</code>${iss.statusCode ? ` → ${iss.statusCode}` : ''}${iss.durationMs ? ` · ${Math.round(iss.durationMs)}ms` : ''}</div>` : ''}
    ${iss.actionLabel ? `<div class="finding-action">Triggered by: "${esc(iss.actionLabel)}"</div>` : ''}
  </div>`).join('')}`;
}

// ─── Performance section ──────────────────────────────────────────────────────

function renderPerfSummary(perf: SemanticReport['performance'], slaSec: number): string {
  if (!perf.vitals.length && !perf.pageTiming) return '';
  const vitalColor = (r: string) => r === 'good' ? '#27ae60' : r === 'needs-improvement' ? '#e67e22' : '#c0392b';
  return `
  <div class="section-title" style="margin-top:16px">PERFORMANCE</div>
  <div class="perf-row">
    ${perf.vitals.map((v) => `
    <div class="perf-chip" style="border-color:${vitalColor(v.rating)}">
      <span style="color:${vitalColor(v.rating)};font-weight:800">${v.name === 'CLS' ? v.value.toFixed(3) : `${Math.round(v.value)}ms`}</span>
      <span style="font-size:9px;color:#666;display:block">${v.name} · ${v.rating}</span>
    </div>`).join('')}
    <div class="perf-chip" style="border-color:${perf.slaPercent >= 95 ? '#27ae60' : '#e67e22'}">
      <span style="color:${perf.slaPercent >= 95 ? '#27ae60' : '#e67e22'};font-weight:800">${perf.slaPercent}%</span>
      <span style="font-size:9px;color:#666;display:block">SLA (${slaSec}s)</span>
    </div>
  </div>
  ${perf.pageTiming ? `<p style="font-size:11px;color:#666;margin:4px 0">TTFB: ${perf.pageTiming.ttfbMs}ms · DOMReady: ${perf.pageTiming.domContentLoadedMs}ms · Load: ${perf.pageTiming.loadEventMs}ms</p>` : ''}`;
}

// ─── API table ────────────────────────────────────────────────────────────────

function renderApiTable(summary: SemanticReport['apiSummary'], slaMs: number): string {
  return `
  <table class="api-log-table">
    <thead><tr><th>Method</th><th>Endpoint</th><th>Component</th><th>Calls</th><th>Errors</th><th>Avg</th><th>Max</th></tr></thead>
    <tbody>
      ${summary.map((e) => `
      <tr class="${e.failureCount > 0 ? 'api-err' : ''}">
        <td><code>${e.method}</code></td>
        <td style="max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10px"><code>${esc(e.path)}</code></td>
        <td style="font-size:10px;color:#666">${esc(e.component)}</td>
        <td>${e.callCount}</td>
        <td style="color:${e.failureCount > 0 ? '#c0392b' : '#27ae60'};font-weight:${e.failureCount > 0 ? '700' : '400'}">${e.failureCount || '—'}</td>
        <td style="color:${e.avgDurationMs > slaMs ? '#e67e22' : '#333'}">${Math.round(e.avgDurationMs)}ms</td>
        <td style="color:${e.maxDurationMs > slaMs * 2 ? '#c0392b' : '#333'}">${Math.round(e.maxDurationMs)}ms</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

// ─── Combined report (multiple test cases) ────────────────────────────────────

async function generateCombinedDocHtml(reports: SemanticReport[]): Promise<string> {
  const session0 = reports[0]?.session;
  if (!session0) return '';

  const totalIssues = reports.reduce((n, r) => n + r.issues.length, 0);
  const totalPassed = reports.filter((r) => r.result === 'pass').length;
  const totalFailed = reports.filter((r) => r.result === 'fail').length;

  const sections = await Promise.all(reports.map(async (r, i) => {
    const color = { pass: '#27ae60', partial: '#e67e22', fail: '#c0392b', blocked: '#7f8c8d', in_progress: '#2980b9' }[r.result] ?? '#7f8c8d';
    const label = { pass: 'PASS', partial: 'PARTIAL', fail: 'FAIL', blocked: 'BLOCKED', in_progress: 'IN PROGRESS' }[r.result] ?? r.result.toUpperCase();

    const imgMap = new Map<string, string>();
    const imageCache = new Map<string, Promise<string>>();
    if (r.guidedSteps) {
      for (const step of r.guidedSteps) {
        const url = await screenshotToBase64(step.screenshot, imageCache);
        if (url) imgMap.set(step.screenshot.blobKey, url);
      }
    }

    const stepsHtml = r.guidedSteps ? await renderSteps(r.guidedSteps, imgMap, (r.session.apiSlaSec ?? 3) * 1000) : '';

    return `
    ${i > 0 ? '<div class="page-break"></div>' : ''}
    <div class="test-case-section">
      <div class="tc-header" style="border-left:5px solid ${color}">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:20px;font-weight:900;color:${color}">${label}</span>
          <div>
            <div style="font-weight:700;font-size:16px">${esc(r.session.testCaseName)}</div>
            ${r.session.testCaseId ? `<div style="font-size:12px;color:#666">${esc(r.session.testCaseId)}</div>` : ''}
          </div>
        </div>
        <div style="font-size:11px;color:#666;margin-top:4px">
          ${fmtDate(r.session.startedAt)} · ${r.session.endedAt ? fmtDur(r.session.endedAt - r.session.startedAt) : '—'} · ${r.totalApiCalls} APIs · ${r.executiveSummary.screenshotCount} screenshots
        </div>
        ${r.issues.length > 0 ? `<div style="margin-top:6px;font-size:11px;color:#c0392b">⚠ ${r.issues.length} issue${r.issues.length !== 1 ? 's' : ''} found</div>` : `<div style="margin-top:6px;font-size:11px;color:#27ae60">✓ No issues</div>`}
      </div>

      ${stepsHtml}
      ${r.issues.length > 0 ? renderIssues(r.issues) : ''}
    </div>`;
  }));

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="en">
<head>
<meta charset="UTF-8">
<meta name="Generator" content="BusinessFlow QA Reporter">
<title>BusinessFlow — Test Suite Report</title>
${docStyles('#2c3e50')}
</head>
<body>
<div class="page">
  <div class="doc-header">
    <div class="doc-header__brand">BusinessFlow</div>
    <div class="doc-header__title">TEST SUITE EXECUTION REPORT</div>
  </div>

  <div class="suite-summary">
    <div class="suite-stat"><span class="suite-num">${reports.length}</span><span class="suite-lbl">Test Cases</span></div>
    <div class="suite-stat"><span class="suite-num" style="color:#27ae60">${totalPassed}</span><span class="suite-lbl">Passed</span></div>
    <div class="suite-stat"><span class="suite-num" style="color:#c0392b">${totalFailed}</span><span class="suite-lbl">Failed</span></div>
    <div class="suite-stat"><span class="suite-num" style="color:#e67e22">${reports.filter((r) => r.result === 'partial').length}</span><span class="suite-lbl">Partial</span></div>
    <div class="suite-stat"><span class="suite-num" style="color:#c0392b">${totalIssues}</span><span class="suite-lbl">Total Issues</span></div>
  </div>

  <table class="info-table" style="margin:12px 0">
    <tr><td class="info-label">Executed</td><td>${fmtDate(Date.now())}</td>
        <td class="info-label">Browser</td><td>Chrome ${esc(String(session0.environment.chromeVersion ?? ''))}</td></tr>
    <tr><td class="info-label">Platform</td><td>${esc(session0.environment.platform)}</td>
        <td class="info-label">Timezone</td><td>${esc(session0.environment.timeZone)}</td></tr>
  </table>

  ${sections.join('')}

  <div class="doc-footer">
    <div>BusinessFlow · Exported ${new Date().toISOString()}</div>
  </div>
</div>

<div class="no-print" style="position:fixed;bottom:20px;right:20px">
  <button onclick="window.print()" style="padding:10px 20px;background:#2c3e50;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.2)">
    🖨 Print / Save as PDF
  </button>
</div>
</body>
</html>`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function docStyles(_primaryColor: string): string {
  return `<style>
/* ── Screen: looks like a Word document ── */
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; padding: 20px; background: #e8e8e8; font-family: 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #333; line-height: 1.5; }
.page { max-width: 800px; margin: 0 auto; background: white; padding: 40px 50px; box-shadow: 0 2px 12px rgba(0,0,0,.15); min-height: 297mm; }

/* ── Print / PDF ── */
@media print {
  @page { size: A4; margin: 20mm 20mm 20mm 20mm; }
  body { background: white; padding: 0; }
  .page { box-shadow: none; padding: 0; max-width: none; }
  .no-print { display: none !important; }
  .page-break { page-break-after: always; }
  .step { page-break-inside: avoid; }
  .finding { page-break-inside: avoid; }
}

/* ── Document structure ── */
.doc-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #2c3e50; padding-bottom: 10px; margin-bottom: 20px; }
.doc-header__brand { font-size: 10pt; font-weight: 700; color: #2c3e50; letter-spacing: .1em; text-transform: uppercase; }
.doc-header__title { font-size: 10pt; color: #666; letter-spacing: .08em; text-transform: uppercase; }
.doc-footer { border-top: 1px solid #ddd; padding-top: 10px; margin-top: 30px; font-size: 9pt; color: #999; display: flex; justify-content: space-between; }

/* ── Result banner ── */
.result-banner { border: 2px solid; border-radius: 6px; padding: 16px 20px; margin-bottom: 20px; }
.result-label { font-size: 28pt; font-weight: 900; letter-spacing: -.02em; line-height: 1; }
.result-name { font-size: 16pt; font-weight: 700; margin-top: 4px; }
.result-id { font-size: 11pt; color: #666; margin-top: 2px; }

/* ── Info table ── */
.info-table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-bottom: 16px; }
.info-table td { padding: 5px 10px; border: 1px solid #e0e0e0; }
.info-label { background: #f8f8f8; font-weight: 700; width: 80px; color: #555; }

/* ── Section titles ── */
.section-title { font-size: 11pt; font-weight: 900; text-transform: uppercase; letter-spacing: .1em; color: #2c3e50; border-bottom: 2px solid #2c3e50; padding-bottom: 4px; margin: 24px 0 12px; }
.section-sub { font-size: 10pt; color: #666; margin: -8px 0 12px; }

/* ── Executive summary ── */
.summary-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.summary-stat { background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 5px; padding: 8px 14px; text-align: center; min-width: 80px; }
.summary-num { display: block; font-size: 18pt; font-weight: 800; }
.summary-lbl { font-size: 8pt; color: #666; text-transform: uppercase; letter-spacing: .05em; }

/* ── Performance ── */
.perf-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.perf-chip { padding: 8px 12px; border: 1.5px solid; border-radius: 5px; min-width: 80px; text-align: center; font-size: 14pt; }

/* ── Test steps ── */
.step { margin: 0 0 24px; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }
.step--issue { border-color: #f39c12; }
.step-header { background: #f8f8f8; padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px; border-bottom: 1px solid #e0e0e0; }
.step-num { font-size: 10pt; font-weight: 900; color: white; background: #2c3e50; padding: 4px 10px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; }
.step-info { flex: 1; }
.step-screen { font-weight: 700; font-size: 12pt; }
.step-action { font-size: 10pt; color: #666; }
.step-note { font-size: 10pt; color: #2980b9; font-style: italic; }
.step-time { font-size: 9pt; color: #999; white-space: nowrap; flex-shrink: 0; }
.step-screenshot { width: 100%; display: block; max-height: 500px; object-fit: contain; background: #f0f0f0; }
.step-no-screenshot { padding: 20px; text-align: center; color: #999; font-size: 10pt; background: #f8f8f8; }
.step-apis { padding: 8px 14px; border-top: 1px solid #e8e8e8; }
.apis-label { font-size: 9pt; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
.apis-table { width: 100%; border-collapse: collapse; font-size: 9pt; }
.apis-table td { padding: 3px 8px; border-bottom: 1px solid #f0f0f0; }
.api-method { font-weight: 700; color: #555; width: 45px; font-family: monospace; }
.api-status { width: 40px; font-family: monospace; font-weight: 700; }
.api-path { font-family: monospace; color: #555; }
.api-dur { text-align: right; width: 70px; color: #666; }
.api-err { background: rgba(192,57,43,.06); }
.api-err .api-status { color: #c0392b; }
.api-slow .api-dur { color: #e67e22; font-weight: 700; }
.step-ui { padding: 6px 14px; font-size: 10pt; color: #666; border-top: 1px solid #f0f0f0; }
.step-errors { padding: 6px 14px; border-top: 1px solid #f0f0f0; }
.step-error { font-size: 10pt; color: #c0392b; padding: 3px 0; }
.step-error-shots { padding: 8px 14px; border-top: 1px solid #f0f0f0; }
.error-screenshot { width: 100%; max-height: 250px; object-fit: contain; border: 1px solid #f39c12; border-radius: 4px; margin-top: 6px; }
.step-issue-flag { background: rgba(243,156,18,.1); border-top: 1px solid #f39c12; padding: 6px 14px; font-size: 10pt; color: #e67e22; font-weight: 600; }

/* ── Findings ── */
.finding { margin-bottom: 12px; border: 1px solid #ddd; border-radius: 5px; overflow: hidden; }
.finding-header { padding: 8px 12px; background: #f8f8f8; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid #e0e0e0; }
.finding-sev { font-weight: 800; font-size: 10pt; min-width: 80px; }
.finding-title { font-weight: 600; flex: 1; font-size: 11pt; }
.finding-screen { font-size: 9pt; background: #e8e8e8; padding: 2px 6px; border-radius: 3px; }
.finding-time { font-size: 9pt; color: #999; white-space: nowrap; }
.finding-detail { padding: 8px 12px; font-size: 10pt; color: #555; }
.finding-api { padding: 4px 12px 8px; font-size: 10pt; }
.finding-api code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
.finding-action { padding: 0 12px 8px; font-size: 10pt; color: #666; }

/* ── API log table ── */
.api-log-table { width: 100%; border-collapse: collapse; font-size: 9pt; }
.api-log-table th { background: #2c3e50; color: white; padding: 7px 10px; text-align: left; font-weight: 700; text-transform: uppercase; font-size: 8pt; letter-spacing: .05em; }
.api-log-table td { padding: 5px 10px; border-bottom: 1px solid #f0f0f0; }
.api-log-table tbody tr:nth-child(even) td { background: #fafafa; }
.api-log-table .api-err td { background: rgba(192,57,43,.05); }

/* ── Suite ── */
.suite-summary { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
.suite-stat { background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 5px; padding: 10px 16px; text-align: center; min-width: 90px; }
.suite-num { display: block; font-size: 22pt; font-weight: 800; }
.suite-lbl { font-size: 8pt; color: #666; text-transform: uppercase; letter-spacing: .05em; }
.test-case-section { margin-bottom: 24px; }
.tc-header { padding: 14px 16px; border-left: 5px solid; background: #fafafa; border-radius: 4px; margin-bottom: 16px; }

/* ── Utilities ── */
.page-break { page-break-after: always; height: 1px; }
code { font-family: 'Consolas', 'Courier New', monospace; }
</style>`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(s: string | undefined): string {
  return escapeHtml(s);
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export interface EvidenceFlowExportStep {
  stepId: string;
  stepIndex: number;
  label: string;
  note: string;
  issuePills: string[];
  networkFailures: Array<{ method: string; url: string; statusCode: number | 'error'; durationMs?: number }>;
  consoleErrors: string[];
  afterEvidenceEventId?: string;
  beforeEvidenceEventId?: string;
}

export interface EvidenceFlowExportDraft {
  sessionId: string;
  testStatus: 'pass' | 'fail' | 'blocked';
  summary: { totalDuration: string; totalCapturedSteps: number; totalDetectedIssues: number };
  steps: EvidenceFlowExportStep[];
}

export async function exportEvidenceFlowReportHtml(session: Session, draft: EvidenceFlowExportDraft): Promise<string> {
  const events = await getEventsForSession(session.id);
  const allEvidence = events.filter((e): e is EvidenceStoredEvent => e.kind === 'evidence_stored');
  const evidenceById = new Map(allEvidence.map((e) => [e.id, e]));

  const imageCache = new Map<string, Promise<string>>();
  const stepHtml = await Promise.all(draft.steps.map(async (step) => {
    const shot = resolveStepScreenshot(step, evidenceById, allEvidence);
    const img = shot ? await screenshotToBase64(shot, imageCache) : '';
    const networkRows = step.networkFailures.map((n) => `<tr><td>${esc(n.method)}</td><td title="${esc(n.url)}">${esc(n.url)}</td><td>${esc(String(n.statusCode))}</td><td>${typeof n.durationMs === 'number' ? `${Math.round(n.durationMs)}ms` : 'n/a'}</td></tr>`).join('');
    const errRows = step.consoleErrors.map((msg) => `<li>${esc(msg)}</li>`).join('');
    return `<article class="step-block"><div class="step-head"><div><div class="step-num">Step ${step.stepIndex}</div><div class="step-label">${esc(step.label)}</div><div class="step-note">QA Note: ${esc(step.note || 'None')}</div></div></div>${img ? `<img class="step-shot" src="${img}" alt="Step ${step.stepIndex} evidence frame" />` : '<div class="step-shot-empty">No screenshot available</div>'}<div class="pill-row">${step.issuePills.length ? step.issuePills.map((p) => `<span class="pill pill-warn">${esc(p)}</span>`).join('') : '<span class="pill pill-ok">No issues detected</span>'}</div><details class="tech-details"><summary>Technical Context</summary><div class="tech-details__content"><div class="tech-details__title">Network Failures</div>${networkRows ? `<table class="tech-table"><thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th></tr></thead><tbody>${networkRows}</tbody></table>` : '<div class="tech-empty">None</div>'}<div class="tech-details__title">Console Errors</div>${errRows ? `<ul class="tech-errors">${errRows}</ul>` : '<div class="tech-empty">None</div>'}</div></details></article>`;
  }));

  return `<!doctype html><html><head><meta charset="utf-8" /><title>EvidenceFlow Report</title><style>${OFFLINE_REPORT_CSS}</style></head><body><main class="workspace-shell"><header class="ws-header"><div><h1>EvidenceFlow Report</h1><p>Standalone offline artifact</p></div><div class="status-chip status-${esc(draft.testStatus)}">Test Status: ${esc(draft.testStatus.toUpperCase())}</div></header><section class="summary-card"><h2>Executive Summary</h2><div class="summary-grid"><div><span>${esc(draft.summary.totalDuration)}</span><small>Total Duration</small></div><div><span>${draft.summary.totalCapturedSteps}</span><small>Total Captured Steps</small></div><div><span>${draft.summary.totalDetectedIssues}</span><small>Total Detected Issues</small></div></div><div class="meta-row">Session: ${esc(session.testCaseName)} · Exported: ${esc(fmtDate(Date.now()))}</div></section><section class="evidence-section"><h2>Test Evidence</h2>${stepHtml.join('')}</section></main></body></html>`;
}

function resolveStepScreenshot(
  step: EvidenceFlowExportStep,
  evidenceById: Map<string, EvidenceStoredEvent>,
  allEvidence: EvidenceStoredEvent[],
): EvidenceStoredEvent | undefined {
  const explicitAfter = step.afterEvidenceEventId ? evidenceById.get(step.afterEvidenceEventId) : undefined;
  if (explicitAfter) return explicitAfter;

  const explicitBefore = step.beforeEvidenceEventId ? evidenceById.get(step.beforeEvidenceEventId) : undefined;
  if (explicitBefore) return explicitBefore;

  const linkedAfter = allEvidence.find((e) => e.stepId === step.stepId && e.stepFrame === 'after');
  if (linkedAfter) return linkedAfter;

  const linkedBefore = allEvidence.find((e) => e.stepId === step.stepId && e.stepFrame === 'before');
  if (linkedBefore) return linkedBefore;

  return allEvidence.find((e) => e.stepId === step.stepId);
}

export function downloadEvidenceFlowReport(html: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `EvidenceFlow-Report-${stamp}.html` });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportBusinessFlowReportHtml(session: Session, draft: EvidenceFlowExportDraft): Promise<string> {
  return exportEvidenceFlowReportHtml(session, draft);
}

export function downloadBusinessFlowReport(html: string): void {
  downloadEvidenceFlowReport(html);
}

const OFFLINE_REPORT_CSS = `
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#202124;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.workspace-shell{max-width:1050px;margin:0 auto;padding:18px;display:flex;flex-direction:column;gap:14px}
.ws-header,.summary-card,.evidence-section{background:#fff;border:1px solid #e4e5e7;border-radius:12px;padding:14px}
.ws-header{display:flex;justify-content:space-between;align-items:center}.ws-header h1{margin:0;font-size:22px}.ws-header p{margin:3px 0 0;color:#5f6368;font-size:13px}
.status-chip{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700}.status-pass{background:#edf8ef;color:#1d6b38}.status-fail{background:#ffecec;color:#8b0000}.status-blocked{background:#fff4de;color:#8a4500}
.summary-card h2,.evidence-section h2{margin:0 0 10px;font-size:16px;text-transform:uppercase;letter-spacing:.05em;color:#1f3864}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.summary-grid>div{border:1px solid #e8eaed;border-radius:10px;padding:10px;background:#fafbfc;display:flex;flex-direction:column;gap:3px}.summary-grid span{font-size:24px;font-weight:800}.summary-grid small{font-size:11px;color:#5f6368;text-transform:uppercase}.meta-row{margin-top:10px;font-size:12px;color:#5f6368}
.step-block{border:1px solid #e6e7e9;border-radius:10px;overflow:hidden;background:#fff;margin-bottom:12px}.step-head{padding:12px;border-bottom:1px solid #eceef1;background:#fafbfc}.step-num{font-size:11px;font-weight:700;text-transform:uppercase;color:#5f6368}.step-label{font-size:16px;font-weight:700;margin-top:2px}.step-note{margin-top:4px;font-size:13px;color:#3d4148}
.step-shot{width:100%;max-height:520px;object-fit:contain;border-bottom:1px solid #eceef1;background:#f0f2f5;display:block}.step-shot-empty{min-height:220px;display:flex;align-items:center;justify-content:center;color:#7a8088;font-size:13px;background:#f8f9fb}
.pill-row{padding:10px 12px;display:flex;flex-wrap:wrap;gap:6px}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;border:1px solid transparent}.pill-ok{color:#1d6b38;background:#edf8ef;border-color:#b9e2c2}.pill-warn{color:#8b0000;background:#ffecec;border-color:#f3bbbb}
.tech-details{margin:0 12px 12px;border:1px solid #d9dde2;border-radius:10px;background:#f8fafc;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace}.tech-details>summary{cursor:pointer;padding:8px 10px;font-size:12px;font-weight:700;color:#2f3b52;list-style:none}.tech-details__content{border-top:1px solid #d9dde2;padding:8px 10px 10px;display:flex;flex-direction:column;gap:10px}.tech-details__title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#586171;font-weight:700}
.tech-empty{font-size:12px;color:#6f7785}.tech-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}.tech-table th,.tech-table td{border:1px solid #d7dbe2;padding:4px 6px;text-align:left;vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tech-table th{background:#eef2f7}.tech-errors{margin:0;padding:0 0 0 18px;font-size:12px;color:#2e3642;display:flex;flex-direction:column;gap:3px}
`;
