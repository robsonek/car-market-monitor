-- Usuwamy duplikaty pola opisu z payload_json.
--
-- description_html: był w NOISY_FIELD_PREFIXES (patrz src/lib/scrape.js), więc
-- i tak nigdy nie wchodził do hasha/diffów. Siedział w payloadzie tylko dla
-- pełności, zajmując ~2.5 MB bez żadnego użytku. Marketplace-source od teraz
-- w ogóle go nie zapisuje.
--
-- description_text: jest częścią field_mapa (flattenForDiff), ale trzymamy go
-- już w osobnej kolumnie listing_snapshots.description_text (używanej przez
-- search w dashboardzie), więc kopia w JSON to była czysta duplikacja ~2 MB.
-- src/lib/scrape.js:loadFieldMap() wstrzykuje go z powrotem z kolumny przed
-- flattenem, żeby hash pozostał stabilny.
--
-- json_remove zachowuje resztę struktury nietkniętą. Po migracji warto
-- uruchomić VACUUM ręcznie — migration runner nie odpala VACUUM, bo nie może
-- działać wewnątrz transakcji.
UPDATE listing_snapshots
SET payload_json = json_remove(payload_json, '$.description_html', '$.description_text');
