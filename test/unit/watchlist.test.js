import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasWatchlistEntry,
  parseWatchlist,
  removeWatchlistEntry,
  serializeWatchlist,
  upsertWatchlistEntry,
  watchlistEntryKey,
} from "../../web/watchlist.js";

test("parseWatchlist normalizes wrapped payload and keeps newest duplicate entry", () => {
  const entries = parseWatchlist(JSON.stringify({
    version: 1,
    entries: [
      { sourceId: "otomoto", externalId: "123", watchedAt: "2026-04-09T10:00:00.000Z" },
      { source_id: "otomoto", external_id: "123", watchedAt: "2026-04-10T11:00:00.000Z" },
      { sourceId: "otomoto", externalId: "456", watchedAt: "2026-04-08T09:00:00.000Z" },
      { sourceId: "", externalId: "broken", watchedAt: "2026-04-10T11:00:00.000Z" },
    ],
  }));

  assert.deepEqual(entries, [
    { sourceId: "otomoto", externalId: "123", watchedAt: "2026-04-10T11:00:00.000Z" },
    { sourceId: "otomoto", externalId: "456", watchedAt: "2026-04-08T09:00:00.000Z" },
  ]);
});

test("upsert and remove watchlist entries work on source_id + external_id key", () => {
  let entries = [];

  entries = upsertWatchlistEntry(entries, {
    sourceId: "otomoto",
    externalId: "123",
    watchedAt: "2026-04-09T10:00:00.000Z",
  });
  entries = upsertWatchlistEntry(entries, {
    sourceId: "olx",
    externalId: "123",
    watchedAt: "2026-04-10T10:00:00.000Z",
  });

  assert.equal(hasWatchlistEntry(entries, "otomoto", "123"), true);
  assert.equal(hasWatchlistEntry(entries, "olx", "123"), true);
  assert.equal(hasWatchlistEntry(entries, "otomoto", "missing"), false);

  entries = removeWatchlistEntry(entries, "otomoto", "123");

  assert.equal(hasWatchlistEntry(entries, "otomoto", "123"), false);
  assert.equal(hasWatchlistEntry(entries, "olx", "123"), true);
});

test("serializeWatchlist emits normalized wrapped payload", () => {
  const raw = serializeWatchlist([
    { sourceId: "otomoto", externalId: "123", watchedAt: "2026-04-09T10:00:00.000Z" },
  ]);
  const parsed = JSON.parse(raw);

  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.entries, [
    { sourceId: "otomoto", externalId: "123", watchedAt: "2026-04-09T10:00:00.000Z" },
  ]);
  assert.equal(watchlistEntryKey("otomoto", "123"), "[\"otomoto\",\"123\"]");
});
