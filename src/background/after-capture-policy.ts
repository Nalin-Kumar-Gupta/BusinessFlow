import type { Step, StepAfterDecisionReason } from '../core/types.js';
import { getStep, putStep } from '../storage/db.js';

export interface AfterDecision {
  shouldCapture: boolean;
  reason: StepAfterDecisionReason;
  step?: Step;
}

export function normalizeUrlForCompare(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).href;
  } catch {
    return url.trim() || undefined;
  }
}

async function applyAfterSkippedState(
  sessionId: string,
  tabId: number,
  step: Step,
  reason: StepAfterDecisionReason,
  beforeUrl: string | undefined,
  currentUrl: string | undefined,
): Promise<void> {
  const updated: Step = {
    ...step,
    noChangeDetected: true,
    afterEvidenceEventId: undefined,
    stepState: 'AFTER_SKIPPED',
    afterDecisionReason: reason,
  };
  await putStep(updated);

  chrome.runtime.sendMessage({
    type: 'TT_STEP_UPDATED',
    sessionId,
    stepId: step.id,
    tabId,
    phase: 'after_skipped',
    reasonCode: reason,
    beforeUrl,
    currentUrl,
  }).catch(() => {});
}

export async function markAfterQueued(stepId: string, reason: StepAfterDecisionReason): Promise<void> {
  const step = await getStep(stepId);
  if (!step || step.stepState === 'AFTER_STORED') return;
  step.stepState = 'AFTER_QUEUED';
  step.afterDecisionReason = reason;
  await putStep(step);
}

export async function evaluateAfterCaptureDecision(
  sessionId: string,
  stepId: string,
  tabId: number,
  currentUrl: string | undefined,
  options?: { navConfirmed?: boolean; hasDomChangeSignal?: boolean },
): Promise<AfterDecision> {
  const step = await getStep(stepId);
  if (!step) return { shouldCapture: true, reason: 'insufficient_signal' };

  if (step.stepState === 'AFTER_STORED' || step.afterEvidenceEventId) {
    return { shouldCapture: false, reason: 'already_after_stored', step };
  }

  if (options?.navConfirmed) {
    return { shouldCapture: true, reason: 'nav_confirmed', step };
  }

  const beforeUrl = normalizeUrlForCompare(step.pageUrl);
  const nowUrl = normalizeUrlForCompare(currentUrl);

  if (beforeUrl && nowUrl && beforeUrl !== nowUrl) {
    return { shouldCapture: true, reason: 'url_changed', step };
  }

  if (options?.hasDomChangeSignal) {
    return { shouldCapture: true, reason: 'dom_shift', step };
  }

  if (!beforeUrl || !nowUrl) {
    return { shouldCapture: true, reason: 'insufficient_signal', step };
  }

  await applyAfterSkippedState(sessionId, tabId, step, 'same_url_no_change', beforeUrl, nowUrl);
  return { shouldCapture: false, reason: 'same_url_no_change', step };
}
