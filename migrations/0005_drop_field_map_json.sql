-- Field map jest teraz liczony dynamicznie z payload_json (patrz loadFieldMap
-- w src/lib/scrape.js). Trzymanie spłaszczonej kopii dla każdego snapshotu było
-- największym składnikiem bazy (~36 MB z ~70 MB). Kolumna zostaje w schemacie
-- (NOT NULL) dla kompatybilności wstecznej, ale wszystkie wiersze dostają pusty
-- string. Po migracji warto uruchomić `VACUUM` ręcznie — SQLite nie zwalnia
-- miejsca z pliku do czasu vacuumu, a VACUUM nie może działać wewnątrz
-- transakcji, więc migrationrunner go nie odpala.
UPDATE listing_snapshots SET field_map_json = '';
