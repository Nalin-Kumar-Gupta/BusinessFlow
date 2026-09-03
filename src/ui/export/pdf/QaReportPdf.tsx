/** @jsxImportSource react */

import { Document, Image, Page, Text, View } from '@react-pdf/renderer';

import type {
  PdfAppendixNetworkRow,
  PdfCorrelatedLine,
  PdfEvidenceView,
  PdfFindingView,
  PdfPinView,
  PdfStat,
  PdfStepView,
  PdfViewModel,
} from './pdf-view-model.js';
import { computeFittedImageBox, mapPinToFrame, mapRectToFrame } from './annotation-geometry.js';
import { EVIDENCE_FRAME_HEIGHT, EVIDENCE_FRAME_WIDTH, NETWORK_COLS, styles } from './pdf-styles.js';

export interface QaReportPdfProps {
  readonly viewModel: PdfViewModel;
}

export function QaReportPdf({ viewModel }: QaReportPdfProps) {
  const stepChunks = chunkSteps(viewModel.steps, 6);
  const sectionChunks = (viewModel.testCaseSections ?? []).map((section) => ({
    ...section,
    chunks: chunkSteps(section.steps, 5),
  }));

  return (
    <Document>
      <Page size="A4" style={styles.page} wrap>
        <RunningChrome viewModel={viewModel} sectionLabel="Executive Summary" />
        <CoverSection viewModel={viewModel} />
        <SectionHeading title="Execution Summary" />
        <StatGrid stats={viewModel.executionStats} />

        {viewModel.featureSummary ? (
          <>
            <SectionHeading title="Feature Result Matrix" />
            <FeatureSummaryBlock viewModel={viewModel} />
          </>
        ) : null}

        <SectionHeading title="Environment" />
        <KeyValueGrid entries={viewModel.environment} />
      </Page>

      {viewModel.testCaseSections
        ? sectionChunks.flatMap((section) => section.chunks.map((chunk, chunkIndex) => (
          <Page key={`section-${section.id}-${chunkIndex}`} size="A4" style={styles.page} wrap>
            <RunningChrome viewModel={viewModel} sectionLabel="Execution Story" />
            {chunkIndex === 0 ? (
              <>
                <SectionHeading title={`Test Case — ${section.title}`} />
                <Text style={styles.helpText}>
                  <Text style={{ color: section.verdictColor, fontWeight: 700 }}>{section.verdictLabel}</Text>
                  {` · ${section.stepCount} steps · ${section.findingsCount} findings`}
                  {section.durationLabel ? ` · ${section.durationLabel}` : ''}
                </Text>
                {section.sessionId ? <Text style={styles.helpText}>Session: {section.sessionId}</Text> : null}
                <Text style={styles.helpText}>
                  Correlations below are observational and temporal only. They indicate proximity in time, not causation.
                </Text>
              </>
            ) : (
              <Text style={styles.sectionSubheading}>{`${section.title} (continued)`}</Text>
            )}
            {chunk.length > 0
              ? chunk.map((step) => <StepBlock key={step.id} step={step} />)
              : <Text style={styles.emptyState}>No steps captured for this test case.</Text>}
          </Page>
        )))
        : stepChunks.map((chunk, chunkIndex) => (
          <Page key={`steps-${chunkIndex}`} size="A4" style={styles.page} wrap>
            <RunningChrome viewModel={viewModel} sectionLabel="Execution Story" />
            {chunkIndex === 0 ? (
              <>
                <SectionHeading title="Step-by-Step Evidence" />
                <Text style={styles.helpText}>
                  Correlations below are observational and temporal only. They indicate proximity in time, not causation.
                </Text>
              </>
            ) : (
              <Text style={styles.sectionSubheading}>Step-by-Step Evidence (continued)</Text>
            )}
            {chunk.length > 0 ? (
              chunk.map((step) => <StepBlock key={step.id} step={step} />)
            ) : (
              <Text style={styles.emptyState}>No steps captured in this session.</Text>
            )}
          </Page>
        ))}

      <Page size="A4" style={styles.page} wrap>
        <RunningChrome viewModel={viewModel} sectionLabel="Findings" />
        <SectionHeading title="Observed Findings" />
        {viewModel.findings.length > 0 ? (
          viewModel.findings.map((finding) => <FindingBlock key={finding.id} finding={finding} />)
        ) : (
          <Text style={styles.emptyState}>No findings were observed for this session.</Text>
        )}
      </Page>

      <Page size="A4" style={styles.page} wrap>
        <RunningChrome viewModel={viewModel} sectionLabel="Technical Appendix" />
        <SectionHeading title="Technical Appendix" />
        <Text style={styles.helpText}>
          Detailed diagnostics for engineering follow-up. Supporting evidence only; main QA narrative is above.
        </Text>
        <AppendixSection viewModel={viewModel} />
      </Page>
    </Document>
  );
}

function chunkSteps(steps: readonly PdfStepView[], size: number): PdfStepView[][] {
  if (steps.length === 0) return [[]];
  const out: PdfStepView[][] = [];
  for (let i = 0; i < steps.length; i += size) out.push(steps.slice(i, i + size));
  return out;
}

function RunningChrome({ viewModel, sectionLabel }: { viewModel: PdfViewModel; sectionLabel: string }) {
  return (
    <>
      <View fixed style={styles.runningHeader}>
        <Text>{viewModel.cover.reportTitle}</Text>
        <Text>{sectionLabel}</Text>
      </View>
      <View fixed style={styles.runningFooter}>
        <Text>{viewModel.footer.leftText}</Text>
        <Text>{viewModel.footer.centerText}</Text>
        <Text render={({ pageNumber, totalPages }) => `${viewModel.footer.rightPrefix} ${pageNumber} / ${totalPages}`} />
      </View>
    </>
  );
}

function CoverSection({ viewModel }: { viewModel: PdfViewModel }) {
  const cover = viewModel.cover;
  return (
    <>
      <Text style={styles.brand}>{cover.brand}</Text>
      <Text style={styles.reportTitle}>{cover.reportTitle}</Text>

      <View style={[styles.verdictBanner, { borderColor: cover.verdictColor }]}>
        <Text style={[styles.verdictLabel, { color: cover.verdictColor }]}>{cover.verdictLabel}</Text>
        <Text style={styles.verdictTestCase}>{cover.testCaseName}</Text>
        <Text style={styles.verdictSummary}>{cover.verdictSummary}</Text>
      </View>

      <KeyValueGrid entries={cover.identity} />

      <Text style={styles.sectionSubheading}>At-a-Glance</Text>
      <StatGrid stats={cover.atGlance} />

      {cover.negativeAssertions.length > 0 ? (
        <View style={styles.testerBlock}>
          <Text style={styles.testerBlockTitle}>Negative Test Assertions</Text>
          {cover.negativeAssertions.map((assertion, index) => (
            <Text key={`${assertion.channelLabel}-${index}`} style={styles.testerBlockText}>
              [{assertion.channelLabel}] Expected: {assertion.expected} | Observed: {assertion.observed} | Verdict: 
              <Text style={{ color: assertion.verdictColor }}>{assertion.verdictLabel}</Text>
            </Text>
          ))}
        </View>
      ) : null}

      {cover.statusContextBanner ? (
        <View style={[styles.testerBlock, styles.warningBlock]}>
          <Text style={styles.testerBlockTitle}>Run Status Context</Text>
          <Text style={styles.testerBlockText}>{cover.statusContextBanner}</Text>
        </View>
      ) : null}

      {cover.topRisks.length > 0 ? (
        <View style={[styles.testerBlock, styles.bugBlock]}>
          <Text style={styles.testerBlockTitle}>Top Risks (Critical/High)</Text>
          {cover.topRisks.map((risk, index) => (
            <Text key={`${risk.summary}-${index}`} style={styles.testerBlockText}>
              [{risk.severityLabel}] {risk.summary}
              {risk.stepReference ? ` — ${risk.stepReference}` : ''}
            </Text>
          ))}
        </View>
      ) : null}

      {cover.negativeTestBanner ? (
        <View style={[styles.testerBlock, styles.noteBlock]}>
          <Text style={styles.testerBlockTitle}>Negative Test Context</Text>
          <Text style={styles.testerBlockText}>{cover.negativeTestBanner}</Text>
        </View>
      ) : null}

      {cover.testerNotes ? (
        <View style={[styles.testerBlock, styles.noteBlock]}>
          <Text style={styles.testerBlockTitle}>Tester Notes</Text>
          <Text style={styles.testerBlockText}>{cover.testerNotes}</Text>
        </View>
      ) : null}
    </>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <>
      <Text style={styles.sectionHeading}>{title}</Text>
      <View style={styles.sectionDivider} />
    </>
  );
}

function KeyValueGrid({ entries }: { entries: readonly { label: string; value: string }[] }) {
  if (entries.length === 0) return <Text style={styles.emptyState}>No data available.</Text>;
  return (
    <View style={styles.identityGrid}>
      {entries.map((entry, index) => (
        <View key={`${entry.label}-${index}`} style={styles.identityCell}>
          <Text style={styles.identityLabel}>{entry.label}</Text>
          <Text style={styles.identityValue}>{entry.value}</Text>
        </View>
      ))}
    </View>
  );
}

function StatGrid({ stats }: { stats: readonly PdfStat[] }) {
  if (stats.length === 0) return <Text style={styles.emptyState}>No summary stats available.</Text>;
  return (
    <View style={styles.statRow}>
      {stats.map((stat) => (
        <View key={stat.label} style={styles.statCard}>
          <Text style={styles.statLabel}>{stat.label}</Text>
          <Text style={[styles.statValue, stat.emphasized ? { color: '#c5221f' } : undefined]}>{stat.value}</Text>
        </View>
      ))}
    </View>
  );
}

function FeatureSummaryBlock({ viewModel }: { viewModel: PdfViewModel }) {
  const summary = viewModel.featureSummary;
  if (!summary) return null;

  return (
    <>
      <Text style={styles.helpText}>
        {`Test cases: ${summary.totalTestCases} · PASS ${summary.resultCounts.PASS} · FAIL ${summary.resultCounts.FAIL} · BLOCKED ${summary.resultCounts.BLOCKED}`}
      </Text>
      {summary.matrix.map((row, index) => (
        <View key={`${row.testCase}-${index}`} style={styles.identityCell}>
          <Text style={styles.identityLabel}>{row.result}</Text>
          <Text style={styles.identityValue}>{row.testCase}</Text>
          <Text style={styles.small}>{`${row.stepCount} steps · ${row.findingsCount} findings`}</Text>
        </View>
      ))}
    </>
  );
}

function StepBlock({ step }: { step: PdfStepView }) {
  return (
    <View style={styles.stepBlock} wrap={false}>
      <View style={styles.stepHeader}>
        <View>
          <Text style={styles.stepTitle}>{`${step.indexLabel} — ${step.actionLine}`}</Text>
          {step.pageUrl ? <Text style={styles.stepUrl}>{step.pageUrl}</Text> : null}
        </View>
        <View>
          <Text style={styles.stepMeta}>{step.timestampLabel}</Text>
          {step.durationLabel ? <Text style={styles.stepMeta}>{step.durationLabel}</Text> : null}
        </View>
      </View>

      <View style={{ flexDirection: 'row', marginBottom: 6 }}>
        <Text style={[styles.stepBadge, { backgroundColor: step.hasBug ? '#c5221f' : '#0f9d58' }]}>
          {step.hasBug ? 'BUGS PRESENT' : 'NO BUGS MARKED'}
        </Text>
      </View>

      {step.noVisibleChange ? (
        <Text style={styles.noChangeCallout}>No visible change detected after this action.</Text>
      ) : null}

      <View style={styles.screenshotRow}>
        <EvidenceCard evidence={step.beforeEvidence} />
        {step.afterEvidence ? <EvidenceCard evidence={step.afterEvidence} isLast /> : null}
      </View>

      {step.systemEvidence.length > 0 ? (
        <View style={styles.screenshotRow}>
          {step.systemEvidence.slice(0, 2).map((evidence, idx, arr) => (
            <EvidenceCard
              key={`${step.id}-system-${idx}`}
              evidence={evidence}
              isLast={idx === arr.length - 1}
            />
          ))}
        </View>
      ) : null}

      {step.annotationLegend.length > 0 ? (
        <View style={styles.annotationLegend}>
          {step.annotationLegend.map((entry) => (
            <View key={`${step.id}-legend-${entry.number}-${entry.target}`} style={styles.legendLine}>
              <Text style={[styles.legendMarker, { backgroundColor: entry.kind === 'bug' ? '#c5221f' : '#1a73e8' }]}>
                {entry.number}
              </Text>
              <Text>{`${entry.target.toUpperCase()} — ${entry.text}`}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {step.notes.length > 0 ? (
        <View style={[styles.testerBlock, styles.noteBlock]}>
          <Text style={styles.testerBlockTitle}>Tester Commentary</Text>
          {step.notes.map((note) => (
            <Text key={note.id} style={styles.testerBlockText}>
              {note.pinNumber ? `[${note.pinNumber}] ` : ''}
              {note.text}
            </Text>
          ))}
        </View>
      ) : null}

      {step.bugs.length > 0 ? (
        <View style={[styles.testerBlock, styles.bugBlock]}>
          <Text style={styles.testerBlockTitle}>Tester-Authored Bugs</Text>
          {step.bugs.map((bug) => (
            <Text key={bug.id} style={styles.testerBlockText}>
              {bug.pinNumber ? `[${bug.pinNumber}] ` : ''}
              {bug.description}
            </Text>
          ))}
        </View>
      ) : null}

      {step.stepFindings.length > 0 ? (
        <View style={[styles.testerBlock, styles.correlatedBlock]}>
          <Text style={styles.testerBlockTitle}>Linked Findings</Text>
          {step.stepFindings.map((finding, index) => (
            <Text key={`${step.id}-finding-${index}`} style={styles.testerBlockText}>
              [{finding.severityLabel}] {finding.summary}
            </Text>
          ))}
        </View>
      ) : null}

      {step.correlated.length > 0 ? <CorrelatedBlock lines={step.correlated} /> : null}
    </View>
  );
}

function EvidenceCard({ evidence, isLast = false }: { evidence?: PdfEvidenceView; isLast?: boolean }) {
  const cardStyle = isLast ? [styles.screenshotCard, styles.screenshotCardLast] : styles.screenshotCard;
  const fitted = computeFittedImageBox(
    EVIDENCE_FRAME_WIDTH,
    EVIDENCE_FRAME_HEIGHT,
    evidence?.imageWidthPx ?? EVIDENCE_FRAME_WIDTH,
    evidence?.imageHeightPx ?? EVIDENCE_FRAME_HEIGHT,
  );

  return (
    <View style={cardStyle}>
      <Text style={styles.screenshotCaption}>{evidence?.caption ?? 'EVIDENCE'}</Text>
      {evidence?.dataUrl ? (
        <View style={styles.screenshotFrame}>
          <Image style={styles.screenshotImage} src={evidence.dataUrl} />
          {evidence.pins.map((pin) => {
            const position = mapPinToFrame(pin.xPercent, pin.yPercent, fitted);
            if (!position) return null;
            return <PinOverlay key={`${pin.kind}-${pin.number}-${pin.xPercent}-${pin.yPercent}`} pin={pin} left={position.left} top={position.top} />;
          })}
          {(() => {
            const position = mapRectToFrame(evidence.highlightRect, fitted);
            if (!position) return null;
            return <View style={[styles.highlightRect, position]} />;
          })()}
        </View>
      ) : (
        <Text style={styles.screenshotMissing}>{missingMessage(evidence?.missingReason)}</Text>
      )}
      {(evidence?.capturedAtLabel || evidence?.dimensionsLabel) ? (
        <Text style={styles.small}>
          {[evidence.capturedAtLabel, evidence.dimensionsLabel].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
    </View>
  );
}

function PinOverlay({ pin, left, top }: { pin: PdfPinView; left: number; top: number }) {
  const base = pin.kind === 'bug' ? styles.pin : styles.pinNote;
  const safeLeft = Number.isFinite(left) ? Math.max(0, left - 9) : 0;
  const safeTop = Number.isFinite(top) ? Math.max(0, top - 9) : 0;
  return (
    <Text style={[base, { left: safeLeft, top: safeTop }]}>
      {String(pin.number)}
    </Text>
  );
}

function missingMessage(reason: PdfEvidenceView['missingReason']): string {
  switch (reason) {
    case 'not-captured':
      return 'Screenshot unavailable (not captured for this step).';
    case 'blob-lost':
      return 'Screenshot unavailable (stored blob missing).';
    case 'load-failed':
      return 'Screenshot unavailable (failed to load blob).';
    default:
      return 'Screenshot unavailable.';
  }
}

function CorrelatedBlock({ lines }: { lines: readonly PdfCorrelatedLine[] }) {
  return (
    <View style={styles.correlatedBlock}>
      <Text style={styles.correlatedTitle}>Correlated Technical Evidence (Temporal)</Text>
      {lines.map((line, idx) => (
        <Text
          key={`${line.text}-${idx}`}
          style={line.severity === 'critical' ? styles.correlatedLine : styles.correlatedLineMuted}
        >
          • {line.text}
        </Text>
      ))}
    </View>
  );
}

function FindingBlock({ finding }: { finding: PdfFindingView }) {
  return (
    <View style={[styles.findingBlock, { borderLeftColor: finding.severityColor }]}>
      <View style={styles.findingHeader}>
        <Text style={styles.findingSummary}>{finding.summary}</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.findingSeverity, { backgroundColor: finding.severityColor }]}>{finding.severityLabel}</Text>
          <Text style={styles.correlatedLineMuted}>{finding.dispositionLabel}</Text>
        </View>
      </View>
      <Text style={styles.findingDetail}>{finding.timestampLabel}</Text>
      {finding.stepReference ? <Text style={styles.findingDetail}>{finding.stepReference}</Text> : null}
      {finding.detail ? <Text style={styles.findingDetail}>{finding.detail}</Text> : null}
      {finding.testerNote ? <Text style={styles.findingDetail}>Tester note: {finding.testerNote}</Text> : null}
      {finding.temporalNote ? <Text style={styles.findingDetail}>{finding.temporalNote}</Text> : null}
    </View>
  );
}

function AppendixSection({ viewModel }: { viewModel: PdfViewModel }) {
  const appendix = viewModel.appendix;

  return (
    <>
      <Text style={styles.sectionSubheading}>Network Requests</Text>
      <NetworkTable rows={appendix.network} />

      <Text style={styles.sectionSubheading}>Console Warnings</Text>
      {appendix.consoleWarnings.length > 0 ? (
        appendix.consoleWarnings.map((row, idx) => (
          <Text key={`${row.timestampLabel}-${idx}`} style={styles.correlatedLineMuted}>
            • {row.timestampLabel} — {row.message}
          </Text>
        ))
      ) : (
        <Text style={styles.emptyState}>No console warnings recorded.</Text>
      )}

      <Text style={styles.sectionSubheading}>Navigation History</Text>
      {appendix.navigationHistory.length > 0 ? (
        appendix.navigationHistory.map((nav, idx) => (
          <Text key={`${nav.timestampLabel}-${idx}`} style={styles.correlatedLineMuted}>
            • {nav.timestampLabel} — {nav.kind === 'route' ? 'Route change' : 'Navigation'} to {nav.url}
          </Text>
        ))
      ) : (
        <Text style={styles.emptyState}>No navigation events recorded.</Text>
      )}

      <Text style={styles.sectionSubheading}>Web Vitals</Text>
      <KeyValueGrid entries={appendix.webVitals} />

      <Text style={styles.sectionSubheading}>Checkpoints</Text>
      <KeyValueGrid entries={appendix.checkpoints} />

      {appendix.negativeInference ? (
        <>
          <Text style={styles.sectionSubheading}>Negative Inference</Text>
          <Text style={styles.correlatedLineMuted}>Confidence: {appendix.negativeInference.confidenceLabel}</Text>
          {appendix.negativeInference.signals.map((signal, idx) => (
            <Text key={`${signal}-${idx}`} style={styles.correlatedLineMuted}>• {signal}</Text>
          ))}
          {appendix.negativeInference.testerVerdict ? (
            <Text style={styles.correlatedLineMuted}>Tester verdict: {appendix.negativeInference.testerVerdict}</Text>
          ) : null}
        </>
      ) : null}

      <Text style={styles.sectionSubheading}>Capture Timeline</Text>
      <Text style={styles.correlatedLineMuted}>Pauses: {appendix.captureTimeline.pauses}</Text>
      <Text style={styles.correlatedLineMuted}>Resumes: {appendix.captureTimeline.resumes}</Text>
    </>
  );
}

function NetworkTable({ rows }: { rows: readonly PdfAppendixNetworkRow[] }) {
  if (rows.length === 0) return <Text style={styles.emptyState}>No network requests recorded.</Text>;

  const MAX_APPENDIX_NETWORK_ROWS = 120;
  const visibleRows = rows.slice(0, MAX_APPENDIX_NETWORK_ROWS);

  return (
    <View>
      {rows.length > visibleRows.length ? (
        <Text style={styles.small}>
          Showing first {visibleRows.length} of {rows.length} network rows in PDF appendix to keep export stable.
          Full network detail remains available in HTML export.
        </Text>
      ) : null}
      <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeaderRow]}>
        <View style={[styles.tableCell, { width: NETWORK_COLS.method }]}><Text style={styles.tableHeaderText}>Method</Text></View>
        <View style={[styles.tableCell, { width: NETWORK_COLS.path }]}><Text style={styles.tableHeaderText}>Path</Text></View>
        <View style={[styles.tableCell, { width: NETWORK_COLS.status }]}><Text style={styles.tableHeaderText}>Status</Text></View>
        <View style={[styles.tableCell, { width: NETWORK_COLS.duration }]}><Text style={styles.tableHeaderText}>Duration</Text></View>
        <View style={[styles.tableCell, { width: NETWORK_COLS.origin }]}><Text style={styles.tableHeaderText}>Origin</Text></View>
      </View>
      {visibleRows.map((row, index) => (
        <View key={`${row.method}-${row.path}-${index}`} style={styles.tableRow}>
          <View style={[styles.tableCell, { width: NETWORK_COLS.method }]}><Text>{row.method}</Text></View>
          <View style={[styles.tableCell, { width: NETWORK_COLS.path }]}><Text>{row.path}</Text></View>
          <View style={[styles.tableCell, { width: NETWORK_COLS.status }]}>
            <Text style={row.isFailed ? { color: '#c5221f' } : undefined}>{row.status}</Text>
          </View>
          <View style={[styles.tableCell, { width: NETWORK_COLS.duration }]}>
            <Text style={row.isSlow ? { color: '#e37400' } : undefined}>{row.duration}</Text>
          </View>
          <View style={[styles.tableCell, { width: NETWORK_COLS.origin }]}><Text>{row.origin}</Text></View>
        </View>
      ))}
    </View>
    </View>
  );
}
