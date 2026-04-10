export const WATCHLIST_STORAGE_KEY = "car-market-monitor-watchlist";

const FALLBACK_WATCHED_AT = new Date(0).toISOString();

export function watchlistEntryKey(sourceId, externalId) {
  return JSON.stringify([String(sourceId ?? "").trim(), String(externalId ?? "").trim()]);
}

function normalizeWatchedAt(value) {
  if (typeof value !== "string" || value.trim() === "") return FALLBACK_WATCHED_AT;
  return value.trim();
}

function watchlistSortTimestamp(entry) {
  const ts = Date.parse(entry.watchedAt);
  return Number.isFinite(ts) ? ts : 0;
}

export function normalizeWatchlistEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const sourceId = String(entry.sourceId ?? entry.source_id ?? "").trim();
  const externalId = String(entry.externalId ?? entry.external_id ?? "").trim();
  if (!sourceId || !externalId) return null;
  return {
    sourceId,
    externalId,
    watchedAt: normalizeWatchedAt(entry.watchedAt ?? entry.addedAt),
  };
}

export function normalizeWatchlistEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const deduped = new Map();
  for (const rawEntry of entries) {
    const entry = normalizeWatchlistEntry(rawEntry);
    if (!entry) continue;
    const key = watchlistEntryKey(entry.sourceId, entry.externalId);
    const existing = deduped.get(key);
    if (!existing || watchlistSortTimestamp(entry) >= watchlistSortTimestamp(existing)) {
      deduped.set(key, entry);
    }
  }
  return Array.from(deduped.values()).sort((a, b) =>
    watchlistSortTimestamp(b) - watchlistSortTimestamp(a) ||
    a.sourceId.localeCompare(b.sourceId) ||
    a.externalId.localeCompare(b.externalId),
  );
}

export function parseWatchlist(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    return normalizeWatchlistEntries(entries);
  } catch {
    return [];
  }
}

export function serializeWatchlist(entries) {
  return JSON.stringify({
    version: 1,
    entries: normalizeWatchlistEntries(entries),
  });
}

export function hasWatchlistEntry(entries, sourceId, externalId) {
  const key = watchlistEntryKey(sourceId, externalId);
  return normalizeWatchlistEntries(entries).some((entry) => watchlistEntryKey(entry.sourceId, entry.externalId) === key);
}

export function upsertWatchlistEntry(entries, entry) {
  const normalized = normalizeWatchlistEntry(entry);
  if (!normalized) return normalizeWatchlistEntries(entries);
  const nextEntries = normalizeWatchlistEntries(entries).filter((item) =>
    watchlistEntryKey(item.sourceId, item.externalId) !== watchlistEntryKey(normalized.sourceId, normalized.externalId),
  );
  nextEntries.push(normalized);
  return normalizeWatchlistEntries(nextEntries);
}

export function removeWatchlistEntry(entries, sourceId, externalId) {
  const key = watchlistEntryKey(sourceId, externalId);
  return normalizeWatchlistEntries(entries).filter((entry) =>
    watchlistEntryKey(entry.sourceId, entry.externalId) !== key,
  );
}
