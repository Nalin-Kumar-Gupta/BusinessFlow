// Design tokens + StyleSheet for the QA Evidence PDF.
//
// Kept in a single file so typography and color decisions stay coherent.
// If a value only appears once, inline it in the component; if it appears
// twice or more, put it here.

import { StyleSheet } from '@react-pdf/renderer';

export const VERDICT_COLORS: Readonly<Record<string, string>> = Object.freeze({
  pass: '#0f9d58',
  partial: '#f4b400',
  fail: '#c5221f',
  blocked: '#5f6368',
  in_progress: '#1a73e8',
  draft: '#5f6368',
});

export const VERDICT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  pass: 'PASS',
  partial: 'PARTIAL PASS',
  fail: 'FAIL',
  blocked: 'BLOCKED',
  in_progress: 'IN PROGRESS',
  draft: 'DRAFT',
});

export const SEVERITY_COLORS: Readonly<Record<string, string>> = Object.freeze({
  critical: '#c5221f',
  high: '#e37400',
  medium: '#f4b400',
  low: '#1a73e8',
  info: '#5f6368',
});

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

export const EVIDENCE_FRAME_WIDTH = 220;
export const EVIDENCE_FRAME_HEIGHT = 150;

const INK = '#1f1f1f';
const INK_MUTED = '#5f6368';
const INK_SUBTLE = '#80868b';
const RULE = '#dadce0';
const RULE_LIGHT = '#e8eaed';
const PAGE_BG = '#ffffff';
const CARD_BG = '#f8f9fa';
const NOTE_BG = '#fff7e6';
const NOTE_BORDER = '#f4b400';
const BUG_BG = '#fce8e6';
const BUG_BORDER = '#c5221f';
const WARN_BG = '#f1f3f4';
const WARN_BORDER = '#5f6368';

export const styles = StyleSheet.create({
  // ─── Page shell ──────────────────────────────────────────────────
  page: {
    paddingTop: 44,
    paddingRight: 44,
    paddingBottom: 56,
    paddingLeft: 44,
    fontSize: 10,
    color: INK,
    backgroundColor: PAGE_BG,
    fontFamily: 'Helvetica',
    lineHeight: 1.4,
  },
  runningHeader: {
    position: 'absolute',
    top: 20,
    left: 44,
    right: 44,
    fontSize: 8,
    color: INK_SUBTLE,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderBottomWidth: 0.5,
    borderBottomColor: RULE_LIGHT,
    paddingBottom: 6,
  },
  runningFooter: {
    position: 'absolute',
    bottom: 20,
    left: 44,
    right: 44,
    fontSize: 8,
    color: INK_SUBTLE,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: RULE_LIGHT,
    paddingTop: 6,
  },

  // ─── Cover ───────────────────────────────────────────────────────
  brand: {
    fontSize: 10,
    fontWeight: 700,
    color: INK_MUTED,
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  reportTitle: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 18,
    color: INK,
  },
  verdictBanner: {
    borderStyle: 'solid',
    borderWidth: 1.5,
    borderRadius: 4,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 18,
    paddingRight: 18,
    marginBottom: 18,
    flexDirection: 'column',
  },
  verdictLabel: {
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  verdictTestCase: {
    fontSize: 14,
    fontWeight: 700,
    color: INK,
    marginBottom: 2,
  },
  verdictSummary: {
    fontSize: 10,
    color: INK_MUTED,
  },
  identityGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 18,
    borderStyle: 'solid',
    borderWidth: 0.5,
    borderColor: RULE,
    borderRadius: 3,
  },
  identityCell: {
    width: '50%',
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 12,
    paddingRight: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE_LIGHT,
  },
  identityLabel: {
    fontSize: 7,
    color: INK_SUBTLE,
    letterSpacing: 0.6,
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  identityValue: {
    fontSize: 10,
    color: INK,
  },

  // ─── Section headings ────────────────────────────────────────────
  sectionHeading: {
    fontSize: 14,
    fontWeight: 700,
    marginTop: 6,
    marginBottom: 8,
    color: INK,
  },
  sectionSubheading: {
    fontSize: 11,
    fontWeight: 700,
    marginTop: 10,
    marginBottom: 6,
    color: INK,
  },
  sectionDivider: {
    marginTop: 4,
    marginBottom: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
  },
  helpText: {
    fontSize: 9,
    color: INK_MUTED,
    marginBottom: 10,
  },

  // ─── Stats row ───────────────────────────────────────────────────
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 14,
  },
  statCard: {
    width: '25%',
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 10,
    paddingRight: 10,
    borderStyle: 'solid',
    borderWidth: 0.5,
    borderColor: RULE,
    marginRight: -0.5,
    marginBottom: -0.5,
    backgroundColor: CARD_BG,
  },
  statLabel: {
    fontSize: 7,
    color: INK_SUBTLE,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 14,
    fontWeight: 700,
    color: INK,
  },

  // ─── Step block ──────────────────────────────────────────────────
  stepBlock: {
    marginBottom: 22,
  },
  stepHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
    paddingBottom: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE_LIGHT,
  },
  stepTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: INK,
    flexShrink: 1,
  },
  stepMeta: {
    fontSize: 8,
    color: INK_SUBTLE,
    textAlign: 'right',
  },
  stepAction: {
    fontSize: 10,
    color: INK,
    marginBottom: 6,
  },
  stepUrl: {
    fontSize: 8,
    color: INK_SUBTLE,
    marginBottom: 8,
  },
  stepBadge: {
    fontSize: 8,
    fontWeight: 700,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 6,
    paddingRight: 6,
    borderRadius: 2,
    marginRight: 4,
    color: '#ffffff',
  },
  noChangeCallout: {
    fontSize: 9,
    fontStyle: 'italic',
    color: INK_MUTED,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    marginBottom: 8,
    backgroundColor: CARD_BG,
    borderLeftWidth: 2,
    borderLeftColor: INK_SUBTLE,
  },

  // ─── Screenshot ──────────────────────────────────────────────────
  screenshotRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  screenshotCard: {
    flexGrow: 1,
    flexBasis: 0,
    marginRight: 8,
    padding: 6,
    borderStyle: 'solid',
    borderWidth: 0.5,
    borderColor: RULE,
    backgroundColor: CARD_BG,
  },
  screenshotCardLast: {
    marginRight: 0,
  },
  screenshotCaption: {
    fontSize: 7,
    color: INK_SUBTLE,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  screenshotFrame: {
    position: 'relative',
    width: EVIDENCE_FRAME_WIDTH,
    height: EVIDENCE_FRAME_HEIGHT,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  screenshotImage: {
    width: EVIDENCE_FRAME_WIDTH,
    height: EVIDENCE_FRAME_HEIGHT,
    objectFit: 'contain',
  },
  screenshotMissing: {
    width: EVIDENCE_FRAME_WIDTH,
    height: EVIDENCE_FRAME_HEIGHT,
    borderStyle: 'dashed',
    borderWidth: 0.5,
    borderColor: RULE,
    backgroundColor: '#fafafa',
    color: INK_MUTED,
    fontSize: 9,
    textAlign: 'center',
    paddingTop: 65,
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  pin: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#c5221f',
    color: '#ffffff',
    fontSize: 9,
    fontWeight: 700,
    textAlign: 'center',
    paddingTop: 3,
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: '#ffffff',
  },
  pinNote: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#1a73e8',
    color: '#ffffff',
    fontSize: 9,
    fontWeight: 700,
    textAlign: 'center',
    paddingTop: 3,
    borderStyle: 'solid',
    borderWidth: 1,
    borderColor: '#ffffff',
  },
  highlightRect: {
    position: 'absolute',
    borderStyle: 'solid',
    borderWidth: 1.5,
    borderColor: '#e53935',
    backgroundColor: 'rgba(229,57,53,0.08)',
  },

  annotationLegend: {
    marginTop: 6,
    fontSize: 8,
    color: INK_MUTED,
  },
  legendLine: {
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  legendMarker: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 6,
    color: '#ffffff',
    textAlign: 'center',
    fontSize: 7,
    fontWeight: 700,
    paddingTop: 2,
  },

  // ─── Notes & bugs ────────────────────────────────────────────────
  testerBlock: {
    marginTop: 6,
    marginBottom: 6,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    borderLeftWidth: 2,
  },
  noteBlock: {
    backgroundColor: NOTE_BG,
    borderLeftColor: NOTE_BORDER,
  },
  bugBlock: {
    backgroundColor: BUG_BG,
    borderLeftColor: BUG_BORDER,
  },
  warningBlock: {
    backgroundColor: WARN_BG,
    borderLeftColor: WARN_BORDER,
  },
  testerBlockTitle: {
    fontSize: 8,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 3,
    color: INK_MUTED,
  },
  testerBlockText: {
    fontSize: 10,
    color: INK,
  },

  // ─── Correlated evidence ─────────────────────────────────────────
  correlatedBlock: {
    marginTop: 8,
    padding: 8,
    borderStyle: 'solid',
    borderWidth: 0.5,
    borderColor: RULE_LIGHT,
    backgroundColor: '#fafbfc',
  },
  correlatedTitle: {
    fontSize: 8,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
    color: INK_MUTED,
  },
  correlatedLine: {
    fontSize: 9,
    color: INK,
    marginBottom: 2,
  },
  correlatedLineMuted: {
    fontSize: 9,
    color: INK_MUTED,
    marginBottom: 2,
  },

  // ─── Findings ────────────────────────────────────────────────────
  findingBlock: {
    marginBottom: 10,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 12,
    paddingRight: 12,
    borderLeftWidth: 3,
    backgroundColor: CARD_BG,
  },
  findingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  findingSeverity: {
    fontSize: 8,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: '#ffffff',
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 6,
    paddingRight: 6,
    borderRadius: 2,
  },
  findingSummary: {
    fontSize: 11,
    fontWeight: 700,
    color: INK,
    marginBottom: 3,
  },
  findingDetail: {
    fontSize: 9,
    color: INK_MUTED,
  },

  // ─── Tables (appendix) ───────────────────────────────────────────
  table: {
    marginBottom: 12,
    borderStyle: 'solid',
    borderWidth: 0.5,
    borderColor: RULE,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  tableRow: {
    flexDirection: 'row',
  },
  tableHeaderRow: {
    backgroundColor: CARD_BG,
  },
  tableCell: {
    borderRightWidth: 0.5,
    borderBottomWidth: 0.5,
    borderColor: RULE,
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 6,
    paddingRight: 6,
    fontSize: 8,
  },
  tableHeaderText: {
    fontSize: 8,
    fontWeight: 700,
    color: INK_MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  tableCellMono: {
    fontFamily: 'Courier',
    fontSize: 8,
  },
  emptyState: {
    fontSize: 9,
    color: INK_MUTED,
    marginBottom: 12,
    fontStyle: 'italic',
  },

  // ─── Utility ─────────────────────────────────────────────────────
  bold: { fontWeight: 700 },
  muted: { color: INK_MUTED },
  small: { fontSize: 8 },
  tag: {
    fontSize: 7,
    fontWeight: 700,
    color: '#ffffff',
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 4,
    paddingRight: 4,
    borderRadius: 2,
    marginRight: 3,
  },
});

// Column widths for appendix tables (in %)
export const NETWORK_COLS = {
  method: '10%',
  path: '48%',
  status: '10%',
  duration: '15%',
  origin: '17%',
} as const;

export const FINDING_COLS = {
  severity: '14%',
  time: '18%',
  summary: '68%',
} as const;
