import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '../../../src/core/types.js';

const dbState: { step: Step | undefined } = { step: undefined };

vi.mock('../../../src/storage/db.js', () => ({
  appendEvent: vi.fn(async () => undefined),
  putStep: vi.fn(async (step: Step) => {
    dbState.step = { ...step };
  }),
  getStep: vi.fn(async () => dbState.step ? { ...dbState.step } : undefined),
}));

vi.mock('../../../src/storage/session-state.js', () => ({
  getActiveSessionId: vi.fn(async () => 'sess-1'),
  nextSeq: vi.fn(async () => 1),
}));

vi.mock('../../../src/background/session.js', () => ({
  incrementCounter: vi.fn(async () => undefined),
  nextStepIndex: vi.fn(async () => 1),
}));

vi.mock('../../../src/background/screenshot.js', () => ({
  requestCapture: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../../src/background/net-observer.js', () => ({
  getInFlightRequestCount: vi.fn(() => 0),
}));

import { evaluateAfterCaptureDecision } from '../../../src/background/after-capture-policy.js';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'sess-1',
    tabId: 9,
    index: 1,
    ts: Date.now(),
    seq: 1,
    label: 'Click "CTA"',
    clickEventIds: ['ev-1'],
    systemEvidenceEventIds: [],
    beforeEvidenceEventId: 'before-1',
    pageUrl: 'https://app.local/start',
    ...overrides,
  };
}

describe('evaluateAfterCaptureDecision', () => {
  beforeEach(() => {
    dbState.step = undefined;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn(() => Promise.resolve(undefined)),
      },
    };
  });

  it('captures when navigation was confirmed even if URL compare is equal', async () => {
    dbState.step = makeStep({ pageUrl: 'https://app.local/list' });

    const decision = await evaluateAfterCaptureDecision(
      'sess-1',
      'step-1',
      9,
      'https://app.local/list',
      { navConfirmed: true },
    );

    expect(decision.shouldCapture).toBe(true);
    expect(decision.reason).toBe('nav_confirmed');
  });

  it('captures on URL delta', async () => {
    dbState.step = makeStep({ pageUrl: 'https://app.local/list' });

    const decision = await evaluateAfterCaptureDecision(
      'sess-1',
      'step-1',
      9,
      'https://app.local/details?id=42',
      { navConfirmed: false, hasDomChangeSignal: false },
    );

    expect(decision.shouldCapture).toBe(true);
    expect(decision.reason).toBe('url_changed');
  });

  it('captures on same URL when dom-shift signal exists', async () => {
    dbState.step = makeStep({ pageUrl: 'https://app.local/list' });

    const decision = await evaluateAfterCaptureDecision(
      'sess-1',
      'step-1',
      9,
      'https://app.local/list',
      { navConfirmed: false, hasDomChangeSignal: true },
    );

    expect(decision.shouldCapture).toBe(true);
    expect(decision.reason).toBe('dom_shift');
  });

  it('skips and persists no-change state on same URL without signals', async () => {
    dbState.step = makeStep({ pageUrl: 'https://app.local/list' });

    const decision = await evaluateAfterCaptureDecision(
      'sess-1',
      'step-1',
      9,
      'https://app.local/list',
      { navConfirmed: false, hasDomChangeSignal: false },
    );

    expect(decision.shouldCapture).toBe(false);
    expect(decision.reason).toBe('same_url_no_change');
    expect(dbState.step?.stepState).toBe('AFTER_SKIPPED');
    expect(dbState.step?.afterDecisionReason).toBe('same_url_no_change');
    expect(dbState.step?.noChangeDetected).toBe(true);
  });

  it('does not capture when after was already stored', async () => {
    dbState.step = makeStep({ afterEvidenceEventId: 'after-1', stepState: 'AFTER_STORED' });

    const decision = await evaluateAfterCaptureDecision(
      'sess-1',
      'step-1',
      9,
      'https://app.local/list',
      { navConfirmed: false, hasDomChangeSignal: false },
    );

    expect(decision.shouldCapture).toBe(false);
    expect(decision.reason).toBe('already_after_stored');
  });
});
