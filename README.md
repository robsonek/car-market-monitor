# Car Market Monitor (GitHub Actions edition)

Monitor zapisanych wyszukiwarek ofert. Obecnie źródłem jest jeden marketplace z ofertami samochodów osobowych. Co 8h GitHub Actions pobiera wszystkie strony listingu, ściąga detale ofert, zapisuje pełne snapshoty do SQLite i wykrywa zmiany pól między kolejnymi przebiegami. Cała baza siedzi jako pojedynczy plik `db/car-market-monitor.sqlite` commitowany do repo - dzięki temu **historia danych** żyje w git tak samo jak historia kodu.

## Architektura

- **GitHub Actions cron** (`0 */8 * * *`) odpala workflow `scrape`.
- Workflow uruchamia jeden proces Node 24 (`bin/run.js`).
- Proces przechodzi po źródłach **sekwencyjnie** (`p-limit(1)`) i w obrębie każdego źródła pobiera detale też sekwencyjnie (`p-limit(1)`) - żeby nie złapać bana od źródłowego marketplace'u.
- Cała faza zapisu (snapshoty + diffy + reconcile + run row) leci w pojedynczej transakcji `better-sqlite3` per źródło. Jeśli proces padnie w połowie - transakcja jest rolled-back, więc nie ma "pół-finalizowanego" stanu.
- Po sukcesie workflow commitouje zaktualizowany `db/car-market-monitor.sqlite` z powrotem do repo.

## Pipeline (per źródło)

1. **Discovery** - pobranie wszystkich stron listingu, dedup ofert po `external_id`. Discovery pinuje `search[order]=created_at:desc` żeby paginacja była deterministyczna - default ordering źródła miesza promoted ads na każdą stronę i powoduje że ten sam ad pojawia się w wielu miejscach kradnąc sloty unikalnym ofertom (empirycznie: 436 reported total → tylko 368 unique bez pinned sortu).
2. **Detail fetch** - dla każdej oferty osobny request HTTP, max 3 próby z exponential delay.
3. **Normalize detail** - odpowiedź detalu jest zamieniana na stabilny payload i zestaw kolumn używanych przez SQLite, diffy i dashboard.
4. **Apply** (jedna transakcja):
   - Sukces detalu: insert/update listing + nowy `listing_snapshots` (jeśli hash filtered field_map się zmienił) + `listing_changes` z diffem pól.
   - Porażka detalu: refresh `last_price_amount/mileage/year/title/url` z karty listingu - karty mają price/mileage/year, więc nawet bez detalu nie pokazujemy stale data.
   - **Reconcile z hysteresis** (`MISSING_THRESHOLD=2`): oferty, których nie widzieliśmy w tym runie, najpierw dostają tylko `missed_count++`. Dopiero **dwa kolejne missy z rzędu** flipują `is_active = 0` i emitują `__listing_status: ACTIVE → MISSING`. Reset licznika dzieje się przy normalnym apply. To eliminuje false-positive z momentów gdy promoted ad chwilowo wypchnął ofertę poza naszą paginację.
   - Insert wiersza w `scrape_runs` z finalnym statusem (`SUCCESS` / `PARTIAL_SUCCESS` / `FAILED`) i licznikami.

`PARTIAL_SUCCESS` oznacza, że część detali się nie pobrała, ale część tak. `FAILED` oznacza, że wszystkie detale się sypnęły **albo** discovery padło na samym starcie.

## Co zapisujemy

Dla każdego monitorowanego linku:

- źródło i historię runów (`scrape_runs`),
- bieżący stan oferty (`listings`) - wszystkie 152 znane parametry z `parametersDict` jako typowane kolumny SQL plus dodatkowe pola detalu używane przez filtry i dashboard,
- pełne snapshoty szczegółów (`listing_snapshots.payload_json`),
- diff pól między snapshotami (`listing_changes`),
- zniknięcie i powrót oferty (po hysteresis).

Snapshot detalu obejmuje cenę, przebieg, rok, opis, status, sprzedawcę z lokalizacją, ~150 parametrów (powertrain, EV, safety, comfort, tech, lighting, wheels), wyposażenie, listę zdjęć i dodatkowe pola identyfikacyjne/kontaktowe potrzebne w UI.

## Struktura

- [bin/run.js](bin/run.js): CLI uruchamiany przez workflow.
- [bin/sources.js](bin/sources.js): CLI do zarządzania źródłami.
- [bin/backfill-condition.js](bin/backfill-condition.js): historyczny backfill wzorzec dla kolumn z migracji 0002.
- [src/lib/db.js](src/lib/db.js): otwarcie SQLite + automatyczne migracje (PRAGMA user_version).
- [src/lib/marketplace-source.js](src/lib/marketplace-source.js): parser listingu i detalu, `normalizeDetail()` + `extractParams()`.
- [src/lib/marketplace-source-params.js](src/lib/marketplace-source-params.js): definicja 152 parameter keys + ich typów (TEXT/INT/REAL/BOOL) + `extractParams()` helper. **MUSI być w sync z migracją 0003** - dodanie nowego pola wymaga edycji obu plików.
- [src/lib/scrape.js](src/lib/scrape.js): orkiestracja runów, snapshoty, diffy, reconcile, hash filtering noisy fields.
- [src/lib/utils.js](src/lib/utils.js): hash, stable JSON, flatten dla diffów.
- [migrations/0001_init.sql](migrations/0001_init.sql): bazowy schemat (sources, scrape_runs, listings, listing_snapshots, listing_changes).
- [migrations/0002_add_condition_fields.sql](migrations/0002_add_condition_fields.sql): denormalizowane condition columns w listings.
- [.github/workflows/scrape.yml](.github/workflows/scrape.yml): cron + commit pliku bazy.

## Setup lokalny

```bash
npm install
```

To wystarczy. Plik `db/car-market-monitor.sqlite` powstanie sam przy pierwszym uruchomieniu - migracje są aplikowane automatycznie przez `openDatabase()`.

## Zarządzanie źródłami

```bash
# Dodanie źródła:
npm run sources -- add --url '<SOURCE_URL>' --name 'Porsche Taycan'

# Lista:
npm run sources -- list

# Wyłączenie z harmonogramu (zostaje w bazie z is_active = 0):
npm run sources -- disable --id <SOURCE_ID>
npm run sources -- enable --id <SOURCE_ID>

# Trwałe usunięcie:
npm run sources -- remove --id <SOURCE_ID>
```

Po zmianie źródeł zacommituj `db/car-market-monitor.sqlite` **oraz** `db/car-market-monitor.sqlite.version.json` do repo, żeby workflow miał dostęp do nowej listy, a dashboard dostał nowy cache key (inaczej browser serwuje starą kopię bazy ze swojego HTTP cache).

## Ręczne uruchomienie scrape

```bash
# Wszystkie aktywne źródła:
npm run scrape

# Tylko jedno źródło:
npm run scrape -- --source <SOURCE_ID>
```

Exit code:
- `0` - run się udał (nawet jeśli niektóre źródła miały `PARTIAL_SUCCESS`),
- `2` - **wszystkie** źródła zakończone statusem `FAILED`,
- `1` - hard crash skryptu.

## Workflow GitHub Actions

`.github/workflows/scrape.yml` ma trzy ścieżki uruchomienia:

1. Cron `0 */8 * * *` (UTC).
2. `workflow_dispatch` z opcjonalnym `source_id`.
3. (Możesz też dodać trigger na push, ale domyślnie tego nie ma, żeby nie scrape'ować przy każdym commicie kodu.)

`concurrency: scrape` gwarantuje, że dwa runy nie będą równocześnie commitować zmian w pliku bazy.

`permissions: contents: write` jest niezbędne, żeby workflow mógł `git push` z aktualizacją bazy.

## Jak działa wykrywanie zmian

- Z listingu bierzemy komplet widocznych ofert (paginacja z pinowanym `created_at:desc`).
- Z detalu budujemy stabilny `field_map` (rekurencyjny flatten z posortowanymi kluczami) po normalizacji odpowiedzi.
- Dla każdej oferty liczymy `sha256(filtered field_map)` - to `last_snapshot_hash`. **Filtrujemy noisy fields** (`NOISY_FIELD_PREFIXES` w `scrape.js`) PRZED hash, bo niektóre techniczne tokeny źródła rotują per render strony i bez filtra generowałyby phantom zmiany.
- Gdy hash się zmienia, zapisujemy nowy snapshot i diff pól.
- Gdy oferta przestaje być widoczna w discovery, najpierw bumpujemy `missed_count`. Dopiero **po dwóch missach z rzędu** flipujemy `is_active = 0` i emitujemy `__listing_status: ACTIVE → MISSING` (hysteresis).
- Gdy oferta wraca, zapisujemy `__listing_status: MISSING → ACTIVE` + dorzucamy diff pól, jeśli się zmieniły w międzyczasie.

## Dashboard (GitHub Pages)

W folderze `/web/` żyje statyczny dashboard SPA, który ładuje `db/car-market-monitor.sqlite` przez `sql.js` (WASM SQLite) prosto z repo. Brak backendu, brak kosztów, brak build stepu - po każdym scrape runie strona automatycznie pokazuje świeże dane (workflow commitouje plik bazy, GH Pages publikuje).

**Włączenie:**

1. Settings → Pages → **Build and deployment** → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save.
2. Po ~1 min strona jest dostępna pod `https://<user>.github.io/<repo>/web/`.

**Co potrafi:**

- **Home** - skrót ostatniego runu, top spadki cen z ostatnich 30 dni, świeżo zniknięte oferty (filtruje po aktualnym `is_active = 0` + ostatniej zmianie statusu, żeby reaktywowane nie pojawiały się jako "zniknięte"), świeżo dodane oferty, statystyki (aktywne / zniknięte / snapshoty / runy / źródła).
- **Listings** - tabela z filtrami: źródło, status (aktywne/zniknięte), stan (nowy/używany), paliwo, nadwozie, skrzynia, kraj pochodzenia, zakresy (rok, cena, przebieg, moc), tristate condition (uszkodzony, bezwypadkowy, książka serwisowa), search po tytule i opisie z multi-word AND. Filtry trzymane w URL hash (możesz zbookmarkować np. "Taycan ≤ 350k zł, ≤ 50k km, electric, ≥ 500 KM"). Wszystkie kolumny w tabeli klikalne (sortowanie).
- **Listing detail** - aktualny stan oferty + stat cards (cena, rok, przebieg, paliwo, nadwozie, skrzynia, moc, opcjonalnie bateria/zasięg dla EV) + **panel Identyfikacja** (pola identyfikacyjne i kontaktowe) + panel "Stan i historia" + sparkline ceny w czasie + timeline wszystkich `listing_changes` + lista snapshotów z toggle JSON viewerem.
- **Changes** - globalny changelog z filtrami: źródło, konkretne pole (np. tylko `price.value`), data od, search po tytule, checkbox "Pokaż nowe ogłoszenia" (domyślnie wyłączony, bo `__listing_created` zalewa feed). Klik w wiersz przenosi do detalu.
- **Runs** - historia scrape runów z statusem, czasem trwania, licznikami i błędami.

**Lokalny test bez deployu:**

```bash
python3 -m http.server 8000
# otwórz http://localhost:8000/web/
```

**Ograniczenie:** cały plik bazy ładuje się w pamięci przeglądarki. Działa płynnie do ~30-50 MB. Gdy `db/car-market-monitor.sqlite` urośnie do tej skali, można przejść na lazy loading przez [`sql.js-httpvfs`](https://github.com/phiresky/sql.js-httpvfs) (HTTP range requests).

**Cache:** dashboard nie re-downloaduje całej bazy na każde otwarcie strony. `bin/run.js` po zakończeniu runu generuje `db/car-market-monitor.sqlite.version.json` z sha256 pliku; dashboard fetchuje ten manifest (mały, zawsze świeży), a potem pobiera sam plik bazy z parametrem `?v=<sha>` — browser cachuje go normalnie i odświeża tylko gdy sha się zmienił.

**Bumpowanie sql.js:** loader (`web/sql-wasm.js`) i runtime (`web/sql-wasm.wasm`) są vendoryzowane lokalnie, bo cross-origin ładowanie z CDN nie działało stabilnie z GH Pages. Żeby podbić wersję:

```bash
node -e "
const fs=require('fs');
const v='X.Y.Z';
async function dl(f){const r=await fetch('https://cdn.jsdelivr.net/npm/sql.js@'+v+'/dist/'+f);fs.writeFileSync('web/'+f,Buffer.from(await r.arrayBuffer()));}
(async()=>{await dl('sql-wasm.js');await dl('sql-wasm.wasm');})();
"
```

Plus zaktualizuj komentarz `SQLJS_VERSION` w `web/app.js`.

## Ważne uwagi

- Cron w GitHub Actions może mieć opóźnienie kilku minut względem dokładnej godziny - to normalne, GH explicite tego nie gwarantuje.
- Źródło może zmienić strukturę `__NEXT_DATA__` - parser jest kruchy z natury, regresja w discovery będzie widoczna jako workflow z `FAILED` status na wszystkich źródłach.
- Plik bazy będzie rósł (snapshot detalu to ~5-20KB JSON). Przy ~5 źródłach × ~100 ofert × kilka snapshotów na ofertę dziennie to są dziesiątki MB rocznie. Jeśli zacznie boleć, można:
  - przenieść starsze snapshoty do osobnego pliku / R2,
  - włączyć git LFS dla `db/car-market-monitor.sqlite`.
- Workflow potrzebuje `permissions: contents: write` (już ustawione w yaml).
