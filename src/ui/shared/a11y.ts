export function isKeyboardActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function getNextMenuIndex(currentIndex: number, total: number, key: string): number {
  if (total <= 0) return -1;
  if (key === 'ArrowDown') return (currentIndex + 1 + total) % total;
  if (key === 'ArrowUp') return (currentIndex - 1 + total) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return currentIndex;
}
