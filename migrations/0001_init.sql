PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  name TEXT,
  url TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  last_success_at TEXT
);

-- One row per scrape pass for a source. Each row is written atomically at
-- the end of the pass — there are no intermediate states (no DISCOVERING /
-- PROCESSING / FINALIZING) because the whole pass runs inside a single
-- better-sqlite3 transaction. If the process dies mid-pass, the row simply
-- never gets inserted, and the next workflow run starts cleanly.
CREATE TABLE IF NOT EXISTS scrape_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  reported_total_count INTEGER,
  raw_row_count INTEGER,
  unique_row_count INTEGER,
  detail_success_count INTEGER NOT NULL DEFAULT 0,
  detail_failed_count INTEGER NOT NULL DEFAULT 0,
  new_listings_count INTEGER NOT NULL DEFAULT 0,
  changed_listings_count INTEGER NOT NULL DEFAULT 0,
  unchanged_listings_count INTEGER NOT NULL DEFAULT 0,
  removed_listings_count INTEGER NOT NULL DEFAULT 0,
  reactivated_listings_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  listing_url TEXT NOT NULL,
  title TEXT,
  seller_type TEXT,
  current_status TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_snapshot_id TEXT,
  last_snapshot_hash TEXT,
  last_price_amount TEXT,
  last_mileage TEXT,
  last_year TEXT,
  -- Hysteresis dla wykrywania zniknięć: zamiast flipować is_active na 0
  -- po pierwszym nietrafionym scanie, bumpujemy ten licznik i flipujemy
  -- dopiero po MISSING_THRESHOLD kolejnych miss'ach (patrz scrape.js).
  missed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, external_id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  title TEXT,
  price_amount TEXT,
  mileage TEXT,
  year TEXT,
  description_text TEXT,
  payload_json TEXT NOT NULL,
  field_map_json TEXT NOT NULL,
  UNIQUE (listing_id, run_id),
  FOREIGN KEY (listing_id) REFERENCES listings(id),
  FOREIGN KEY (run_id) REFERENCES scrape_runs(id)
);

CREATE TABLE IF NOT EXISTS listing_changes (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id TEXT,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id),
  FOREIGN KEY (run_id) REFERENCES scrape_runs(id),
  FOREIGN KEY (snapshot_id) REFERENCES listing_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_sources_active ON sources(is_active);
CREATE INDEX IF NOT EXISTS idx_runs_source_started ON scrape_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_source_active ON listings(source_id, is_active);
CREATE INDEX IF NOT EXISTS idx_snapshots_listing_captured ON listing_snapshots(listing_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_listing_created ON listing_changes(listing_id, created_at DESC);
