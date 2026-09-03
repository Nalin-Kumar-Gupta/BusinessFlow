import { describe, expect, it, vi } from 'vitest';

import { createLifecycleLock } from '../../../src/background/lifecycle-lock.js';

describe('createLifecycleLock', () => {
  it('runs overlapping tasks one-at-a-time in submit order', async () => {
    const withLock = createLifecycleLock();
    const order: string[] = [];

    const taskA = withLock(async () => {
      order.push('A:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('A:end');
      return 'A';
    });

    const taskB = withLock(async () => {
      order.push('B:start');
      order.push('B:end');
      return 'B';
    });

    await expect(taskA).resolves.toBe('A');
    await expect(taskB).resolves.toBe('B');
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('does not deadlock after a task throws', async () => {
    const withLock = createLifecycleLock();
    const marker = vi.fn();

    await expect(withLock(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(withLock(async () => {
      marker();
      return 42;
    })).resolves.toBe(42);

    expect(marker).toHaveBeenCalledTimes(1);
  });
});
