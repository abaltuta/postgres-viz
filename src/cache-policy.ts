export function graphCacheAgeSeconds(builtAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - builtAt) / 1_000));
}

export function graphCacheEntryIsFresh(
  builtAt: number,
  ttlSeconds: number,
  now = Date.now(),
): boolean {
  return (
    Number.isFinite(builtAt) &&
    Number.isFinite(ttlSeconds) &&
    ttlSeconds > 0 &&
    now >= builtAt &&
    now - builtAt <= ttlSeconds * 1_000
  );
}
