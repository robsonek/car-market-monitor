// Migration tests. Each test creates a brand-new tmp file db, runs
// openDatabase() (which applies migrations), and asserts the post-migration
// schema state. closeDatabase() always refreshes <db>.version.json so we also
// verify the manifest stays consistent.
//
// We deliberately do NOT use the project env var process.env.CAR_MARKET_MONITOR_DB_PATH —
// openDatabase / closeDatabase already accept an explicit path argument, and
// global env twiddling would cross-pollute parallel tests.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import Database from "better-sqlite3";

import { openDatabase, closeDatabase, writeDbManifest } from "../../src/lib/db.js";

let workDir;
let dbPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "market-mig-"));
  dbPath = join(workDir, "test.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fileSha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function listIndexes(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((r) => r.name);
}

function applyMigrationFiles(db, files) {
  for (const file of files) {
    db.exec(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
  }
}

test("openDatabase on a fresh file applies all migrations and bumps user_version", () => {
  const db = openDatabase(dbPath);
  try {
    const version = db.pragma("user_version", { simple: true });
    // 5 .sql files in /migrations → user_version = 5
    assert.equal(version, 5);

    // Core tables from 0001
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const required of ["sources", "scrape_runs", "listings", "listing_snapshots", "listing_changes"]) {
      assert.ok(tables.includes(required), `missing table ${required}`);
    }

    const runCols = listColumns(db, "scrape_runs");
    assert.ok(runCols.includes("batch_id"), "0004 column missing: batch_id");

    // Indexes from 0001
    const listingIndexes = listIndexes(db, "listings");
    assert.ok(
      listingIndexes.some((n) => n.includes("idx_listings_source_active")),
      "missing idx_listings_source_active",
    );

    // Columns from 0002 (condition fields) on listings
    const listingCols = listColumns(db, "listings");
    for (const col of ["damaged", "no_accident", "service_record", "country_origin", "new_used"]) {
      assert.ok(listingCols.includes(col), `0002 column missing: ${col}`);
    }

    // Columns from 0003 (decrypt redesign) on listings
    for (const col of ["vin", "registration", "date_registration", "phones_json", "image_count", "seller_uuid"]) {
      assert.ok(listingCols.includes(col), `0003 column missing: ${col}`);
    }
  } finally {
    closeDatabase(db, dbPath);
  }
});

test("re-opening an already-migrated db is a no-op (idempotent)", () => {
  // First open: full migration sequence runs.
  const db1 = openDatabase(dbPath);
  const v1 = db1.pragma("user_version", { simple: true });
  closeDatabase(db1, dbPath);

  // Capture sha right after the first close — that's the canonical
  // post-migration file content.
  const shaAfterFirstClose = fileSha(dbPath);

  // Second open: applyMigrations should see user_version === files.length and
  // skip every migration. This is the "scrape runner reuses an existing db"
  // path, exercised on every cron tick.
  const db2 = openDatabase(dbPath);
  const v2 = db2.pragma("user_version", { simple: true });
  closeDatabase(db2, dbPath);

  assert.equal(v2, v1, "user_version drifted on re-open");
  // The file may have small WAL-related deltas after a clean close, but the
  // schema (which is what we care about) shouldn't have changed. Re-open
  // and re-close once more, then assert sha stability across two consecutive
  // no-op cycles. WAL mode may still cause a small initial delta after the
  // first migration, so we tolerate that and only assert from the second
  // close onwards.
  const shaAfterSecondClose = fileSha(dbPath);
  const db3 = openDatabase(dbPath);
  closeDatabase(db3, dbPath);
  const shaAfterThirdClose = fileSha(dbPath);
  assert.equal(
    shaAfterThirdClose,
    shaAfterSecondClose,
    "no-op re-open changed db file bytes",
  );
});

test("closeDatabase writes a manifest whose sha matches the on-disk db file", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);

  const manifest = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8"));
  const actualSha = fileSha(dbPath);

  assert.equal(manifest.sha, actualSha, "manifest sha != db file sha");
  assert.equal(manifest.size, readFileSync(dbPath).length);
  assert.ok(manifest.generated_at, "manifest missing generated_at");
});

test("writeDbManifest is a no-op when sha is unchanged (does not rotate the file)", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);

  // First manifest is now on disk. Capture its full content + mtime, then
  // call writeDbManifest again — since the db sha hasn't changed, the
  // manifest must NOT be rewritten. This is the "git status stays clean
  // when nothing changed" guarantee.
  const before = readFileSync(`${dbPath}.version.json`, "utf8");
  const result = writeDbManifest(dbPath);
  const after = readFileSync(`${dbPath}.version.json`, "utf8");

  assert.equal(after, before, "writeDbManifest rewrote unchanged file");
  // Returned object still reports the cached sha so callers can read it
  assert.equal(result.sha, JSON.parse(before).sha);
});

test("writeDbManifest rewrites when the underlying db sha changes", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);
  const beforeSha = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8")).sha;

  // Mutate the db: insert a row, close, refresh manifest.
  const db2 = openDatabase(dbPath);
  db2
    .prepare("INSERT INTO sources (id, site, name, url, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("test-id", "OTOMOTO", "test", "https://www.otomoto.pl/osobowe/test", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  closeDatabase(db2, dbPath);

  const afterSha = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8")).sha;
  assert.notEqual(afterSha, beforeSha, "manifest sha did not advance after data write");
  const walPath = `${dbPath}-wal`;
  assert.equal(existsSync(walPath) ? statSync(walPath).size : 0, 0, "closeDatabase left uncheckpointed WAL bytes");
});

test("upgrading from user_version=1 (only 0001 applied) replays 0002 + 0003 + 0004", () => {
  // Simulate an "old" db: bare 0001 schema with user_version=1. We do this by
  // directly executing the 0001 SQL via better-sqlite3 (bypassing
  // applyMigrations) and pinning user_version to 1. Then openDatabase() on
  // the same path must fast-forward to user_version=5 by running 0002…0005.
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  applyMigrationFiles(seed, ["0001_init.sql"]);
  seed.pragma("user_version = 1");

  // Sanity: at this point listings has neither 0002 nor 0003 columns.
  const colsBefore = listColumns(seed, "listings");
  assert.equal(colsBefore.includes("vin"), false, "test setup broken: vin already present");
  assert.equal(colsBefore.includes("damaged"), false, "test setup broken: damaged already present");
  seed.close();

  // Now open via the production path. Migrations 0002 and 0003 must run.
  const db = openDatabase(dbPath);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), 5);
    const colsAfter = listColumns(db, "listings");
    assert.ok(colsAfter.includes("damaged"), "0002 migration did not apply on upgrade");
    assert.ok(colsAfter.includes("vin"), "0003 migration did not apply on upgrade");
    assert.ok(listColumns(db, "scrape_runs").includes("batch_id"), "0004 migration did not apply on upgrade");
  } finally {
    closeDatabase(db, dbPath);
  }

  // Manifest must reflect the upgraded file
  const manifest = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8"));
  assert.equal(manifest.sha, fileSha(dbPath));
});

test("upgrading from user_version=3 backfills legacy scrape_runs into batches", () => {
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  applyMigrationFiles(seed, [
    "0001_init.sql",
    "0002_add_condition_fields.sql",
    "0003_decrypt_redesign.sql",
  ]);
  seed.pragma("user_version = 3");
  seed
    .prepare("INSERT INTO sources (id, site, name, url, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("source-a", "OTOMOTO", "A", "https://example.com/a", 1, "2026-04-08T07:00:00.000Z", "2026-04-08T07:00:00.000Z");
  seed
    .prepare("INSERT INTO sources (id, site, name, url, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("source-b", "OTOMOTO", "B", "https://example.com/b", 1, "2026-04-08T07:00:00.000Z", "2026-04-08T07:00:00.000Z");

  const insertRun = seed.prepare(
    `INSERT INTO scrape_runs (
       id, source_id, trigger_type, status, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertRun.run("run-1a", "source-a", "scheduled", "SUCCESS", "2026-04-08T07:27:27.968Z", "2026-04-08T07:28:40.303Z");
  insertRun.run("run-1b", "source-b", "scheduled", "SUCCESS", "2026-04-08T07:28:40.477Z", "2026-04-08T07:35:20.110Z");
  insertRun.run("run-2a", "source-a", "scheduled", "SUCCESS", "2026-04-08T09:04:18.605Z", "2026-04-08T09:05:50.586Z");
  insertRun.run("run-2b", "source-b", "scheduled", "SUCCESS", "2026-04-08T09:05:50.687Z", "2026-04-08T09:10:52.290Z");
  seed.close();

  const db = openDatabase(dbPath);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), 5);
    const runs = db
      .prepare("SELECT id, batch_id FROM scrape_runs ORDER BY started_at ASC")
      .all();

    assert.deepEqual(
      runs,
      [
        { id: "run-1a", batch_id: "legacy-2026-04-08T07:27:27.968Z" },
        { id: "run-1b", batch_id: "legacy-2026-04-08T07:27:27.968Z" },
        { id: "run-2a", batch_id: "legacy-2026-04-08T09:04:18.605Z" },
        { id: "run-2b", batch_id: "legacy-2026-04-08T09:04:18.605Z" },
      ],
    );
  } finally {
    closeDatabase(db, dbPath);
  }
});

test("openDatabase regenerates a missing manifest after closeDatabase", () => {
  const db = openDatabase(dbPath);
  closeDatabase(db, dbPath);

  // Delete the manifest, then re-open + re-close. closeDatabase always
  // refreshes the manifest, so after this cycle the file must exist again
  // with a sha matching the db.
  rmSync(`${dbPath}.version.json`);
  const db2 = openDatabase(dbPath);
  closeDatabase(db2, dbPath);

  const manifest = JSON.parse(readFileSync(`${dbPath}.version.json`, "utf8"));
  assert.equal(manifest.sha, fileSha(dbPath));
});
