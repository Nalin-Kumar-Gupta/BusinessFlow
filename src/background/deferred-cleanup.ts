import type { EvidenceStoredEvent, Step, StepBug, StepNote } from '../core/types.js';
import { getEventsForSession, getStepsForSession, putStep } from '../storage/db.js';

export interface DeferredCleanupSummary {
  scannedSteps: number;
  updatedSteps: number;
  orphanedBeforeMarked: number;
  staleAfterRemoved: number;
  droppedAfterPins: number;
}

function stripPinsWithoutAfter<T extends StepNote | StepBug>(entries: T[] | undefined): { next: T[] | undefined; removed: number } {
  if (!entries || entries.length === 0) return { next: entries, removed: 0 };
  let removed = 0;
  const next = entries.filter((entry) => {
    if (entry.pin?.target === 'after') {
      removed += 1;
      return false;
    }
    return true;
  });
  return { next, removed };
}

function shouldRemoveStaleAfter(step: Step, nextStep: Step | undefined, evidenceById: Map<string, EvidenceStoredEvent>): boolean {
  if (!step.afterEvidenceEventId || !nextStep) return false;
  const afterEv = evidenceById.get(step.afterEvidenceEventId);
  if (!afterEv) return false;

  // If next click step started before this step's after was captured,
  // treat the after as stale (superseded by a newer interaction).
  return afterEv.ts >= nextStep.ts;
}

export async function runDeferredStepCleanup(sessionId: string): Promise<DeferredCleanupSummary> {
  const [steps, events] = await Promise.all([
    getStepsForSession(sessionId),
    getEventsForSession(sessionId),
  ]);

  const orderedSteps = [...steps].sort((a, b) => a.index - b.index);
  const evidenceById = new Map<string, EvidenceStoredEvent>();
  for (const ev of events) {
    if (ev.kind === 'evidence_stored') evidenceById.set(ev.id, ev);
  }

  let updatedSteps = 0;
  let orphanedBeforeMarked = 0;
  let staleAfterRemoved = 0;
  let droppedAfterPins = 0;

  for (let i = 0; i < orderedSteps.length; i++) {
    const step = orderedSteps[i]!;
    const nextStep = orderedSteps[i + 1];

    const hasBefore = Boolean(step.beforeEvidenceEventId);
    const hasAfter = Boolean(step.afterEvidenceEventId);

    let mutated = false;
    const nextStepState: Step = { ...step };

    if (hasBefore && !hasAfter && !step.noChangeDetected) {
      nextStepState.noChangeDetected = true;
      orphanedBeforeMarked += 1;
      mutated = true;
    }

    if (shouldRemoveStaleAfter(step, nextStep, evidenceById)) {
      nextStepState.afterEvidenceEventId = undefined;
      nextStepState.noChangeDetected = true;

      const cleanedNotes = stripPinsWithoutAfter(nextStepState.qaNotes);
      const cleanedBugs = stripPinsWithoutAfter(nextStepState.bugs);
      nextStepState.qaNotes = cleanedNotes.next;
      nextStepState.bugs = cleanedBugs.next;
      droppedAfterPins += cleanedNotes.removed + cleanedBugs.removed;

      staleAfterRemoved += 1;
      mutated = true;
    }

    if (!mutated) continue;
    await putStep(nextStepState);
    updatedSteps += 1;
  }

  return {
    scannedSteps: orderedSteps.length,
    updatedSteps,
    orphanedBeforeMarked,
    staleAfterRemoved,
    droppedAfterPins,
  };
}
