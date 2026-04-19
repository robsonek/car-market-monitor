// Renderowanie diffów i etykietowanie pól listing_changes.
// Wspólny moduł dla widoków Changes, Relistings, Listing Detail i Activity.

import { el } from "./core.js";
import { formatPrice, formatDate } from "./format.js";
import { formatCountPl, truncate } from "./ui.js";
import { compactMultiLineSegments, diffLines, tokenDiffAsSegments } from "./diff.js";
import { diffValueAddedServices, formatValueAddedServiceName } from "../shared/value-added-services.js";

// ---------- field name labeling ----------

export function humanizeFieldSegment(segment) {
  return String(segment || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeChangedFieldKey(fieldName) {
  return String(fieldName || "")
    .replace(/^details\./, "")
    .replace(/^parameters\./, "")
    .replace(/^decrypted\./, "")
    .replace(/^seller\.location\.canonicals\./, "")
    .replace(/^seller\.location\.map\./, "")
    .replace(/^seller\.location\./, "")
    .replace(/^seller\./, "")
    .replace(/^price\./, "")
    .replace(/^images\./, "")
    .replace(/\.(label|value|values|group|href|description)$/, "");
}

export function formatChangedFieldLabel(fieldName) {
  const directLabels = {
    created_at: "data publikacji",
    original_created_at: "pierwotna data publikacji",
    updated_at: "data aktualizacji",
    "price.value": "cena",
    "price.labels": "etykiety ceny",
    "images.urls": "zdjęcia",
    "images.count": "liczba zdjęć",
    value_added_services: "promowanie",
    main_features: "główne cechy",
    ad_features: "wyróżniki",
    description_text: "opis",
    description: "opis",
    description_html: "opis",
    title: "tytuł",
    packages: "pakiety",
    verified_car: "verified car",
    verified_car_fields: "pola verified car",
    "decrypted.phones_main": "telefony główne",
    "decrypted.phones_description": "telefony w opisie",
    "seller.features_badges": "wyróżnienia sprzedawcy",
    "seller.name": "sprzedawca",
    "seller.type": "typ sprzedawcy",
    "seller.uuid": "UUID sprzedawcy",
    "seller.id": "ID sprzedawcy",
    "seller.location.address": "adres sprzedawcy",
    "seller.location.shortAddress": "krótki adres sprzedawcy",
    "seller.location.city": "miasto sprzedawcy",
    "seller.location.cityId": "ID miasta sprzedawcy",
    "seller.location.region": "region sprzedawcy",
    "seller.location.regionId": "ID regionu sprzedawcy",
    "seller.location.country": "kraj sprzedawcy",
    "seller.location.postalCode": "kod pocztowy sprzedawcy",
    "seller.location.map.latitude": "szerokość geogr. sprzedawcy",
    "seller.location.map.longitude": "długość geogr. sprzedawcy",
    "seller.location.map.radius": "promień mapy sprzedawcy",
    "seller.location.map.zoom": "zoom mapy sprzedawcy",
    "seller.location.canonicals.city": "miasto sprzedawcy",
    "seller.location.canonicals.region": "region sprzedawcy",
    "seller.location.canonicals.subregion": "subregion sprzedawcy",
  };
  if (directLabels[fieldName]) return directLabels[fieldName];

  const normalized = normalizeChangedFieldKey(fieldName);

  const normalizedLabels = {
    mileage: "przebieg",
    year: "rok",
    make: "marka",
    model: "model",
    fuel_type: "paliwo",
    gearbox: "skrzynia",
    body_type: "nadwozie",
    engine_power: "moc",
    engine_capacity: "pojemność",
    seller_name: "sprzedawca",
    country_origin: "kraj pochodzenia",
    no_accident: "bezwypadkowy",
    registered: "zarejestrowany",
    original_owner: "pierwszy właściciel",
    approval_for_goods: "homologacja ciężarowa",
    historical_vehicle: "pojazd zabytkowy",
    tuning: "tuning",
    autorenew: "autoodnawianie",
    transmission: "napęd",
    color: "kolor",
    door_count: "liczba drzwi",
    has_registration: "rejestracja",
    catalog_urn: "katalog",
    version: "wersja",
    version_label: "etykieta wersji",
    deactivation_reason_id: "powód dezaktywacji",
  };
  if (normalizedLabels[normalized]) return normalizedLabels[normalized];

  const parts = normalized.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "zmiana";
  return parts.slice(-2).map(humanizeFieldSegment).join(" / ");
}

export function summarizeChangedFields(changedFields, fieldCount, changeCount) {
  const fields = String(changedFields || "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const uniqueFields = Array.from(new Set(fields));
  const safeFieldCount = Number(fieldCount) || uniqueFields.length;
  const safeChangeCount = Number(changeCount) || safeFieldCount;
  if (uniqueFields.length === 0) {
    return `${safeChangeCount} ${formatCountPl(safeChangeCount, "zmiana", "zmiany", "zmian")}`;
  }
  const preview = uniqueFields.slice(0, 3).map(formatChangedFieldLabel).join(", ");
  const extra = uniqueFields.length - Math.min(uniqueFields.length, 3);
  const extraLabel = extra > 0 ? ` +${extra}` : "";
  return `${safeFieldCount} ${formatCountPl(safeFieldCount, "pole", "pola", "pól")}: ${preview}${extraLabel}`;
}

// ---------- value formatting ----------

export function formatChangeValue(fieldName, value) {
  if (value == null) return "—";
  if (fieldName === "price.value") return formatPrice(value);
  return String(value);
}

function formatValueAddedServicesSummary(side, diff) {
  const parts = [];
  if (side === "old") {
    if (diff.removedCount) {
      parts.push(`- ${diff.removedCount} ${formatCountPl(diff.removedCount, "usunięta", "usunięte", "usuniętych")}`);
    }
    if (diff.changedCount) {
      parts.push(`~ ${diff.changedCount} ${formatCountPl(diff.changedCount, "zmiana", "zmiany", "zmian")}`);
    }
  } else {
    if (diff.addedCount) {
      parts.push(`+ ${diff.addedCount} ${formatCountPl(diff.addedCount, "dodana", "dodane", "dodanych")}`);
    }
    if (diff.changedCount) {
      parts.push(`~ ${diff.changedCount} ${formatCountPl(diff.changedCount, "zmiana", "zmiany", "zmian")}`);
    }
  }
  return parts.join(" · ");
}

function isEquivalentValueAddedServicesChange(fieldName, oldValue, newValue) {
  if (fieldName !== "value_added_services") return false;
  const diff = diffValueAddedServices(oldValue, newValue);
  return diff?.equivalentAfterNormalization === true;
}

export function filterVisibleChanges(rows) {
  return rows.filter((row) => !isEquivalentValueAddedServicesChange(row.field_name, row.old_value, row.new_value));
}

function renderValueAddedServiceItem(service, side) {
  const kindLabel = {
    old: {
      changed: "przed",
      removed: "usunięte",
    },
    new: {
      changed: "po",
      added: "dodane",
    },
  }[side]?.[service.diffKind] || service.diffKind;

  const meta = [];
  if (service.validity) meta.push(`ważne do ${formatDate(service.validity)}`);
  if (service.appliedAt) meta.push(`${service.name === "bump_up" ? "podbite" : "aktywowane"} ${formatDate(service.appliedAt)}`);
  if (service.exportedAdId) meta.push(`${service.name === "export_olx" ? "ID OLX" : "ID eksportu"} ${service.exportedAdId}`);

  return el("div", { class: `service-diff-item service-diff-item--${side}` },
    el("div", { class: "service-diff-head" },
      el("div", { class: "service-diff-title" }, formatValueAddedServiceName(service.name)),
      el("span", { class: `service-diff-badge service-diff-badge--${side}` }, kindLabel),
    ),
    meta.length > 0 ? el("div", { class: "service-diff-meta" }, meta.join(" · ")) : null,
  );
}

function renderValueAddedServicesDiffSide(side, oldValue, newValue) {
  const diff = diffValueAddedServices(oldValue, newValue);
  if (!diff) return null;
  if (diff.equivalentAfterNormalization) {
    return el("div", { class: "service-diff service-diff--noop" },
      el("span", { class: "muted" }, "— tylko kolejność"),
    );
  }

  const items = side === "old" ? diff.oldItems : diff.newItems;
  if (items.length === 0) return el("span", { class: "muted" }, "—");

  const wrap = el("div", { class: "service-diff" });
  const summary = formatValueAddedServicesSummary(side, diff);
  if (summary) {
    wrap.appendChild(el("div", { class: `service-diff-label service-diff-label--${side}` }, summary));
  }
  const list = el("div", { class: "service-diff-list" });
  for (const item of items) list.appendChild(renderValueAddedServiceItem(item, side));
  wrap.appendChild(list);
  return wrap;
}

// ---------- text diff rendering ----------

function appendTextDiffSegments(node, side, segments) {
  const keep = side === "old" ? new Set(["common", "removed"]) : new Set(["common", "added"]);
  const clsFor = (type) =>
    type === "common" ? "diff-context" : type === "removed" ? "diff-removed" : "diff-added";
  for (const seg of segments) {
    if (!keep.has(seg.type)) continue;
    node.appendChild(el("span", { class: clsFor(seg.type) }, seg.text));
  }
}

function renderCompactTextDiff(side, segments) {
  const compact = compactMultiLineSegments(segments, { contextLines: 1, minLines: 8 });
  if (!compact.compacted) return null;

  const wrap = el("div", { class: "text-diff text-diff--compact" });
  for (const entry of compact.entries) {
    if (entry.kind === "omitted") {
      wrap.appendChild(
        el(
          "div",
          { class: "text-diff-ellipsis" },
          `… pominięto ${entry.omittedLineCount} ${formatCountPl(entry.omittedLineCount, "linię", "linie", "linii")} …`,
        ),
      );
      continue;
    }
    const line = el("div", { class: "text-diff-line" });
    if (entry.pieces.length === 0) line.appendChild(document.createTextNode(" "));
    else appendTextDiffSegments(line, side, entry.pieces);
    wrap.appendChild(line);
  }
  return wrap;
}

// Render one side of a diff (old or new). Common prefix/suffix render dim,
// the changed middle highlights either red (removed) or green (added)
// depending on which side we're rendering. For text fields where there's
// no opposite value (initial creation, deletion), falls back to plain text.
// Special-cases images.urls to render actual thumbnail grids instead of
// the raw JSON URL array.
export function renderDiffSide(side, ownValue, oppositeValue, fieldName, options = {}) {
  if (ownValue == null) return el("span", { class: "muted" }, "—");
  // images.urls: array of marketplace CDN URLs flattened to a JSON string by
  // flattenForDiff. Render thumbnails of the delta instead of a 5 KB wall
  // of base64-looking JWT URLs which the word-diff can't usefully highlight.
  if (fieldName === "images.urls") {
    return renderImageDiffSide(side, ownValue, oppositeValue);
  }
  if (fieldName === "value_added_services") {
    const rendered = renderValueAddedServicesDiffSide(
      side,
      side === "old" ? ownValue : oppositeValue,
      side === "old" ? oppositeValue : ownValue,
    );
    if (rendered) return rendered;
  }
  // For numeric/short fields use legacy formatting — diff highlighting on
  // a number is just visual noise.
  if (
    oppositeValue == null ||
    fieldName === "price.value" ||
    fieldName === "__listing_status" ||
    fieldName === "__listing_created" ||
    String(ownValue).length < 20
  ) {
    return document.createTextNode(formatChangeValue(fieldName, ownValue));
  }
  // Two code paths depending on multi-line-ness:
  //   - multi-line text (description_text etc.) → line-level LCS, handles
  //     multi-region edits correctly. Before this, affix-based diffTokens
  //     collapsed everything between the first and last changed line into
  //     one giant red/green block — even when 12 out of 15 lines in between
  //     were identical. LCS walks both texts and produces a segment list
  //     that naturally handles any number of interleaved changed regions.
  //   - single-line values (JSON blobs, URLs, short strings) → token-level
  //     diff so multiple edit islands inside one string still render as
  //     separate red/green fragments.
  const oldStr = String(side === "old" ? ownValue : oppositeValue);
  const newStr = String(side === "old" ? oppositeValue : ownValue);
  const isMultiLine = oldStr.includes("\n") || newStr.includes("\n");
  const segments = isMultiLine
    ? diffLines(oldStr, newStr)
    : tokenDiffAsSegments(oldStr, newStr);

  if (isMultiLine && options.compactMultiline) {
    const compact = renderCompactTextDiff(side, segments);
    if (compact) return compact;
  }

  const wrap = el("div", { class: "text-diff" });
  // Concatenate emitted segments with no separator. Line boundaries are
  // already baked into segment text by diffLines() (trailing \n on every
  // segment except the last), and single-line diffs never have newlines
  // by definition. This keeps refined intra-line fragments like
  //   common "*) Automatyczna klimatyzacja" + added " 4 strefowa"
  // from getting a spurious \n shoved between them.
  appendTextDiffSegments(wrap, side, segments);
  return wrap;
}

// images.urls-specific diff view. On the "old" side we show photos that were
// REMOVED (present in old, absent in new); on the "new" side we show photos
// that were ADDED (present in new, absent in old). Reorder-only changes
// (same set of URLs, different order) render as an empty "— reorder" label
// since stableStringify sorts array contents alphabetically before
// serialization — meaning a pure reorder wouldn't even register as a change
// in the first place, but we handle the degenerate case defensively.
function renderImageDiffSide(side, ownValue, oppositeValue) {
  const parseUrls = (raw) => {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
    } catch {
      return null;
    }
  };
  const own = parseUrls(ownValue);
  const opp = parseUrls(oppositeValue);
  // If either side isn't parseable JSON array, fall back to plain text so
  // we never render a broken view. Shouldn't happen in practice — flatten
  // always stableStringify's arrays — but defensive.
  if (own == null || opp == null) {
    return document.createTextNode(truncate(String(ownValue ?? ""), 80));
  }
  const oppSet = new Set(opp);
  const delta = own.filter((u) => !oppSet.has(u));
  if (delta.length === 0) {
    // Nothing unique on our side — either sets are equal (shouldn't happen
    // if a change was recorded) or our side is a subset of the opposite.
    return el("span", { class: "muted" }, "—");
  }
  const labelText = side === "old"
    ? `- ${delta.length} usuni${delta.length === 1 ? "ęte" : "ętych"}`
    : `+ ${delta.length} dodan${delta.length === 1 ? "e" : "ych"}`;
  const wrap = el("div", { class: "image-diff" });
  wrap.appendChild(
    el("div", { class: `image-diff-label image-diff-label--${side}` }, labelText),
  );
  const grid = el("div", { class: "image-grid" });
  for (const url of delta) {
    // Anchor so user can click through to the full-res version on the marketplace CDN
    // CDN. rel=noopener because these are third-party.
    const link = el("a", {
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
      class: "image-thumb-link",
      title: side === "old" ? "usunięte z ogłoszenia" : "dodane do ogłoszenia",
    },
      el("img", {
        src: url,
        class: `image-thumb image-thumb--${side}`,
        loading: "lazy",
        alt: "",
      }),
    );
    grid.appendChild(link);
  }
  wrap.appendChild(grid);
  return wrap;
}
