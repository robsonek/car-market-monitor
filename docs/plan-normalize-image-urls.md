# Plan: Normalizacja URL-i zdjęć Apollo CDN przez fn z JWT

## Problem

Apollo CDN (ireland.apollo.olxcdn.com) generuje nowe podpisane URL-e przy każdym renderze strony na OTOMOTO. Te same zdjęcia dostają zupełnie inne URL-e, co powoduje ~500 fałszywych wpisów `images.urls` w `listing_changes` po każdym scrapie.

## Obserwacja

Każdy URL ma strukturę:
```
https://ireland.apollo.olxcdn.com/v1/files/{header}.{payload}.{signature}/image
```

Payload JWT (base64url) zawiera pole `fn` — stabilny identyfikator zdjęcia, np. `pl71njv08zef-OTOMOTOPL`. Ten identyfikator **nie zmienia się** między rotacjami URL-i.

Zweryfikowano na prawdziwych danych: stare i nowe URL-e mają identyczny zestaw `fn`, różnią się tylko kolejnością i sygnaturą.

ETag z headerów HTTP CDN też odpowiada `fn` — dodatkowe potwierdzenie stabilności.

## Rozwiązanie

Normalizować URL-e do `fn` przy porównywaniu w `areFieldValuesEquivalent` (src/lib/scrape.js):

1. Dla każdego URL-a w tablicy `images.urls` wyciągnąć `fn` z payloadu JWT (base64url decode, zero requestów HTTP)
2. Porównać zestawy `fn`-ów (Set equality) — jeśli identyczne, traktować jako ekwiwalentne
3. Jeśli zestaw `fn` się różni — prawdziwa zmiana (dodano/usunięto zdjęcia)

## Korzyści vs poprzednie podejście (usunięte w commit 1af2bc1)

Poprzednia logika (`shared/image-urls.js`) opierała się na heurystyce: "jeśli wszystkie URL-e to Apollo i zero overlap, to pewnie rotacja CDN". Nie potrafiła odróżnić rotacji od prawdziwej wymiany zdjęć na inne.

Nowe podejście oparte na `fn` jest deterministyczne — wiemy dokładnie które zdjęcia zostały dodane/usunięte.

## Pliki do zmodyfikowania

- `src/lib/scrape.js` — `areFieldValuesEquivalent` dla `images.urls`
- `web/app.js` — `renderImageDiffSide` (porównywanie po `fn` zamiast po surowym URL)
- Nowe testy jednostkowe dla ekstrakcji `fn` z JWT

## Uwagi

- Dekodowanie JWT payloadu to operacja lokalna (base64url → JSON.parse), zero requestów HTTP
- Fallback na surowe URL-e dla nie-Apollo URL-i (np. inne CDN-y)
- Kolejność zdjęć zachowujemy oryginalną (bez sort), porównujemy tylko zestawy `fn`
