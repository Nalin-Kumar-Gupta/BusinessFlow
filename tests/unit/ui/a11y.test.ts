import { describe, expect, it } from 'vitest';

import { getNextMenuIndex, isKeyboardActivationKey } from '../../../src/ui/shared/a11y.js';

describe('ui/shared/a11y', () => {
  it('recognizes keyboard activation keys', () => {
    expect(isKeyboardActivationKey('Enter')).toBe(true);
    expect(isKeyboardActivationKey(' ')).toBe(true);
    expect(isKeyboardActivationKey('Spacebar')).toBe(false);
    expect(isKeyboardActivationKey('Escape')).toBe(false);
  });

  it('calculates roving menu indices with wrap behavior', () => {
    expect(getNextMenuIndex(0, 3, 'ArrowDown')).toBe(1);
    expect(getNextMenuIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(getNextMenuIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(getNextMenuIndex(1, 3, 'Home')).toBe(0);
    expect(getNextMenuIndex(1, 3, 'End')).toBe(2);
    expect(getNextMenuIndex(1, 0, 'ArrowDown')).toBe(-1);
  });
});
