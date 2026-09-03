/** Generate a crypto-random ID string. Avoids Math.random(). */
export function newId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newBlobKey(): string {
  return `blob:${newId()}`;
}

export function newSessionId(): string {
  return `sess:${newId()}`;
}

export function newEventId(): string {
  return `ev:${newId()}`;
}

export function newFindingId(): string {
  return `find:${newId()}`;
}

export function newCheckpointId(): string {
  return `cp:${newId()}`;
}

export function newStepId(): string {
  return `step:${newId()}`;
}
