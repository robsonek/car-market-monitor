export const SAVED_FILTERS_STORAGE_KEY = "car-market-monitor-saved-filters";

const FALLBACK_TIMESTAMP = new Date(0).toISOString();
const DEFAULT_NAME = "Filtr bez nazwy";
// `page` celowo pomijamy — preset ma reprezentować zestaw filtrów,
// a nie miejsce w paginacji. Wszystkie inne wartości z URL-a są prawidłowe.
const IGNORED_PARAM_KEYS = new Set(["page"]);

export function generateSavedFilterId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return FALLBACK_TIMESTAMP;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : FALLBACK_TIMESTAMP;
}

function normalizeParams(raw) {
  if (!raw || typeof raw !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || !key) continue;
    if (IGNORED_PARAM_KEYS.has(key)) continue;
    if (value == null) continue;
    const str = String(value).trim();
    if (!str) continue;
    result[key] = str;
  }
  return result;
}

function normalizeName(value) {
  if (typeof value !== "string") return DEFAULT_NAME;
  const trimmed = value.trim();
  return trimmed || DEFAULT_NAME;
}

function sortTimestamp(entry) {
  const ts = Date.parse(entry.updatedAt || entry.createdAt);
  return Number.isFinite(ts) ? ts : 0;
}

export function normalizeSavedFilterEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const createdAt = normalizeTimestamp(entry.createdAt);
  const updatedAt = normalizeTimestamp(entry.updatedAt ?? entry.createdAt);
  return {
    id,
    name: normalizeName(entry.name),
    params: normalizeParams(entry.params),
    createdAt,
    updatedAt,
  };
}

export function normalizeSavedFilters(entries) {
  if (!Array.isArray(entries)) return [];
  const deduped = new Map();
  for (const raw of entries) {
    const entry = normalizeSavedFilterEntry(raw);
    if (!entry) continue;
    const existing = deduped.get(entry.id);
    if (!existing || sortTimestamp(entry) >= sortTimestamp(existing)) {
      deduped.set(entry.id, entry);
    }
  }
  return Array.from(deduped.values()).sort((a, b) =>
    sortTimestamp(b) - sortTimestamp(a) ||
    a.name.localeCompare(b.name, "pl") ||
    a.id.localeCompare(b.id),
  );
}

export function parseSavedFilters(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    return normalizeSavedFilters(entries);
  } catch {
    return [];
  }
}

export function serializeSavedFilters(entries) {
  return JSON.stringify({
    version: 1,
    entries: normalizeSavedFilters(entries),
  });
}

export function upsertSavedFilter(entries, entry) {
  const normalized = normalizeSavedFilterEntry(entry);
  if (!normalized) return normalizeSavedFilters(entries);
  const rest = normalizeSavedFilters(entries).filter((item) => item.id !== normalized.id);
  rest.push(normalized);
  return normalizeSavedFilters(rest);
}

export function removeSavedFilter(entries, id) {
  const target = typeof id === "string" ? id.trim() : "";
  if (!target) return normalizeSavedFilters(entries);
  return normalizeSavedFilters(entries).filter((entry) => entry.id !== target);
}

export function renameSavedFilter(entries, id, newName) {
  const target = typeof id === "string" ? id.trim() : "";
  if (!target) return normalizeSavedFilters(entries);
  const nextName = normalizeName(newName);
  return normalizeSavedFilters(entries).map((entry) =>
    entry.id === target
      ? { ...entry, name: nextName, updatedAt: new Date().toISOString() }
      : entry,
  );
}

export function findSavedFilter(entries, id) {
  const target = typeof id === "string" ? id.trim() : "";
  if (!target) return null;
  return normalizeSavedFilters(entries).find((entry) => entry.id === target) || null;
}
