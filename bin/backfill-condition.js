#!/usr/bin/env node
// Jednorazowy skrypt backfillujący kolumny condition (damaged, no_accident,
// service_record, original_owner, is_imported_car, tuning, historical_vehicle,
// registered, new_used, country_origin) dla listingów które już istnieją
// w bazie. Czyta payload_json ostatniego snapshotu każdego listingu, parsuje
// parametersDict, UPDATE'uje wiersz w listings.
//
// Idempotentny: można uruchomić wiele razy, zawsze nadpisuje wartości tym
// co jest w aktualnym snapshocie. Niepotrzebny po pierwszym uruchomieniu
// (od następnego scrape pipeline sam wypełnia te kolumny).

import { closeDatabase, openDatabase } from "../src/lib/db.js";

const db = openDatabase();

const rows = db
  .prepare(
    `SELECT l.id, s.payload_json
     FROM listings l
     JOIN listing_snapshots s ON s.id = l.last_snapshot_id`,
  )
  .all();

console.log(`backfilling ${rows.length} listings...`);

const update = db.prepare(
  `UPDATE listings SET
     damaged = ?, no_accident = ?, service_record = ?, original_owner = ?,
     is_imported_car = ?, tuning = ?, historical_vehicle = ?, registered = ?,
     new_used = ?, country_origin = ?
   WHERE id = ?`,
);

function yesNo(v) {
  if (v === "Tak") return 1;
  if (v === "Nie") return 0;
  return null;
}

function firstLabel(param) {
  return param?.values?.[0]?.label ?? null;
}

const tx = db.transaction(() => {
  let updated = 0;
  for (const { id, payload_json } of rows) {
    let payload;
    try {
      payload = JSON.parse(payload_json);
    } catch {
      continue;
    }
    const params = payload?.parameters || {};
    update.run(
      yesNo(firstLabel(params.damaged)),
      yesNo(firstLabel(params.no_accident)),
      yesNo(firstLabel(params.service_record)),
      yesNo(firstLabel(params.original_owner)),
      yesNo(firstLabel(params.is_imported_car)),
      yesNo(firstLabel(params.tuning)),
      yesNo(firstLabel(params.historical_vehicle)),
      yesNo(firstLabel(params.registered)),
      firstLabel(params.new_used),
      firstLabel(params.country_origin),
      id,
    );
    updated += 1;
  }
  console.log(`updated ${updated}`);
});

tx();
closeDatabase(db);
