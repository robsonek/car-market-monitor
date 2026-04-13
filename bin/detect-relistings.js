#!/usr/bin/env node
// Retroaktywne wykrywanie wznowionych ogloszen (relistings).
// Porownuje VIN, tablice rejestracyjne i cechy pojazdu miedzy wszystkimi
// parami ogloszen. Idempotentny - INSERT OR IGNORE nie duplikuje par.
// Filtruje fejkowe VIN-y (same cyfry, same litery, powtarzajacy sie znak, I/O/Q).

import { closeDatabase, openDatabase } from "../src/lib/db.js";
import { isValidVin, isValidRegistration } from "../src/lib/scrape.js";

const db = openDatabase();

// Upewnij sie ze tabela istnieje (dla baz sprzed migracji)
db.exec(`
  CREATE TABLE IF NOT EXISTS listing_relistings (
    id TEXT PRIMARY KEY,
    old_listing_id TEXT NOT NULL,
    new_listing_id TEXT NOT NULL,
    match_type TEXT NOT NULL,
    match_details TEXT,
    detected_at TEXT NOT NULL,
    run_id TEXT,
    UNIQUE (old_listing_id, new_listing_id),
    FOREIGN KEY (old_listing_id) REFERENCES listings(id),
    FOREIGN KEY (new_listing_id) REFERENCES listings(id)
  );
  CREATE INDEX IF NOT EXISTS idx_relistings_old ON listing_relistings(old_listing_id);
  CREATE INDEX IF NOT EXISTS idx_relistings_new ON listing_relistings(new_listing_id);
  CREATE INDEX IF NOT EXISTS idx_relistings_detected ON listing_relistings(detected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_listings_registration ON listings(registration);
`);

// Build set of valid VINs to use in SQL via a temp table
const allVins = db.prepare("SELECT DISTINCT vin FROM listings WHERE vin IS NOT NULL AND vin != ''").all();
db.exec("CREATE TEMP TABLE valid_vins (vin TEXT PRIMARY KEY)");
const insertValid = db.prepare("INSERT INTO temp.valid_vins (vin) VALUES (?)");
let validCount = 0;
let invalidCount = 0;
for (const { vin } of allVins) {
  if (isValidVin(vin)) {
    insertValid.run(vin);
    validCount++;
  } else {
    invalidCount++;
  }
}
console.log(`VINs: ${validCount} valid, ${invalidCount} invalid (filtered out)`);

// Same for registrations
const allRegs = db.prepare("SELECT DISTINCT registration FROM listings WHERE registration IS NOT NULL AND registration != ''").all();
db.exec("CREATE TEMP TABLE valid_regs (registration TEXT PRIMARY KEY)");
const insertValidReg = db.prepare("INSERT INTO temp.valid_regs (registration) VALUES (?)");
let validRegCount = 0;
let invalidRegCount = 0;
for (const { registration } of allRegs) {
  if (isValidRegistration(registration)) {
    insertValidReg.run(registration);
    validRegCount++;
  } else {
    invalidRegCount++;
  }
}
console.log(`Registrations: ${validRegCount} valid, ${invalidRegCount} invalid (filtered out)`);

const now = new Date().toISOString();

const tx = db.transaction(() => {
  // Clean out previously detected pairs based on now-invalid VINs
  const cleanedVin = db
    .prepare(
      `DELETE FROM listing_relistings
       WHERE match_type = 'vin'
         AND id IN (
           SELECT r.id FROM listing_relistings r
           JOIN listings old ON old.id = r.old_listing_id
           WHERE r.match_type = 'vin'
             AND old.vin NOT IN (SELECT vin FROM temp.valid_vins)
         )`,
    )
    .run();
  if (cleanedVin.changes > 0) {
    console.log(`Cleaned ${cleanedVin.changes} pairs matched on invalid VINs`);
  }

  // Clean out previously detected pairs based on now-invalid registrations
  const cleanedReg = db
    .prepare(
      `DELETE FROM listing_relistings
       WHERE match_type = 'registration'
         AND id IN (
           SELECT r.id FROM listing_relistings r
           JOIN listings old ON old.id = r.old_listing_id
           WHERE r.match_type = 'registration'
             AND old.registration NOT IN (SELECT registration FROM temp.valid_regs)
         )`,
    )
    .run();
  if (cleanedReg.changes > 0) {
    console.log(`Cleaned ${cleanedReg.changes} pairs matched on invalid registrations`);
  }

  // 1. VIN matches (only valid VINs)
  const vinCount = db
    .prepare(
      `INSERT OR IGNORE INTO listing_relistings
         (id, old_listing_id, new_listing_id, match_type, match_details, detected_at, run_id)
       SELECT
         lower(hex(randomblob(16))),
         old.id,
         new.id,
         'vin',
         json_object('vin', old.vin),
         ?,
         NULL
       FROM listings old
       JOIN listings new ON old.vin = new.vin
         AND old.source_id = new.source_id
         AND old.id != new.id
         AND old.first_seen_at < new.first_seen_at
       WHERE old.vin IN (SELECT vin FROM temp.valid_vins)`,
    )
    .run(now);
  console.log(`VIN matches: ${vinCount.changes} new pairs`);

  // 2. Registration matches (skip pairs already linked by VIN)
  const regCount = db
    .prepare(
      `INSERT OR IGNORE INTO listing_relistings
         (id, old_listing_id, new_listing_id, match_type, match_details, detected_at, run_id)
       SELECT
         lower(hex(randomblob(16))),
         old.id,
         new.id,
         'registration',
         json_object('registration', old.registration),
         ?,
         NULL
       FROM listings old
       JOIN listings new ON old.registration = new.registration
         AND old.source_id = new.source_id
         AND old.id != new.id
         AND old.first_seen_at < new.first_seen_at
       WHERE old.registration IN (SELECT registration FROM temp.valid_regs)
         AND NOT EXISTS (
           SELECT 1 FROM listing_relistings r
           WHERE r.old_listing_id = old.id AND r.new_listing_id = new.id
         )`,
    )
    .run(now);
  console.log(`Registration matches: ${regCount.changes} new pairs`);

  // 3. Fuzzy matches (make+model+year+seller_uuid+date_registration)
  //    - old listing must be inactive (otherwise it's just dealer inventory)
  //    - skip pairs where both have valid but different VINs (different cars)
  const fuzzyCount = db
    .prepare(
      `INSERT OR IGNORE INTO listing_relistings
         (id, old_listing_id, new_listing_id, match_type, match_details, detected_at, run_id)
       SELECT
         lower(hex(randomblob(16))),
         old.id,
         new.id,
         'fuzzy',
         json_object('make', old.make, 'model', old.model, 'year', old.year,
                      'seller_uuid', old.seller_uuid),
         ?,
         NULL
       FROM listings old
       JOIN listings new ON old.make = new.make
         AND old.model = new.model
         AND old.year = new.year
         AND old.seller_uuid = new.seller_uuid
         AND old.source_id = new.source_id
         AND old.id != new.id
         AND old.is_active = 0
         AND old.first_seen_at < new.first_seen_at
         AND (old.date_registration IS NULL OR new.date_registration IS NULL
              OR old.date_registration = new.date_registration)
       WHERE old.make IS NOT NULL AND old.model IS NOT NULL
         AND old.year IS NOT NULL AND old.seller_uuid IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM listing_relistings r
           WHERE r.old_listing_id = old.id AND r.new_listing_id = new.id
         )
         AND NOT (
           old.vin IN (SELECT vin FROM temp.valid_vins)
           AND new.vin IN (SELECT vin FROM temp.valid_vins)
           AND old.vin != new.vin
         )`,
    )
    .run(now);
  console.log(`Fuzzy matches: ${fuzzyCount.changes} new pairs`);

  const total = db.prepare(`SELECT count(*) AS cnt FROM listing_relistings`).get();
  console.log(`Total relisting pairs in database: ${total.cnt}`);
});

tx();
closeDatabase(db);
