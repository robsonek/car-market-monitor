import { state, el, query, clickStartedInInteractiveElement } from "../core.js";
import {
  formatPrice,
  formatMileage,
  formatRelative,
  formatDate,
  isValidVin,
  isValidRegistration,
} from "../format.js";
import {
  statCard,
  detailMetaChip,
  listingLink,
  activeBadge,
  matchTypeBadge,
  truncate,
  formatEnum,
  formatSellerLabel,
  createWatchToggleButton,
  renderSparkline,
} from "../ui.js";
import { filterVisibleChanges, renderDiffSide } from "../changes-render.js";
import { parsePhonesJson, renderDescriptionHtml, renderPhoneList } from "../description-render.js";
import { openGalleryLightbox } from "../gallery-lightbox.js";
import { navigate, buildHash } from "../router.js";

export function viewListingDetail(view, id) {
  const isCompactDetail = window.matchMedia("(max-width: 720px)").matches;
  const listing = query(
    state.db,
    `SELECT l.*, s.name AS source_name FROM listings l JOIN sources s ON s.id = l.source_id WHERE l.id = ?`,
    [id],
  )[0];
  if (!listing) {
    view.appendChild(el("p", { class: "empty" }, `Nie ma listingu o id ${id}`));
    return;
  }

  const sellerLabel = formatSellerLabel(listing);
  const sellerTypeLabel = listing.seller_type
    ? (listing.seller_type === "BUSINESS" ? "Firma" : listing.seller_type === "PRIVATE" ? "Osoba prywatna" : listing.seller_type)
    : null;
  const sellerListingsHref = listing.seller_uuid
    ? buildHash("#/listings", { sellerUuid: listing.seller_uuid })
    : null;
  const detailWatchToggle = createWatchToggleButton(listing);
  if (detailWatchToggle) detailWatchToggle.classList.add("detail-action-button");

  view.appendChild(el(
    "div", { class: "detail-header" },
    el("div", { class: "detail-title-row" },
      el("div", { class: "detail-title-block" },
        el("div", { class: "detail-eyebrow" }, "Oferta", activeBadge(listing.is_active)),
        el("h1", {}, listing.title || listing.external_id),
      ),
      el("div", { class: "detail-title-actions" },
        detailWatchToggle,
        el("a", { href: listing.listing_url, target: "_blank", rel: "noopener", class: "detail-action-link" }, "Otwórz ofertę ↗"),
        sellerListingsHref ? el("a", { href: sellerListingsHref, class: "detail-inline-link" }, "Wszystkie oferty sprzedawcy") : null,
      ),
    ),
    el("div", { class: "meta" },
      detailMetaChip("Źródło", listing.source_name),
      sellerTypeLabel ? detailMetaChip("Sprzedawca", sellerTypeLabel) : null,
      sellerLabel ? detailMetaChip("Konto", sellerLabel) : null,
      detailMetaChip("External id", listing.external_id, { mono: true }),
    ),
  ));

  // Najważniejsze meta jako stat cards. Pierwszy rząd to standardowe price/year/mileage,
  // drugi rząd to specyfikacja techniczna z params columns (fuel_type, body_type, ...)
  // — pojawia się tylko jeśli te dane mamy (większość listingów ma).
  // Build the full list in one cards grid so specs fill the trailing gap
  // after the date cards instead of starting a new sparse row. Filter
  // falsy entries BEFORE Element.append — DOM append() coerces null/undefined
  // into "null"/"undefined" text nodes (manifested as stray "nullnull" next
  // to spec cards for non-EV listings where battery_capacity/autonomy are
  // null). Our `el()` helper filters these out, but raw DOM append does not.
  // Snapshot payload ładujemy przed cardList — potrzebujemy z niego
  // value_added_services do karty "Ostatnie podbicie". Galeria i opis poniżej
  // używają tego samego obiektu, więc parsujemy raz.
  const lastSnapshot = listing.last_snapshot_id
    ? query(state.db, "SELECT payload_json FROM listing_snapshots WHERE id = ?", [listing.last_snapshot_id])[0]
    : null;
  let snapshotPayload = null;
  let galleryUrls = [];
  if (lastSnapshot?.payload_json) {
    try {
      snapshotPayload = JSON.parse(lastSnapshot.payload_json);
      if (Array.isArray(snapshotPayload.images?.urls)) {
        galleryUrls = snapshotPayload.images.urls;
      }
    } catch {}
  }
  const lastBumpAt = Array.isArray(snapshotPayload?.value_added_services)
    ? snapshotPayload.value_added_services.find((s) => s?.name === "bump_up")?.appliedAt ?? null
    : null;

  const hasSpecs = listing.fuel_type || listing.body_type || listing.gearbox || listing.engine_power;
  const cardList = [
    statCard("Cena", formatPrice(listing.last_price_amount)),
    statCard("Rok", listing.year || listing.last_year || "—"),
    statCard("Przebieg", formatMileage(listing.mileage || listing.last_mileage)),
    statCard("Dodano na otomoto", formatDate(listing.advert_original_created_at)),
    statCard("Widoczna data", formatDate(listing.advert_created_at)),
    lastBumpAt ? statCard("Ostatnie podbicie", formatDate(lastBumpAt)) : null,
    statCard("Ostatnia edycja", formatDate(listing.advert_updated_at)),
    statCard("Monitorowane od", formatDate(listing.first_seen_at)),
    statCard("Ostatnio widoczne", formatDate(listing.last_seen_at)),
    hasSpecs ? statCard("Paliwo", formatEnum(listing.fuel_type)) : null,
    hasSpecs ? statCard("Nadwozie", formatEnum(listing.body_type)) : null,
    hasSpecs ? statCard("Skrzynia", formatEnum(listing.gearbox)) : null,
    hasSpecs ? statCard("Moc", listing.engine_power ? `${listing.engine_power} KM` : "—") : null,
    // EV-specific: pojemność baterii i zasięg pokazujemy tylko jeśli auto
    // ma te pola. Dla benzyniaków by było mylące (a battery_capacity = null).
    listing.battery_capacity ? statCard("Bateria", `${listing.battery_capacity} kWh`) : null,
    listing.autonomy ? statCard("Zasięg", `${listing.autonomy} km`) : null,
  ].filter(Boolean);
  const cards = el("div", { class: "cards" });
  cards.append(...cardList);
  view.appendChild(cards);

  // ----- Panel: Gallery (zdjęcia z last snapshot payload_json) -----
  // Renders a responsive CSS grid of 4:3 thumbnails, klik otwiera lightbox
  // wewnątrz aplikacji zamiast wysyłać usera do nowej karty z CDN-em
  // marketplace'u.
  if (galleryUrls.length > 0) {
    const thumbUrls = galleryUrls.map((u) => u + ";s=268x0;q=80");
    const fullUrls = galleryUrls.map((u) => u + ";s=3412x0;q=100");
    const galleryPanel = el("div", { class: "panel" });
    galleryPanel.appendChild(el("div", { class: "panel-header" }, `Zdjęcia (${galleryUrls.length})`));
    const grid = el("div", { class: "listing-gallery" });
    const collapsibleGallery = isCompactDetail && galleryUrls.length > 6;
    if (collapsibleGallery) grid.classList.add("is-collapsed");
    for (const [index, url] of thumbUrls.entries()) {
      const thumbButton = el(
        "button",
        {
          type: "button",
          class: "gallery-item",
          title: `Otwórz galerię (${index + 1} / ${galleryUrls.length})`,
          "aria-label": `Otwórz galerię, zdjęcie ${index + 1} z ${galleryUrls.length}`,
          onclick: () => openGalleryLightbox(fullUrls, index, thumbButton),
        },
        el("img", { src: url, loading: "lazy", alt: "" }),
      );
      grid.appendChild(thumbButton);
    }
    galleryPanel.appendChild(grid);
    if (collapsibleGallery) {
      const toggle = el("button", {
        type: "button",
        class: "secondary detail-section-toggle",
        onclick: () => {
          const collapsed = grid.classList.toggle("is-collapsed");
          toggle.textContent = collapsed
            ? `Pokaż wszystkie zdjęcia (${galleryUrls.length})`
            : "Zwiń zdjęcia";
        },
      }, `Pokaż wszystkie zdjęcia (${galleryUrls.length})`);
      galleryPanel.appendChild(el("div", { class: "panel-actions" }, toggle));
    }
    view.appendChild(galleryPanel);
  }

  const phones = parsePhonesJson(listing.phones_json);

  // ----- Panel: Opis sprzedawcy -----
  // Opis żyje wyłącznie jako znormalizowany HTML w payload_json.description_html.
  // Phone tokeny są już rozwiązane przy ingest'cie (marketplace-source.js), więc
  // frontend nie musi nic podmieniać — tylko przepuszcza przez lokalny
  // sanitizer jako drugą linię obrony (XSS-hardening na wypadek kompromitacji
  // bazy albo buga w ingest'cie).
  const richDescription = renderDescriptionHtml(snapshotPayload?.description_html);
  if (richDescription) {
    const descPanel = el("div", { class: "panel" });
    descPanel.appendChild(el("div", { class: "panel-header" }, "Opis sprzedawcy"));
    const descBody = el("div", { class: "description-body" }, richDescription);
    const collapsibleDescription = isCompactDetail && (descBody.textContent || "").trim().length > 420;
    if (collapsibleDescription) descBody.classList.add("is-collapsed");
    descPanel.appendChild(descBody);
    if (collapsibleDescription) {
      const toggle = el("button", {
        type: "button",
        class: "secondary detail-section-toggle",
        onclick: () => {
          const collapsed = descBody.classList.toggle("is-collapsed");
          toggle.textContent = collapsed ? "Pokaż pełny opis" : "Zwiń opis";
        },
      }, "Pokaż pełny opis");
      descPanel.appendChild(el("div", { class: "panel-actions" }, toggle));
    }
    view.appendChild(descPanel);
  }

  // ----- Panel: Identyfikacja -----
  // VIN, numer rejestracyjny, data pierwszej rejestracji i telefony.
  // Wszystkie pola są opcjonalne — sprzedawcy nie są zmuszeni je wypełniać.
  // Panel pokazujemy zawsze (nawet jeśli wszystko puste) bo brak VIN/rejestracji
  // sam w sobie jest sygnałem (np. "auto bez papierów" = warto wiedzieć).
  const idPanel = el("div", { class: "panel" });
  idPanel.appendChild(el("div", { class: "panel-header" }, "Identyfikacja"));
  const idTable = el("table");
  const idBody = el("tbody");
  const vinValid = listing.vin && isValidVin(listing.vin);
  const vinDisplay = !listing.vin
    ? el("span", { class: "muted" }, "—")
    : vinValid
      ? document.createTextNode(listing.vin)
      : el("span", {},
          document.createTextNode(listing.vin + " "),
          el("span", { class: "badge badge-failed", style: "font-size:11px;" }, "nieprawidlowy"),
        );
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "VIN"),
    el("td", { class: listing.vin ? "tabular" : "muted" }, vinDisplay),
  ));
  const regValid = listing.registration && isValidRegistration(listing.registration);
  const regDisplay = !listing.registration
    ? el("span", { class: "muted" }, "—")
    : regValid
      ? document.createTextNode(listing.registration)
      : el("span", {},
          document.createTextNode(listing.registration + " "),
          el("span", { class: "badge badge-failed", style: "font-size:11px;" }, "nieprawidlowy"),
        );
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Numer rejestracyjny"),
    el("td", { class: listing.registration ? "tabular" : "muted" }, regDisplay),
  ));
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Pierwsza rejestracja"),
    el("td", { class: listing.date_registration ? "tabular" : "muted" }, listing.date_registration || "—"),
  ));
  // Telefony renderujemy osobno dla pól głównych i tych znalezionych w opisie.
  idBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Telefony (główne)"),
    el("td", {}, renderPhoneList(phones.main)),
  ));
  if (phones.description.length > 0) {
    idBody.appendChild(el("tr", { class: "no-click" },
      el("th", {}, "Telefony (z opisu)"),
      el("td", {}, renderPhoneList(phones.description)),
    ));
  }
  idTable.appendChild(idBody);
  idPanel.appendChild(idTable);
  view.appendChild(idPanel);

  // ----- Panel: Wznowienia (relistings) -----
  const relistingRows = query(
    state.db,
    `SELECT r.match_type,
       CASE WHEN r.old_listing_id = ? THEN 'relisted_as' ELSE 'relisting_of' END AS direction,
       CASE WHEN r.old_listing_id = ? THEN r.new_listing_id ELSE r.old_listing_id END AS related_id,
       CASE WHEN r.old_listing_id = ? THEN new.title ELSE old.title END AS related_title,
       CASE WHEN r.old_listing_id = ? THEN new.last_price_amount ELSE old.last_price_amount END AS related_price,
       CASE WHEN r.old_listing_id = ? THEN new.last_mileage ELSE old.last_mileage END AS related_mileage,
       CASE WHEN r.old_listing_id = ? THEN new.is_active ELSE old.is_active END AS related_active,
       r.detected_at
     FROM listing_relistings r
     JOIN listings old ON old.id = r.old_listing_id
     JOIN listings new ON new.id = r.new_listing_id
     WHERE r.old_listing_id = ? OR r.new_listing_id = ?`,
    [id, id, id, id, id, id, id, id],
  );
  if (relistingRows.length > 0) {
    // Add badge to eyebrow
    const eyebrow = view.querySelector(".detail-eyebrow");
    if (eyebrow) {
      eyebrow.appendChild(el("span", { class: "badge badge-relisting" }, "wznowione"));
    }

    const relistPanel = el("div", { class: "panel" });
    relistPanel.appendChild(el("div", { class: "panel-header" },
      "Wznowienia ",
      el("a", { href: buildHash("#/relistings", { q: listing.vin || listing.registration || "" }), class: "muted", style: "font-weight:normal;font-size:13px;" }, "zobacz wszystkie"),
    ));
    const relistTable = el("table");
    relistTable.appendChild(el("thead", {}, el("tr", {},
      el("th", {}, "Kierunek"),
      el("th", {}, "Typ"),
      el("th", {}, "Powiazane ogloszenie"),
      el("th", { class: "num" }, "Cena"),
      el("th", { class: "num" }, "Przebieg"),
      el("th", {}, "Status"),
      el("th", {}, "Wykryto"),
    )));
    const relistBody = el("tbody");
    for (const rr of relistingRows) {
      const dirLabel = rr.direction === "relisted_as" ? "wznowione jako ->" : "<- wznowienie z";
      relistBody.appendChild(el("tr", {
        onclick: (event) => {
          if (clickStartedInInteractiveElement(event)) return;
          navigate(`#/listing/${rr.related_id}`);
        },
      },
        el("td", { class: "muted" }, dirLabel),
        el("td", {}, matchTypeBadge(rr.match_type)),
        el("td", {}, listingLink(rr.related_id, truncate(rr.related_title, 50))),
        el("td", { class: "num tabular" }, formatPrice(rr.related_price)),
        el("td", { class: "num tabular" }, formatMileage(rr.related_mileage)),
        el("td", {}, activeBadge(rr.related_active)),
        el("td", { class: "tabular muted" }, formatRelative(rr.detected_at)),
      ));
    }
    relistTable.appendChild(relistBody);
    relistPanel.appendChild(relistTable);
    view.appendChild(relistPanel);
  }

  // Stan i historia (z denormalizowanych kolumn listings)
  const conditionPanel = el("div", { class: "panel" });
  conditionPanel.appendChild(el("div", { class: "panel-header" }, "Stan i historia (deklaracja sprzedawcy)"));
  const conditionRows = [
    ["Uszkodzony", listing.damaged, true],          // true = bad if Yes
    ["Bezwypadkowy", listing.no_accident, false],   // false = good if Yes
    ["Książka serwisowa", listing.service_record, false],
    ["Pierwszy właściciel", listing.original_owner, false],
    ["Sprowadzony", listing.is_imported_car, null], // null = neutral
    ["Tuningowany", listing.tuning, true],
    ["Pojazd zabytkowy", listing.historical_vehicle, null],
    ["Zarejestrowany", listing.registered, false],
  ];
  const conditionTable = el("table");
  const conditionBody = el("tbody");
  for (const [label, value, badIfYes] of conditionRows) {
    let display, cls;
    if (value == null) {
      display = "—";
      cls = "muted";
    } else if (value === 1) {
      display = "Tak";
      cls = badIfYes === true ? "price-rise" : badIfYes === false ? "price-drop" : "";
    } else {
      display = "Nie";
      cls = badIfYes === true ? "price-drop" : badIfYes === false ? "price-rise" : "muted";
    }
    conditionBody.appendChild(el("tr", { class: "no-click" },
      el("th", {}, label),
      el("td", { class: cls }, display),
    ));
  }
  // text fields
  conditionBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Stan"),
    el("td", {}, listing.new_used || "—"),
  ));
  conditionBody.appendChild(el("tr", { class: "no-click" },
    el("th", {}, "Kraj pochodzenia"),
    el("td", {}, listing.country_origin || "—"),
  ));
  conditionTable.appendChild(conditionBody);
  conditionPanel.appendChild(conditionTable);
  view.appendChild(conditionPanel);

  // Price history
  const snapshots = query(
    state.db,
    `SELECT id, run_id, snapshot_hash, captured_at, price_amount, mileage
     FROM listing_snapshots WHERE listing_id = ? ORDER BY captured_at ASC`,
    [id],
  );
  const priceSeries = snapshots
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: Number(s.price_amount) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  const mileageSeries = snapshots
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: Number(s.mileage) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0);

  if (!isCompactDetail || priceSeries.length >= 2) {
    const pricePanel = el("div", { class: "panel" });
    pricePanel.appendChild(el("div", { class: "panel-header" }, `Historia ceny (${priceSeries.length} snapshotów)`));
    pricePanel.appendChild(
      priceSeries.length >= 2
        ? renderSparkline(priceSeries, 720, 120)
        : el("p", { class: "empty" }, "Za mało snapshotów żeby narysować historię."),
    );
    view.appendChild(pricePanel);
  }

  if (!isCompactDetail || mileageSeries.length >= 2) {
    const mileagePanel = el("div", { class: "panel" });
    mileagePanel.appendChild(el("div", { class: "panel-header" }, `Historia przebiegu (${mileageSeries.length} snapshotów)`));
    mileagePanel.appendChild(
      mileageSeries.length >= 2
        ? renderSparkline(mileageSeries, 720, 120, { color: "#10b981", formatLabel: formatMileage })
        : el("p", { class: "empty" }, "Za mało snapshotów żeby narysować historię."),
    );
    view.appendChild(mileagePanel);
  }

  // Timeline of changes
  const changes = filterVisibleChanges(query(
    state.db,
    `SELECT id, created_at, field_name, old_value, new_value
     FROM listing_changes WHERE listing_id = ?
     ORDER BY created_at DESC, field_name ASC LIMIT 500`,
    [id],
  ));
  const timelinePanel = el("div", { class: "panel" });
  timelinePanel.appendChild(el("div", { class: "panel-header" }, `Zmiany (${changes.length})`));
  if (changes.length === 0) {
    timelinePanel.appendChild(el("p", { class: "empty" }, "Brak zmian."));
  } else {
    const ul = el("ul", { class: "timeline" });
    for (const c of changes) {
      ul.appendChild(el("li", {},
        el("div", { class: "when" }, formatDate(c.created_at)),
        el("div", {},
          el("div", { class: "field" }, c.field_name),
          el("div", { class: "diff-row" },
            el("span", { class: "change-old" }, renderDiffSide("old", c.old_value, c.new_value, c.field_name)),
            el("span", { class: "diff-arrow" }, " → "),
            el("span", { class: "change-new" }, renderDiffSide("new", c.new_value, c.old_value, c.field_name)),
          ),
        ),
      ));
    }
    timelinePanel.appendChild(ul);
  }
  view.appendChild(timelinePanel);

  // Snapshots list
  const snapPanel = el("div", { class: "panel" });
  snapPanel.appendChild(el("div", { class: "panel-header" }, `Snapshoty (${snapshots.length})`));
  if (snapshots.length === 0) {
    snapPanel.appendChild(el("p", { class: "empty" }, "Brak snapshotów (oferta widziana tylko z karty)."));
  } else {
    const table = el("table");
    table.appendChild(el("thead", {}, el("tr", {},
      el("th", {}, "Kiedy"),
      el("th", {}, "Hash"),
      el("th", { class: "num" }, "Cena"),
    )));
    const tbody = el("tbody");
    for (const s of snapshots.slice().reverse()) {
      tbody.appendChild(el("tr", { class: "no-click" },
        el("td", { class: "tabular muted" }, formatDate(s.captured_at)),
        el("td", { class: "muted" }, s.snapshot_hash.slice(0, 12)),
        el("td", { class: "num tabular" }, formatPrice(s.price_amount)),
      ));
    }
    table.appendChild(tbody);
    snapPanel.appendChild(table);
  }
  view.appendChild(snapPanel);
}
