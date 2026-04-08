import pLimit from "p-limit";
import {
  detectSite,
  normalizeSourceUrl,
  scrapeMarketplaceDetail,
  scrapeMarketplaceListingCards,
} from "./marketplace-source.js";
import { PARAM_COLUMNS } from "./marketplace-source-params.js";
import { diffValueAddedServices } from "../../shared/value-added-services.js";
import { HttpError, flattenForDiff, nowIso, randomId, sha256Hex, sleep, stableStringify } from "./utils.js";

export const RUN_STATUSES = {
  SUCCESS: "SUCCESS",
  PARTIAL_SUCCESS: "PARTIAL_SUCCESS",
  FAILED: "FAILED",
};

// Trzymamy WSZYSTKO sekwencyjnie (1) żeby nie złapać bana od źródłowego marketplace'u.
// Zmień na wyższe wartości tylko jeśli wiesz że upstream toleruje ruch.
const SOURCE_CONCURRENCY = 1;
const DETAIL_CONCURRENCY = 1;
const DETAIL_RETRIES = 2; // total = 3 attempts
const DETAIL_RETRY_BASE_DELAY_MS = 2_000;
const RUN_ERROR_LINE_LIMIT = 10;

// Hysteresis przy wykrywaniu zniknięć: paginacja źródła czasem wypycha
// promoted ads i nasz scrape ich nie widzi w jednym konkretnym runie. Zamiast
// natychmiast oznaczać taką ofertę jako MISSING (false positive widoczny w
// dashboardzie), wymagamy dwóch kolejnych nietrafień. Jeśli między miss'ami
// oferta wraca, licznik się resetuje.
const MISSING_THRESHOLD = 2;

// ---------- source CRUD (sync — better-sqlite3) ----------

export function createSource(db, { url, name = null }) {
  const normalizedUrl = normalizeSourceUrl(url);
  const site = detectSite(normalizedUrl);
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM sources WHERE url = ?").get(normalizedUrl);
  if (existing) {
    throw new HttpError(409, "Source already exists", { id: existing.id });
  }
  const source = {
    id: randomId(),
    site,
    name,
    url: normalizedUrl,
    is_active: 1,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO sources (id, site, name, url, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(source.id, source.site, source.name, source.url, source.is_active, source.created_at, source.updated_at);
  return source;
}

export function listSources(db) {
  return db
    .prepare(
      `SELECT id, site, name, url, is_active, created_at, updated_at, last_run_at, last_success_at
       FROM sources
       ORDER BY created_at ASC`,
    )
    .all();
}

export function removeSource(db, id) {
  const result = db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  return result.changes > 0;
}

export function setSourceActive(db, id, isActive) {
  const result = db
    .prepare("UPDATE sources SET is_active = ?, updated_at = ? WHERE id = ?")
    .run(isActive ? 1 : 0, nowIso(), id);
  return result.changes > 0;
}

// ---------- run orchestration ----------

export async function runAllActiveSources(db, { triggerType = "scheduled", logger = console, batchId = randomId() } = {}) {
  const sources = db.prepare("SELECT * FROM sources WHERE is_active = 1 ORDER BY created_at ASC").all();
  if (sources.length === 0) {
    logger.log("no active sources to run");
    return [];
  }
  const limit = pLimit(SOURCE_CONCURRENCY);
  return Promise.all(sources.map((source) => limit(() => runSource(db, source, { triggerType, logger, batchId }))));
}

export async function runSourceById(db, sourceId, options = {}) {
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
  if (!source) {
    throw new HttpError(404, "Source not found");
  }
  return runSource(db, source, options);
}

export async function runSource(
  db,
  source,
  { triggerType = "manual", logger = console, fetchImpl, retryBaseDelayMs, batchId = randomId() } = {},
) {
  // fetchImpl and retryBaseDelayMs are test seams. Production callers leave
  // them undefined, which falls through to the global fetch and the module
  // constants. Tests inject a stub fetch so HTTP never leaves the process,
  // and shrink retryBaseDelayMs to 0 so error-path tests don't sleep for
  // seconds per detail failure.
  const startedAt = nowIso();
  const label = source.name || source.url;
  logger.log(`[${label}] discovery start`);

  let listingPayload;
  try {
    if (source.site !== "OTOMOTO") {
      throw new HttpError(400, `Unsupported source site: ${source.site}`);
    }
    listingPayload = await scrapeMarketplaceListingCards(source.url, fetchImpl);
  } catch (error) {
    logger.error(`[${label}] discovery failed: ${error.message || error}`);
    return persistDiscoveryFailure(db, source, triggerType, startedAt, error, batchId);
  }

  const cards = listingPayload.unique_cards;
  logger.log(
    `[${label}] discovery ok pages=${listingPayload.metadata.page_count} cards=${cards.length}`,
  );

  const detailLimit = pLimit(DETAIL_CONCURRENCY);
  const detailResults = await Promise.all(
    cards.map((card) =>
      detailLimit(() => fetchDetailWithRetry(card, label, logger, { fetchImpl, retryBaseDelayMs })),
    ),
  );

  const finishedAt = nowIso();
  return commitRun(db, {
    source,
    triggerType,
    batchId,
    startedAt,
    finishedAt,
    listingPayload,
    detailResults,
    logger,
    label,
  });
}

async function fetchDetailWithRetry(card, label, logger, { fetchImpl, retryBaseDelayMs } = {}) {
  const baseDelayMs = retryBaseDelayMs ?? DETAIL_RETRY_BASE_DELAY_MS;
  let lastError;
  for (let attempt = 0; attempt <= DETAIL_RETRIES; attempt += 1) {
    try {
      const detail = await scrapeMarketplaceDetail(card, fetchImpl);
      return { card, detail, error: null };
    } catch (error) {
      lastError = error;
      if (attempt < DETAIL_RETRIES) {
        await sleep(baseDelayMs * (attempt + 1));
      }
    }
  }
  logger.warn(`[${label}] detail failed ${card.ad_id}: ${lastError?.message || lastError}`);
  return { card, detail: null, error: lastError };
}

// ---------- atomic commit ----------

function commitRun(db, ctx) {
  const { source, triggerType, batchId, startedAt, finishedAt, listingPayload, detailResults, logger, label } = ctx;
  const runId = randomId();

  const summary = {
    detail_success_count: 0,
    detail_failed_count: 0,
    new_listings_count: 0,
    changed_listings_count: 0,
    unchanged_listings_count: 0,
    removed_listings_count: 0,
    reactivated_listings_count: 0,
  };
  const errors = [];

  // The whole pass — listings, snapshots, changes, reconcile, run row — is
  // wrapped in one transaction. If anything throws, the entire run is rolled
  // back, so we never end up in the half-finalized state P1 was complaining
  // about: there is no "phase 1 wrote, phase 2 didn't" because the only
  // observable state is the post-COMMIT one.
  const tx = db.transaction(() => {
    // Insert the run row up front so listing_snapshots/listing_changes can
    // FK-reference it. We'll UPDATE the counters and final status at the end
    // of the same transaction. finished_at stays NULL until we know the result.
    db.prepare(
      `INSERT INTO scrape_runs (
         id, source_id, trigger_type, status, started_at, batch_id,
         reported_total_count, raw_row_count, unique_row_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      source.id,
      triggerType,
      "RUNNING",
      startedAt,
      batchId,
      listingPayload.metadata.reported_total_count,
      listingPayload.metadata.raw_row_count,
      listingPayload.metadata.unique_row_count,
    );

    const existingListings = db
      .prepare("SELECT * FROM listings WHERE source_id = ?")
      .all(source.id);
    const byExternalId = new Map(existingListings.map((row) => [row.external_id, row]));
    const seenExternalIds = new Set();

    for (const result of detailResults) {
      seenExternalIds.add(result.card.ad_id);
      if (result.error) {
        summary.detail_failed_count += 1;
        errors.push(`${result.card.ad_id}: ${result.error.message || result.error}`);
        applyCardOnly(db, runId, source.id, result.card, finishedAt, byExternalId, summary);
      } else {
        summary.detail_success_count += 1;
        applyDetail(db, runId, source.id, result.detail, result.card, finishedAt, byExternalId, summary);
      }
    }

    // Reconcile z hysteresis: jeden miss tylko bumpuje licznik. Dopiero
    // MISSING_THRESHOLD kolejnych miss'ów flipuje is_active na 0 i emituje
    // zmianę statusu. Reset licznika dzieje się w applyDetail/applyCardOnly
    // (kolumna missed_count = 0).
    for (const listing of existingListings) {
      if (seenExternalIds.has(listing.external_id)) continue;
      if (Number(listing.is_active) === 0) {
        // Już nieaktywna — tylko bumpujemy licznik (do diagnostyki).
        db.prepare(
          `UPDATE listings SET missed_count = missed_count + 1, updated_at = ? WHERE id = ?`,
        ).run(finishedAt, listing.id);
        continue;
      }
      const newMissedCount = Number(listing.missed_count || 0) + 1;
      if (newMissedCount >= MISSING_THRESHOLD) {
        db.prepare(
          `UPDATE listings SET is_active = 0, missed_count = ?, updated_at = ? WHERE id = ?`,
        ).run(newMissedCount, finishedAt, listing.id);
        insertChange(db, {
          listingId: listing.id,
          runId,
          snapshotId: listing.last_snapshot_id,
          field_name: "__listing_status",
          old_value: "ACTIVE",
          new_value: "MISSING",
          created_at: finishedAt,
        });
        summary.removed_listings_count += 1;
      } else {
        // Soft miss — listing zostaje aktywny, tylko bumpujemy counter.
        db.prepare(
          `UPDATE listings SET missed_count = ?, updated_at = ? WHERE id = ?`,
        ).run(newMissedCount, finishedAt, listing.id);
      }
    }

    const status = computeStatus(detailResults.length, summary.detail_failed_count);
    const errorBlob = errors.slice(0, RUN_ERROR_LINE_LIMIT).join("\n") || null;

    db.prepare(
      `UPDATE scrape_runs SET
         status = ?, finished_at = ?,
         detail_success_count = ?, detail_failed_count = ?,
         new_listings_count = ?, changed_listings_count = ?,
         unchanged_listings_count = ?, removed_listings_count = ?,
         reactivated_listings_count = ?, error = ?
       WHERE id = ?`,
    ).run(
      status,
      finishedAt,
      summary.detail_success_count,
      summary.detail_failed_count,
      summary.new_listings_count,
      summary.changed_listings_count,
      summary.unchanged_listings_count,
      summary.removed_listings_count,
      summary.reactivated_listings_count,
      errorBlob,
      runId,
    );

    db.prepare(
      `UPDATE sources
       SET last_run_at = ?,
           last_success_at = CASE WHEN ? = 0 THEN ? ELSE last_success_at END,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      startedAt,
      status === RUN_STATUSES.FAILED ? 1 : 0,
      finishedAt,
      finishedAt,
      source.id,
    );

    return status;
  });

  const status = tx();
  logger.log(
    `[${label}] run=${status} success=${summary.detail_success_count} failed=${summary.detail_failed_count}` +
      ` new=${summary.new_listings_count} changed=${summary.changed_listings_count}` +
      ` unchanged=${summary.unchanged_listings_count} removed=${summary.removed_listings_count}` +
      ` reactivated=${summary.reactivated_listings_count}`,
  );

  return {
    source_id: source.id,
    run_id: runId,
    batch_id: batchId,
    status,
    metadata: listingPayload.metadata,
    ...summary,
  };
}

function computeStatus(totalDetails, failedDetails) {
  if (totalDetails === 0) return RUN_STATUSES.SUCCESS;
  if (failedDetails === 0) return RUN_STATUSES.SUCCESS;
  if (failedDetails < totalDetails) return RUN_STATUSES.PARTIAL_SUCCESS;
  return RUN_STATUSES.FAILED;
}

// ---------- detail → column mapping ----------
//
// Single source of truth for "what columns get written from a normalized
// detail object". Used by both INSERT (insertListing) and the two UPDATE paths
// in applyDetail (hash-unchanged refresh + hash-changed reapply). Keeping the
// list in one place means a new column added in a future migration only needs
// one entry here, not three INSERT/UPDATE statements to keep in sync.
//
// Order doesn't matter — we materialize column lists from Object.keys() at
// statement-prepare time. detail.params (from extractParams) is spread first
// so the explicit overrides below win for legacy compat.
function buildDetailColumns(detail) {
  const c = detail.condition || {};
  const p = detail.params || {};
  return {
    // ----- spread all 150 params from extractParams() first -----
    ...p,
    // ----- legacy condition fields override params for two TEXT cols where
    //       extractCondition() uses the human label and extractParams() uses
    //       the slug. The booleans (damaged etc.) collapse to the same 1/0/null
    //       in both pipelines, so it doesn't matter which wins for those. -----
    new_used: c.new_used ?? p.new_used ?? null,
    country_origin: c.country_origin ?? p.country_origin ?? null,
    // ----- core columns from migration 0001 -----
    listing_url: detail.listing_url,
    title: detail.title,
    seller_type: detail.seller_type,
    current_status: detail.current_status,
    last_price_amount: detail.price_amount != null ? String(detail.price_amount) : null,
    last_mileage: detail.mileage != null ? String(detail.mileage) : null,
    last_year: detail.year != null ? String(detail.year) : null,
    // ----- new top-level columns from migration 0003 -----
    description_text: detail.description_text || null,
    vin: detail.vin,
    registration: detail.registration,
    date_registration: detail.date_registration,
    phones_json: detail.phones_json,
    image_count: detail.image_count,
    seller_uuid: detail.seller_uuid,
    seller_id: detail.seller_id,
    seller_name: detail.seller_name,
    seller_location_city: detail.seller_location_city,
    seller_location_region: detail.seller_location_region,
    seller_location_lat: detail.seller_location_lat,
    seller_location_lon: detail.seller_location_lon,
    advert_created_at: detail.advert_created_at,
    advert_updated_at: detail.advert_updated_at,
    advert_original_created_at: detail.advert_original_created_at,
    price_currency: detail.price_currency,
    price_labels_json: detail.price_labels_json,
    verified_car: detail.verified_car,
    is_used_car: detail.is_used_car,
    is_parts: detail.is_parts,
  };
}

// Sanity check: at module load, verify every column we plan to write actually
// matches a known target. PARAM_COLUMNS comes from marketplace-source-params.js (backed
// by ALTER TABLEs in migration 0003), so this catches typos in either file.
{
  const sample = buildDetailColumns({ condition: {}, params: Object.fromEntries(PARAM_COLUMNS.map((c) => [c, null])) });
  const known = new Set(PARAM_COLUMNS);
  for (const key of Object.keys(sample)) {
    if (known.has(key)) continue;
    // Non-param columns we manage explicitly. Listed here so any future typo
    // in a buildDetailColumns property name shows up immediately at startup.
    const meta = new Set([
      "listing_url", "title", "seller_type", "current_status",
      "last_price_amount", "last_mileage", "last_year",
      "description_text",
      "vin", "registration", "date_registration", "phones_json",
      "image_count",
      "seller_uuid", "seller_id", "seller_name",
      "seller_location_city", "seller_location_region",
      "seller_location_lat", "seller_location_lon",
      "advert_created_at", "advert_updated_at", "advert_original_created_at",
      "price_currency", "price_labels_json",
      "verified_car", "is_used_car", "is_parts",
    ]);
    if (!meta.has(key)) {
      throw new Error(`buildDetailColumns produced unknown column "${key}"`);
    }
  }
}

// ---------- per-listing apply ----------

function applyDetail(db, runId, sourceId, detail, card, capturedAt, byExternalId, summary) {
  const hash = computeSnapshotHash(detail);
  const existing = byExternalId.get(detail.external_id);
  const placeholderUpgrade = Boolean(existing && !existing.last_snapshot_id);

  if (!existing) {
    const listingId = randomId();
    const snapshotId = randomId();
    insertListing(db, {
      id: listingId,
      sourceId,
      detail,
      hash,
      snapshotId,
      capturedAt,
    });
    insertSnapshot(db, { snapshotId, listingId, runId, capturedAt, hash, detail });
    insertChange(db, {
      listingId,
      runId,
      snapshotId,
      field_name: "__listing_created",
      old_value: null,
      new_value: "ACTIVE",
      created_at: capturedAt,
    });
    summary.new_listings_count += 1;
    return;
  }

  const reactivated = Number(existing.is_active) === 0;

  if (!placeholderUpgrade && existing.last_snapshot_hash && existing.last_snapshot_hash === hash) {
    // Hash unchanged: refresh the denormalized columns (price/mileage/year may
    // get re-typed with the same value, condition fields stay stable) and
    // bump the last_seen_at watermark. We deliberately do NOT touch
    // last_snapshot_id / last_snapshot_hash here because no new snapshot was
    // written.
    updateListingDetailColumns(db, existing.id, detail, capturedAt, {
      includeSnapshotPointer: false,
    });
    if (reactivated) {
      insertChange(db, {
        listingId: existing.id,
        runId,
        snapshotId: existing.last_snapshot_id,
        field_name: "__listing_status",
        old_value: "MISSING",
        new_value: "ACTIVE",
        created_at: capturedAt,
      });
      summary.reactivated_listings_count += 1;
    }
    summary.unchanged_listings_count += 1;
    return;
  }

  const previousFieldMap = placeholderUpgrade ? null : loadFieldMap(db, existing.last_snapshot_id);
  const changes = placeholderUpgrade ? [] : diffFieldMaps(previousFieldMap, detail.field_map);
  const semanticNoop = !placeholderUpgrade && changes.length === 0;

  // New snapshot — either field map changed, or this listing was a card-only
  // placeholder that finally got a real detail fetch.
  const snapshotId = randomId();
  insertSnapshot(db, { snapshotId, listingId: existing.id, runId, capturedAt, hash, detail });
  updateListingDetailColumns(db, existing.id, detail, capturedAt, {
    includeSnapshotPointer: true,
    snapshotId,
    hash,
  });

  if (placeholderUpgrade) {
    // Placeholder upgrade: na poprzednim runie detail failował i
    // applyCardOnly stworzył listing z is_active=1 oraz wyemitował
    // __listing_created (scrape.js applyCardOnly). Ten run wreszcie
    // dostał prawdziwy detail — zapisujemy pierwszy snapshot (co już
    // zrobiliśmy wyżej), ale NIE emitujemy drugiego __listing_created
    // i NIE bumpujemy new_listings_count, bo listing jest księgowany
    // jako "nowy" tylko raz, przy pierwszym pojawieniu się. Bez tego
    // ta sama oferta pokazywała się w feedzie zmian dwa razy i psuła
    // metryki runu (P2 code review).
    //
    // Nie emitujemy też diffa po field_map: poprzedni snapshot był
    // pusty (card-only placeholder nie ma snapshot_id), więc
    // diffFieldMaps wyprodukowałby ~50 "added" dla każdego pola — spam
    // bez wartości dla usera. Traktujemy to jak cichy backfill i
    // liczymy jako unchanged.
    //
    // Wyjątek: placeholder mógł być wcześniej flipped na is_active=0
    // (jeśli zniknął z listy na MISSING_THRESHOLD runów zanim detail
    // się udał). W takim razie odnotowujemy reaktywację tak jak w
    // normalnej ścieżce.
    if (reactivated) {
      insertChange(db, {
        listingId: existing.id,
        runId,
        snapshotId,
        field_name: "__listing_status",
        old_value: "MISSING",
        new_value: "ACTIVE",
        created_at: capturedAt,
      });
      summary.reactivated_listings_count += 1;
    } else {
      summary.unchanged_listings_count += 1;
    }
  } else if (semanticNoop) {
    // Legacy snapshots may carry transport-order noise (for example raw
    // value_added_services arrays from before normalization). We still persist
    // one healed snapshot so future hash checks stabilize, but we treat the
    // run as unchanged and emit no listing_changes rows.
    if (reactivated) {
      insertChange(db, {
        listingId: existing.id,
        runId,
        snapshotId,
        field_name: "__listing_status",
        old_value: "MISSING",
        new_value: "ACTIVE",
        created_at: capturedAt,
      });
      summary.reactivated_listings_count += 1;
    } else {
      summary.unchanged_listings_count += 1;
    }
  } else {
    if (reactivated) {
      insertChange(db, {
        listingId: existing.id,
        runId,
        snapshotId,
        field_name: "__listing_status",
        old_value: "MISSING",
        new_value: "ACTIVE",
        created_at: capturedAt,
      });
      summary.reactivated_listings_count += 1;
    }
    for (const change of changes) {
      insertChange(db, {
        listingId: existing.id,
        runId,
        snapshotId,
        field_name: change.field_name,
        old_value: change.old_value,
        new_value: change.new_value,
        created_at: capturedAt,
      });
    }
    summary.changed_listings_count += 1;
  }
}

// Failed detail fallback. We refresh price/mileage/year from the card so that
// API consumers don't keep showing stale data exactly when upstream rate-limits
// us — fixes review finding P2.
function applyCardOnly(db, runId, sourceId, card, capturedAt, byExternalId, summary) {
  const existing = byExternalId.get(card.ad_id);
  if (!existing) {
    const listingId = randomId();
    db.prepare(
      `INSERT INTO listings (
         id, source_id, external_id, listing_url, title, seller_type, current_status, is_active,
         first_seen_at, last_seen_at, last_snapshot_id, last_snapshot_hash, last_price_amount,
         last_mileage, last_year, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      listingId,
      sourceId,
      card.ad_id,
      card.url,
      card.title || null,
      null,
      null,
      1,
      capturedAt,
      capturedAt,
      null,
      null,
      card.price_amount != null ? String(card.price_amount) : null,
      card.mileage != null ? String(card.mileage) : null,
      card.year != null ? String(card.year) : null,
      capturedAt,
      capturedAt,
    );
    insertChange(db, {
      listingId,
      runId,
      snapshotId: null,
      field_name: "__listing_created",
      old_value: null,
      new_value: "ACTIVE",
      created_at: capturedAt,
    });
    summary.new_listings_count += 1;
    return;
  }

  const reactivated = Number(existing.is_active) === 0;
  db.prepare(
    `UPDATE listings
     SET listing_url = ?,
         title = COALESCE(?, title),
         is_active = 1,
         last_seen_at = ?,
         last_price_amount = COALESCE(?, last_price_amount),
         last_mileage = COALESCE(?, last_mileage),
         last_year = COALESCE(?, last_year),
         missed_count = 0,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    card.url,
    card.title || null,
    capturedAt,
    card.price_amount != null ? String(card.price_amount) : null,
    card.mileage != null ? String(card.mileage) : null,
    card.year != null ? String(card.year) : null,
    capturedAt,
    existing.id,
  );
  if (reactivated) {
    insertChange(db, {
      listingId: existing.id,
      runId,
      snapshotId: existing.last_snapshot_id,
      field_name: "__listing_status",
      old_value: "MISSING",
      new_value: "ACTIVE",
      created_at: capturedAt,
    });
    summary.reactivated_listings_count += 1;
  }
  summary.unchanged_listings_count += 1;
}

// ---------- helpers ----------

// Centralized UPDATE for an existing listing row whenever a fresh detail comes
// in. Used by both the "hash unchanged" and "hash changed" paths in
// applyDetail. The two callers differ only in whether they push the new
// snapshot pointer (id + hash) — a hash-unchanged refresh leaves the previous
// snapshot pointer intact because no new snapshot row was created.
function updateListingDetailColumns(db, listingId, detail, capturedAt, opts) {
  const cols = buildDetailColumns(detail);
  // Always-updated bookkeeping. Order in the SET clause is irrelevant since
  // we map by name, but we must keep the values array aligned with it.
  const update = {
    ...cols,
    is_active: 1,
    last_seen_at: capturedAt,
    missed_count: 0,
    updated_at: capturedAt,
  };
  if (opts?.includeSnapshotPointer) {
    update.last_snapshot_id = opts.snapshotId;
    update.last_snapshot_hash = opts.hash;
  }
  const columnNames = Object.keys(update);
  const setClause = columnNames.map((c) => `${c} = ?`).join(", ");
  const values = columnNames.map((c) => update[c]);
  values.push(listingId);
  db.prepare(`UPDATE listings SET ${setClause} WHERE id = ?`).run(...values);
}

function insertListing(db, { id, sourceId, detail, hash, snapshotId, capturedAt }) {
  // Dynamic INSERT: the fixed bookkeeping columns (id/source_id/external_id/
  // lifecycle timestamps/snapshot pointers) plus every column produced by
  // buildDetailColumns. This way adding a new migration-backed column only
  // requires a matching entry in buildDetailColumns — no SQL edit here.
  const fixedColumns = {
    id,
    source_id: sourceId,
    external_id: detail.external_id,
    is_active: 1,
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    last_snapshot_id: snapshotId,
    last_snapshot_hash: hash,
    created_at: capturedAt,
    updated_at: capturedAt,
  };
  const detailColumns = buildDetailColumns(detail);
  const row = { ...fixedColumns, ...detailColumns };
  const columnNames = Object.keys(row);
  const placeholders = columnNames.map(() => "?").join(", ");
  const values = columnNames.map((c) => row[c]);
  db.prepare(
    `INSERT INTO listings (${columnNames.join(", ")}) VALUES (${placeholders})`,
  ).run(...values);
}

function insertSnapshot(db, { snapshotId, listingId, runId, capturedAt, hash, detail }) {
  db.prepare(
    `INSERT INTO listing_snapshots (
       id, listing_id, run_id, snapshot_hash, captured_at, title, price_amount, mileage, year,
       description_text, payload_json, field_map_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshotId,
    listingId,
    runId,
    hash,
    capturedAt,
    detail.title,
    detail.price_amount != null ? String(detail.price_amount) : null,
    detail.mileage != null ? String(detail.mileage) : null,
    detail.year != null ? String(detail.year) : null,
    detail.description_text,
    stableStringify(detail.payload),
    // field_map_json jest teraz wyliczany dynamicznie z payload_json w
    // loadFieldMap() — patrz migration 0005. Kolumna pozostaje NOT NULL dla
    // kompatybilności schematu, więc piszemy pusty string.
    "",
  );
}

function insertChange(db, change) {
  db.prepare(
    `INSERT INTO listing_changes (
       id, listing_id, run_id, snapshot_id, field_name, old_value, new_value, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomId(),
    change.listingId,
    change.runId,
    change.snapshotId || null,
    change.field_name,
    change.old_value,
    change.new_value,
    change.created_at,
  );
}

// Field map rekonstruujemy z payload_json zamiast trzymać w osobnej kolumnie.
// Historycznie field_map_json był największym składnikiem bazy (~36 MB z ~70
// MB) i w dużej części duplikował dane z payload_json. Konwersja jest tania
// (JSON.parse + flatten), a uruchamia się tylko dla poprzedniego snapshotu
// przy wykrywaniu zmian.
//
// WAŻNE: listing_card MUSI zostać wycięty z payloadu przed flattenem.
// marketplace-source.js celowo trzyma listing_card tylko w payload, ale NIE w
// field_map, bo page_number/page_position rotują co run i generowałyby
// phantom diffy. Tu utrzymujemy ten sam kontrakt.
function loadFieldMap(db, snapshotId) {
  if (!snapshotId) return {};
  const row = db.prepare("SELECT payload_json FROM listing_snapshots WHERE id = ?").get(snapshotId);
  if (!row?.payload_json) return {};
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return {};
  }
  if (payload && typeof payload === "object") {
    delete payload.listing_card;
  }
  return flattenForDiff(payload);
}

// Upstream tokenized fields rotate between renders and would otherwise create
// phantom diffs. We keep them in payload_json for completeness, but exclude
// the raw token locations from comparison.
const NOISY_FIELD_PREFIXES = [
  "phone_tokens",
  "details.vin",
  "parameters.vin",
  "details.registration",
  "details.date_registration",
  "parameters.registration",
  "parameters.date_registration",
  "description_html",
];

function isNoisyFieldKey(key) {
  for (const prefix of NOISY_FIELD_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

// Hash snapshot identity from the field map AFTER stripping noisy keys.
//
// Important: noisy fields (rotating ciphertexts, description_html with inline
// random IVs) MUST be filtered before hashing — otherwise every scrape run
// produces a fresh hash even though no real change happened, applyDetail then
// flips the listing through the "hash changed" branch (writing a new snapshot
// row) and the diff loop confirms zero changes, leaving us with `changed=18,
// listing_changes=0`. The previous code computed sha256 over the raw field map
// and only filtered in `diffFieldMaps`, which produced exactly that mismatch.
export { computeSnapshotHash, diffFieldMaps, isNoisyFieldKey, NOISY_FIELD_PREFIXES };

function areFieldValuesEquivalent(fieldName, oldValue, newValue) {
  if (oldValue === newValue) return true;
  if (fieldName === "value_added_services") {
    const diff = diffValueAddedServices(oldValue, newValue);
    return diff?.equivalentAfterNormalization === true;
  }
  return false;
}

function computeSnapshotHash(detail) {
  const filtered = {};
  for (const [key, value] of Object.entries(detail.field_map || {})) {
    if (isNoisyFieldKey(key)) continue;
    filtered[key] = value;
  }
  return sha256Hex(stableStringify(filtered));
}

function diffFieldMaps(previousMap, nextMap) {
  const keys = new Set([...Object.keys(previousMap || {}), ...Object.keys(nextMap || {})]);
  const changes = [];
  for (const key of [...keys].sort()) {
    if (isNoisyFieldKey(key)) continue;
    const oldValue = previousMap?.[key] ?? null;
    const newValue = nextMap?.[key] ?? null;
    if (areFieldValuesEquivalent(key, oldValue, newValue)) continue;
    changes.push({ field_name: key, old_value: oldValue, new_value: newValue });
  }
  return changes;
}

function persistDiscoveryFailure(db, source, triggerType, startedAt, error, batchId) {
  const runId = randomId();
  const finishedAt = nowIso();
  db.prepare(
    `INSERT INTO scrape_runs (
       id, source_id, trigger_type, status, started_at, finished_at, batch_id, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    source.id,
    triggerType,
    RUN_STATUSES.FAILED,
    startedAt,
    finishedAt,
    batchId,
    String(error?.message || error || "discovery failed").slice(0, 2000),
  );
  db.prepare("UPDATE sources SET last_run_at = ?, updated_at = ? WHERE id = ?").run(
    startedAt,
    finishedAt,
    source.id,
  );
  return {
    source_id: source.id,
    run_id: runId,
    batch_id: batchId,
    status: RUN_STATUSES.FAILED,
    error: error?.message || String(error),
  };
}
