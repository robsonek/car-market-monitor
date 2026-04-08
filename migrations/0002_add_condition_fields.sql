-- Stan i historia pojazdu - pola wyciągane z parametersDict w normalizeDetail
-- przy każdym scrape. Wszystkie są deklaracjami sprzedawcy w formularzu źródła
-- (nie weryfikowane). Tutaj denormalizowane do osobnych kolumn żeby dało się
-- po nich filtrować w dashboardzie bez parsowania payload_json za każdym razem.

ALTER TABLE listings ADD COLUMN damaged INTEGER;            -- 1=Tak (uszkodzony), 0=Nie, NULL=brak
ALTER TABLE listings ADD COLUMN no_accident INTEGER;        -- 1=bezwypadkowy
ALTER TABLE listings ADD COLUMN service_record INTEGER;     -- 1=ma książkę serwisową
ALTER TABLE listings ADD COLUMN original_owner INTEGER;     -- 1=pierwszy właściciel
ALTER TABLE listings ADD COLUMN is_imported_car INTEGER;    -- 1=sprowadzony
ALTER TABLE listings ADD COLUMN tuning INTEGER;             -- 1=tuningowany
ALTER TABLE listings ADD COLUMN historical_vehicle INTEGER; -- 1=zabytkowy
ALTER TABLE listings ADD COLUMN registered INTEGER;         -- 1=zarejestrowany
ALTER TABLE listings ADD COLUMN new_used TEXT;              -- "Nowy" / "Używany"
ALTER TABLE listings ADD COLUMN country_origin TEXT;        -- "Polska" / "Niemcy" / itd.
