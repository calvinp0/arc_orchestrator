export type CacheWindow = {
  index: number;
  id?: string | null;
};

const normalizeId = (id?: string | null): string => (id ?? "").trim();

export const buildWindowCacheKey = (
  scope: string,
  sessionName: string,
  index: number,
  id?: string | null,
): string => {
  const normalized = normalizeId(id);
  const base = normalized.length ? `id:${normalized}` : `idx:${index}`;
  return `${scope}/${sessionName}/${base}`;
};

export function pruneWindowCache<T>(
  cache: Map<string, T>,
  scope: string,
  sessionName: string,
  windows: CacheWindow[],
): void {
  const prefix = `${scope}/${sessionName}/`;
  const keep = new Set(windows.map((w) => buildWindowCacheKey(scope, sessionName, w.index, w.id ?? null)));
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix) && !keep.has(key)) {
      cache.delete(key);
    }
  }
}

export function clearWindowCacheForSession<T>(
  cache: Map<string, T>,
  scope: string,
  sessionName: string,
): void {
  const prefix = `${scope}/${sessionName}/`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export function renameSessionInCache<T>(
  cache: Map<string, T>,
  scope: string,
  oldSession: string,
  newSession: string,
): void {
  if (oldSession === newSession) return;
  const oldPrefix = `${scope}/${oldSession}/`;
  const newPrefix = `${scope}/${newSession}/`;
  const updates: Array<{ oldKey: string; newKey: string; value: T }> = [];
  for (const [key, value] of cache.entries()) {
    if (key.startsWith(oldPrefix)) {
      updates.push({ oldKey: key, newKey: `${newPrefix}${key.slice(oldPrefix.length)}`, value });
    }
  }
  for (const { oldKey } of updates) {
    cache.delete(oldKey);
  }
  for (const { newKey, value } of updates) {
    cache.set(newKey, value);
  }
}
