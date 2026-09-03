/**
 * Serializes async lifecycle mutations (start/stop/pause/resume) so callers
 * cannot race service-worker state with rapid repeated clicks.
 */
export function createLifecycleLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<void> = Promise.resolve();

  return async function withLifecycleLock<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = queue;
    queue = previous.then(() => gate);

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
