// Pure step helpers — chrome-free so they can be used from any layer
// (dashboard UI, export projection, tests). Extracted from the dashboard
// so the export projection and the dashboard read the same authority.

import type { Step, StepBug, StepNote } from './types.js';

/**
 * Human label precedence for a Step.
 *
 * Order (highest wins):
 *   1. customLabel        — tester renamed the step
 *   2. semanticLabel      — content/step-engine guess
 *   3. labelOverride      — tester overrode the auto label from the report
 *   4. label              — original auto-generated label
 *   5. `Step N`           — deterministic fallback
 *
 * This mirrors the historical dashboard behavior. Do NOT reorder without
 * updating the corresponding tests and the export projection.
 */
export function stepLabel(step: Step): string {
  return (
    step.customLabel ||
    step.semanticLabel ||
    step.labelOverride ||
    step.label ||
    `Step ${step.index}`
  );
}

/**
 * Normalize a Step's bug annotations into a single canonical list.
 *
 * Sessions predating the `bugs[]` field may still expose `isBug` +
 * `bugDescription`. This function collapses both shapes into `StepBug[]`
 * so downstream code never has to branch on schema age.
 */
export function normalizeStepBugs(step: Step): StepBug[] {
  if (Array.isArray(step.bugs)) {
    return step.bugs
      .filter((bug): bug is StepBug => Boolean(bug && typeof bug.id === 'string'))
      .map((bug) => ({
        id: bug.id,
        description: bug.description ?? '',
        ...(bug.pin ? { pin: bug.pin } : {}),
      }));
  }
  if (step.isBug) {
    return [{ id: 'legacy', description: step.bugDescription ?? '' }];
  }
  return [];
}

/**
 * Normalize a Step's tester notes. Same shape story as bugs: modern
 * sessions use `qaNotes[]`, older ones stored a single `qaNote` string.
 */
export function normalizeStepNotes(step: Step): StepNote[] {
  if (Array.isArray(step.qaNotes)) {
    return step.qaNotes
      .filter((note): note is StepNote => Boolean(note && typeof note.id === 'string'))
      .map((note) => ({
        id: note.id,
        text: note.text ?? '',
        ...(note.pin ? { pin: note.pin } : {}),
      }));
  }
  if (step.qaNote) {
    return [{ id: 'legacy', text: step.qaNote }];
  }
  return [];
}
