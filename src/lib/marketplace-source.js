import { decryptToken, decryptTokens } from "./marketplace-source-tokens.js";
import { extractParams } from "./marketplace-source-params.js";
import { HttpError, flattenForDiff, sha256Hex, stableStringify, stableValue, stripHtml } from "./utils.js";
import { normalizeValueAddedServices } from "../../shared/value-added-services.js";

const LISTING_NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const MARKETPLACE_ALLOWED_HOSTS = new Set(["www.otomoto.pl", "otomoto.pl"]);
// Ile dodatkowych stron próbujemy fetchnąć ponad zgłoszony przez upstream totalCount.
// Źródło czasem reportuje stary totalCount albo dorzuca nowe oferty w trakcie
// scrape'u, więc bezpiecznie iść trochę dalej. Pętla i tak wcześniej zerwie
// jak strona zwróci 0 ofert.
const PAGINATION_SAFETY_MARGIN = 2;
// Hard cap na wypadek bugu w stronie/parsingu — żeby pętla nie leciała w
// nieskończoność jeśli upstream zaczyna zwracać te same ID w kółko.
const PAGINATION_HARD_CAP = 100;

export function detectSite(url) {
  const parsed = new URL(url);
  if (MARKETPLACE_ALLOWED_HOSTS.has(parsed.hostname) && parsed.pathname.startsWith("/osobowe/")) {
    return "OTOMOTO";
  }
  throw new HttpError(400, `Unsupported source host: ${parsed.hostname}`);
}

export function normalizeSourceUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.delete("page");
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

export async function scrapeMarketplaceListingCards(url, fetchImpl = fetch) {
  const normalizedUrl = normalizeSourceUrl(url);
  // Force a stable sort during discovery. The source marketplace's default ordering mixes
  // promoted/featured ads into every page, which means the same ad shows up
  // on multiple pages and steals slots from new ones — empirically this caused
  // 436 reported total → only 368 unique cards across 14 pages, so 68 listings
  // disappeared on every run and our hysteresis (MISSING_THRESHOLD=2) flipped
  // them to is_active=0 after two consecutive misses. With explicit
  // `search[order]=created_at:desc` the same query returns 435 unique / 0 dupes.
  // We honor user-specified order if present.
  const firstPageHtml = await fetchHtml(fetchImpl, pageUrl(normalizedUrl, 1));
  const firstSearch = extractAdvertSearch(firstPageHtml);
  const totalCount = Number(firstSearch.totalCount || 0);
  const pageSize = Number(firstSearch.pageInfo?.pageSize || firstSearch.edges?.length || 1);
  const reportedPageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  // Idziemy o kilka stron za reported total na wypadek drift'u (nowe oferty
  // dorzucone w trakcie scrape'u przesuwają stare poza pierwotną granicę).
  // Ograniczamy hard capem.
  const maxPage = Math.min(PAGINATION_HARD_CAP, reportedPageCount + PAGINATION_SAFETY_MARGIN);

  const rawCards = [];
  rawCards.push(...extractListingCards(firstSearch, 1));

  let actualPageCount = 1;
  for (let page = 2; page <= maxPage; page += 1) {
    let pageCards;
    try {
      const html = await fetchHtml(fetchImpl, pageUrl(normalizedUrl, page));
      const searchPayload = extractAdvertSearch(html);
      pageCards = extractListingCards(searchPayload, page);
    } catch (error) {
      // Żaden błąd na stronie >1 NIE jest traktowany jako koniec
      // paginacji. Źródło dla out-of-range stron zwraca HTTP 200
      // z prawidłowym __NEXT_DATA__ i `edges: []` (empirycznie
      // zweryfikowane: page=9999 na /osobowe/porsche/taycan → 200,
      // totalCount=87, edges.length=0), więc "legitime end" jest
      // obsługiwany linijkę niżej przez `pageCards.length === 0`.
      //
      // Cokolwiek trafi tutaj (5xx, 429, 504 timeout, parse errors)
      // to prawdziwy upstream hiccup i MUSI wywalić cały discovery —
      // inaczej pojedynczy chwilowy błąd w środku paginacji po cichu
      // gubi ogon listy, listings z dalszych stron wypadają z
      // reconcile setu i po dwóch takich runach hysteresis flipuje
      // aktywne oferty na MISSING. Lepiej zapisać FAILED run
      // (persistDiscoveryFailure nie dotyka missed_count) niż po cichu
      // zafałszować stan bazy.
      throw error;
    }
    if (!pageCards || pageCards.length === 0) break;
    rawCards.push(...pageCards);
    actualPageCount = page;
    // Strona z mniej niż połową page size'a → prawdopodobnie ostatnia.
    if (pageCards.length < Math.max(1, Math.floor(pageSize / 2))) break;
  }

  const seen = new Set();
  const uniqueCards = [];
  for (const row of rawCards) {
    if (seen.has(row.ad_id)) continue;
    seen.add(row.ad_id);
    uniqueCards.push(row);
  }

  return {
    metadata: {
      requested_url: normalizedUrl,
      reported_total_count: totalCount,
      page_size: pageSize,
      page_count: actualPageCount,
      reported_page_count: reportedPageCount,
      raw_row_count: rawCards.length,
      unique_row_count: uniqueCards.length,
      duplicate_ids: countDuplicates(rawCards),
    },
    raw_cards: rawCards,
    unique_cards: uniqueCards,
  };
}

export async function scrapeMarketplaceDetail(card, fetchImpl = fetch) {
  const detailHtml = await fetchHtml(fetchImpl, card.url);
  const advert = extractAdvert(detailHtml);
  return normalizeDetail(advert, card);
}

// Pull tokenized phone entries out of the description HTML when present.
const INLINE_PHONE_TOKEN_RE = /phoneNumber="([^"]+)"/g;
function extractInlinePhoneTokens(html) {
  if (!html) return [];
  const out = [];
  for (const match of html.matchAll(INLINE_PHONE_TOKEN_RE)) {
    out.push(match[1]);
  }
  return out;
}

async function fetchHtml(fetchImpl, url) {
  // The same AbortController must cover both the fetch() handshake AND the
  // body read — otherwise an upstream that drips bytes forever bypasses the
  // timeout entirely. We only clear the timer in `finally` once text() returns.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "user-agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new HttpError(response.status, `Upstream fetch failed for ${url}`);
    }

    const html = await response.text();
    if (!html.includes("__NEXT_DATA__")) {
      throw new HttpError(502, `Unexpected upstream payload for ${url}`);
    }
    return html;
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new HttpError(504, `Upstream fetch timed out for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function pageUrl(baseUrl, pageNumber) {
  const parsed = new URL(baseUrl);
  if (pageNumber > 1) {
    parsed.searchParams.set("page", String(pageNumber));
  }
  // Force stable sort unless the source URL already pins one — see comment in
  // scrapeMarketplaceListingCards for the empirical justification (promoted ads
  // duplicate across pages under default ordering).
  if (!parsed.searchParams.has("search[order]")) {
    parsed.searchParams.set("search[order]", "created_at:desc");
  }
  return parsed.toString();
}

export { extractNextData, extractAdvertSearch, extractAdvert, extractListingCards, normalizeDetail };

function extractNextData(html) {
  const match = html.match(LISTING_NEXT_DATA_RE);
  if (!match) {
    throw new HttpError(502, "Could not find __NEXT_DATA__ payload");
  }
  return JSON.parse(match[1]);
}

function extractAdvertSearch(html) {
  const nextData = extractNextData(html);
  const urqlState = nextData?.props?.pageProps?.urqlState || {};

  for (const state of Object.values(urqlState)) {
    if (!state || typeof state !== "object" || !state.data) {
      continue;
    }
    try {
      const payload = JSON.parse(state.data);
      if (payload?.advertSearch) {
        return payload.advertSearch;
      }
    } catch {
      continue;
    }
  }

  throw new HttpError(502, "Could not find advertSearch data in listing payload");
}

function extractAdvert(html) {
  const nextData = extractNextData(html);
  const advert = nextData?.props?.pageProps?.advert;
  if (!advert) {
    throw new HttpError(502, "Could not find advert payload in detail page");
  }
  return advert;
}

function extractListingCards(advertSearch, pageNumber) {
  return (advertSearch.edges || []).map((edge, index) => {
    const node = edge.node || {};
    const params = parameterMap(node.parameters || []);
    const price = node.price || {};
    const amount = price.amount || {};
    const location = node.location || {};
    const seller = node.sellerLink || {};
    const vas = edge.vas || {};

    return {
      ad_id: node.id,
      title: node.title || null,
      short_description: node.shortDescription || null,
      url: node.url,
      created_at: node.createdAt || null,
      price_amount: amount.value || null,
      price_currency: amount.currencyCode || null,
      price_badges: price.badges || [],
      year: params.year || null,
      mileage: params.mileage || null,
      fuel_type: params.fuel_type || null,
      gearbox: params.gearbox || null,
      engine_power: params.engine_power || null,
      make: params.make || null,
      model: params.model || null,
      location_city: location.city?.name || null,
      location_region: location.region?.name || null,
      seller_id: seller.id || null,
      seller_name: seller.name || null,
      seller_website: seller.websiteUrl || null,
      is_highlighted: Boolean(vas.isHighlighted),
      is_promoted: Boolean(vas.isPromoted),
      bump_date: vas.bumpDate || null,
      is_premium_top_ad: Boolean(node.isPremiumTopAd),
      badges: node.badges || [],
      page_number: pageNumber,
      page_position: index + 1,
    };
  });
}

async function normalizeDetail(advert, card) {
  const detailMap = {};
  for (const item of advert.details || []) {
    detailMap[item.key] = {
      label: item.label,
      value: item.value,
      group: item.group,
      href: item.href || null,
      description: item.description || null,
    };
  }

  const detailsGroups = {};
  for (const group of advert.detailsGroups || []) {
    detailsGroups[group.key] = group.label;
  }

  const equipment = {};
  for (const group of advert.equipment || []) {
    equipment[group.key] = {
      label: group.label,
      values: (group.values || []).map((item) => item.label).sort(),
    };
  }

  const parameters = {};
  for (const [key, value] of Object.entries(advert.parametersDict || {})) {
    parameters[key] = {
      label: value.label,
      values: (value.values || []).map((item) => ({
        label: item.label,
        value: item.value,
      })),
    };
  }

  const seller = advert.seller || {};

  // Resolve tokenized detail fields exposed in the payload.
  const advertId = advert.id != null ? String(advert.id) : null;
  const sellerUuid = seller.uuid || null;
  const inlinePhoneTokens = extractInlinePhoneTokens(advert.description || "");
  const [vinPlain, regPlain, datePlain, mainPhones, descPhones] = await Promise.all([
    decryptToken(advert.parametersDict?.vin?.values?.[0]?.value, advertId),
    decryptToken(advert.parametersDict?.registration?.values?.[0]?.value, advertId),
    decryptToken(advert.parametersDict?.date_registration?.values?.[0]?.value, advertId),
    decryptTokens(advert.phoneNumbers || [], sellerUuid),
    decryptTokens(inlinePhoneTokens, sellerUuid),
  ]);

  // ----- Materialize the entire parametersDict as a flat typed object. The
  // shape of `params` is dictated by src/lib/marketplace-source-params.js (which is in
  // turn the source of truth for the listings columns added in migration 0003).
  const params = extractParams(advert.parametersDict);

  const phones = { main: mainPhones, description: descPhones };
  const phonesJson = JSON.stringify(phones);
  const imageCount = advert.images?.photos?.length || 0;
  const descriptionText = stripHtml(advert.description || "");
  const sellerLocation = seller.location || null;

  const snapshotPayload = stableValue({
    external_id: advert.id,
    url: advert.url,
    title: advert.title || null,
    status: advert.status || null,
    created_at: advert.createdAt || null,
    updated_at: advert.updatedAt || null,
    original_created_at: advert.originalCreatedAt || null,
    price: {
      value: advert.price?.value || null,
      currency: advert.price?.currency || null,
      labels: advert.price?.labels || [],
      is_under_budget: advert.price?.isUnderBudget ?? null,
    },
    description_html: advert.description || "",
    description_text: descriptionText,
    main_features: advert.mainFeatures || [],
    ad_features: (advert.adFeatures || []).slice().sort(),
    badges: (advert.badges || []).slice().sort(),
    seller: {
      type: seller.type || null,
      name: seller.name || null,
      id: seller.id || null,
      uuid: seller.uuid || null,
      features_badges: (seller.featuresBadges || []).map((item) => item.label),
      location: sellerLocation,
    },
    details: detailMap,
    detail_groups: detailsGroups,
    equipment,
    parameters,
    images: {
      count: imageCount,
      // URLs sorted lexicographically so a seller drag-dropping photo order
      // in the source editor doesn't show up as a diff — we only care
      // about adds/removes, not position. flattenForDiff otherwise preserves
      // array order which would generate a noise change on every reorder.
      // Trade-off: payload loses "which photo is the cover" info, acceptable.
      urls: (advert.images?.photos || []).map((item) => item.url).sort(),
    },
    phone_tokens: advert.phoneNumbers || [],
    // Materialized values used by the UI and diff pipeline.
    decrypted: {
      vin: vinPlain,
      registration: regPlain,
      date_registration: datePlain,
      // sorted to keep field_map stable across runs that may return phones in
      // different order
      phones_main: [...mainPhones].sort(),
      phones_description: [...descPhones].sort(),
    },
    verified_car: advert.verifiedCar ?? null,
    verified_car_fields: advert.verifiedCarFields || null,
    is_used_car: advert.isUsedCar ?? null,
    is_parts: advert.isParts ?? null,
    packages: advert.packages || [],
    // The source returns promoted-service rows in unstable order (`bump_up`
    // before/after `export_olx` etc.). Sorting by semantic fields keeps
    // reorder-only churn out of field_map and listing_changes while still
    // preserving real changes like a fresh bump timestamp or new validity.
    value_added_services: normalizeValueAddedServices(advert.valueAddedServices || []),
  });

  // IMPORTANT: keep `listing_card` OUT of the diffable field map. page_number and
  // page_position fluctuate every run, so feeding them into flattenForDiff would
  // poison field_map with phantom changes on every snapshot. They live only in
  // the persisted payload for debugging the discovery context.
  const payload = stableValue({
    ...snapshotPayload,
    listing_card: {
      page_number: card.page_number,
      page_position: card.page_position,
      short_description: card.short_description,
    },
  });
  const fieldMap = flattenForDiff(snapshotPayload);

  return {
    external_id: advert.id,
    listing_url: advert.url,
    title: advert.title || null,
    current_status: advert.status || null,
    seller_type: seller.type || null,
    price_amount: advert.price?.value || null,
    // last_mileage / last_year were historically pulled from advert.details which
    // serializes the human label ("68 000 km") not the raw value ("68000"), which
    // broke `CAST(l.last_mileage AS REAL)` filtering in the UI (parsed as 68
    // because Number/CAST stops at the first space). Now that we extract typed
    // values via params, just use those — they're guaranteed integers — and
    // stringify them for the legacy text columns.
    mileage: params.mileage != null ? String(params.mileage) : (card.mileage != null ? String(card.mileage) : null),
    year: params.year != null ? String(params.year) : (card.year != null ? String(card.year) : null),
    description_text: descriptionText,
    condition: extractCondition(parameters),
    payload,
    field_map: fieldMap,
    // ----- new top-level fields populated into listings columns -----
    vin: vinPlain,
    registration: regPlain,
    date_registration: datePlain,
    phones_json: phonesJson,
    image_count: imageCount,
    seller_uuid: seller.uuid || null,
    seller_id: seller.id != null ? String(seller.id) : null,
    seller_name: seller.name || null,
    seller_location_city: sellerLocation?.city || null,
    seller_location_region: sellerLocation?.region || null,
    seller_location_lat: sellerLocation?.map?.latitude ?? null,
    seller_location_lon: sellerLocation?.map?.longitude ?? null,
    advert_created_at: advert.createdAt || null,
    advert_updated_at: advert.updatedAt || null,
    advert_original_created_at: advert.originalCreatedAt || null,
    price_currency: advert.price?.currency || null,
    price_labels_json: JSON.stringify(advert.price?.labels || []),
    verified_car: advert.verifiedCar ? 1 : advert.verifiedCar === false ? 0 : null,
    is_used_car: advert.isUsedCar ? 1 : advert.isUsedCar === false ? 0 : null,
    is_parts: advert.isParts ? 1 : advert.isParts === false ? 0 : null,
    params,
  };
}

// Wyciąga znormalizowany "stan i historia" z parametersDict. Wartości boolowskie
// (Tak/Nie) konwertujemy na 1/0/null żeby dało się po nich filtrować w SQL.
// Wartości tekstowe (kraj pochodzenia, nowy/używany) zostawiamy jako string.
function extractCondition(parameters) {
  return {
    damaged: yesNoToInt(firstParamLabel(parameters.damaged)),
    no_accident: yesNoToInt(firstParamLabel(parameters.no_accident)),
    service_record: yesNoToInt(firstParamLabel(parameters.service_record)),
    original_owner: yesNoToInt(firstParamLabel(parameters.original_owner)),
    is_imported_car: yesNoToInt(firstParamLabel(parameters.is_imported_car)),
    tuning: yesNoToInt(firstParamLabel(parameters.tuning)),
    historical_vehicle: yesNoToInt(firstParamLabel(parameters.historical_vehicle)),
    registered: yesNoToInt(firstParamLabel(parameters.registered)),
    new_used: firstParamLabel(parameters.new_used) || null,
    country_origin: firstParamLabel(parameters.country_origin) || null,
  };
}

function firstParamLabel(param) {
  return param?.values?.[0]?.label ?? null;
}

function yesNoToInt(v) {
  if (v === "Tak") return 1;
  if (v === "Nie") return 0;
  return null;
}

function parameterMap(parameters) {
  return parameters.reduce((acc, item) => {
    if (item?.key) {
      acc[item.key] = item.displayValue || item.value || null;
    }
    return acc;
  }, {});
}

function countDuplicates(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.ad_id] = (counts[row.ad_id] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1));
}

export function snapshotHash(detail) {
  return sha256Hex(stableStringify(detail.field_map));
}
