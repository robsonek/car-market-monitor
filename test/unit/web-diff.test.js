import { test } from "node:test";
import assert from "node:assert/strict";

import { compactMultiLineSegments, diffLines, tokenDiffAsSegments } from "../../web/diff.js";

test("tokenDiffAsSegments keeps separate edit islands inside one paragraph", () => {
  const oldText = "Auto w idealnym stanie stanie technicznym i wizualnym, 100% bezwypadkowe ,żaden element nie malowany z niskim oryginalnym przebiegiem tylko 70 000 km, regularnie serwisowane, kupione w polskim salonie.";
  const newText = "Auto w idealnym stanie stanie technicznym i wizualnym, 100% bezwypadkowe ,żaden element nie malowany ,na aucie położona jest ceramika.Oryginalny niski przebiegiem tylko 70 000 km, regularnie serwisowane,bez wkładu finansowego kupione w polskim salonie.";
  const segments = tokenDiffAsSegments(oldText, newText);

  assert.equal(segments.some((seg) => seg.type === "added" && seg.text.includes("ceramika.Oryginalny niski")), true);
  assert.equal(segments.some((seg) => seg.type === "removed" && seg.text.includes("oryginalnym")), true);
  assert.equal(segments.some((seg) => seg.type === "added" && seg.text.includes("bez wkładu finansowego")), true);
  assert.equal(
    segments.some((seg) => seg.type === "common" && seg.text.includes("przebiegiem tylko 70 000 km, regularnie serwisowane,")),
    true,
  );
});

test("tokenDiffAsSegments keeps unchanged JSON-array tail and middle visible", () => {
  const oldText = "[\"Czujnik deszczu\",\"Dach otwierany elektrycznie\",\"Elektryczne szyby przednie\",\"Elektryczne szyby tylne\",\"Elektrycznie ustawiany fotel kierowcy\",\"Elektrycznie ustawiany fotel pasażera\",\"Kierownica ogrzewana\",\"Kierownica skórzana\",\"Kierownica sportowa\",\"Kierownica wielofunkcyjna\",\"Kierownica ze sterowaniem radia\",\"Klimatyzacja automatyczna: co najmniej 4 strefy\",\"Kolumna kierownicy regulowana elektrycznie\",\"Ogrzewane siedzenia tylne\",\"Podgrzewany fotel kierowcy\",\"Podgrzewany fotel pasażera\",\"Podłokietniki - przód\",\"Podłokietniki - tył\",\"Przyciemniane tylne szyby\",\"Regul. elektr. podparcia lędźwiowego - kierowca\",\"Regul. elektr. podparcia lędźwiowego - pasażer\",\"Rolety na bocznych szybach opuszczane elektrycznie\",\"Siedzenie z pamięcią ustawienia\",\"Sportowe fotele - przód\",\"Tapicerka skórzana\",\"Uruchamianie silnika bez użycia kluczyków\",\"Wycieraczki\",\"Zmiana biegów w kierownicy\"]";
  const newText = "[\"Czujnik deszczu\",\"Dach otwierany elektrycznie\",\"Drugi szyberdach szklany - przesuwny i uchylny el.\",\"Elektryczne szyby przednie\",\"Elektryczne szyby tylne\",\"Elektrycznie ustawiany fotel kierowcy\",\"Elektrycznie ustawiany fotel pasażera\",\"Kierownica ogrzewana\",\"Kierownica skórzana\",\"Kierownica sportowa\",\"Kierownica wielofunkcyjna\",\"Kierownica ze sterowaniem radia\",\"Klimatyzacja automatyczna: co najmniej 4 strefy\",\"Klimatyzacja dla pasażerów z tyłu\",\"Kolumna kierownicy regulowana elektrycznie\",\"Ogrzewane siedzenia tylne\",\"Podgrzewany fotel kierowcy\",\"Podgrzewany fotel pasażera\",\"Podłokietniki - przód\",\"Podłokietniki - tył\",\"Przyciemniane tylne szyby\",\"Siedzenie z pamięcią ustawienia\",\"Sportowe fotele - przód\",\"Tapicerka skórzana\",\"Uruchamianie silnika bez użycia kluczyków\",\"Wycieraczki\",\"Zmiana biegów w kierownicy\"]";
  const segments = tokenDiffAsSegments(oldText, newText);

  assert.equal(
    segments.some((seg) => seg.type === "added" && seg.text.includes("Drugi szyberdach szklany - przesuwny i uchylny el.")),
    true,
  );
  assert.equal(
    segments.some((seg) => seg.type === "added" && seg.text.includes("Klimatyzacja dla pasażerów z tyłu")),
    true,
  );
  assert.equal(
    segments.some((seg) => seg.type === "removed" && seg.text.includes("Regul. elektr. podparcia lędźwiowego - kierowca")),
    true,
  );
  assert.equal(
    segments.some((seg) => seg.type === "common" && seg.text.includes("Kolumna kierownicy regulowana elektrycznie")),
    true,
  );
  assert.equal(
    segments.some((seg) => seg.type === "common" && seg.text.includes("Siedzenie z pamięcią ustawienia")),
    true,
  );
});

test("diffLines refines changed tokens inside one modified line", () => {
  const oldText = "Wyposażenie:\n*) 19\\\" alufelgi\n*) Tempomat";
  const newText = "Wyposażenie:\n*) 21\\\" alufelgi\n*) Tempomat";
  const segments = diffLines(oldText, newText);

  assert.equal(segments.some((seg) => seg.type === "removed" && seg.text === "19"), true);
  assert.equal(segments.some((seg) => seg.type === "added" && seg.text === "21"), true);
  assert.equal(
    segments.some((seg) => seg.type === "common" && seg.text.includes("Wyposażenie:\n*) ")),
    true,
  );
  assert.equal(segments.some((seg) => seg.type === "common" && seg.text.includes("\" alufelgi\n*) Tempomat")), true);
});

test("compactMultiLineSegments collapses long unchanged description context", () => {
  const oldText = [
    "Nagłówek",
    "Linia 1",
    "Linia 2",
    "Linia 3",
    "Linia 4",
    "Linia 5",
    "Linia 6",
    "Linia 7",
    "Linia 8",
    "Łączny koszt: 204 199 PLN",
    "Stopka",
  ].join("\n");
  const newText = [
    "Nagłówek",
    "Linia 1",
    "Linia 2",
    "Linia 3",
    "Linia 4",
    "Linia 5",
    "Linia 6",
    "Linia 7",
    "Linia 8",
    "Łączny koszt: 204 900 PLN",
    "Stopka",
  ].join("\n");

  const compact = compactMultiLineSegments(diffLines(oldText, newText), { contextLines: 1, minLines: 8 });

  assert.equal(compact.compacted, true);
  assert.deepEqual(
    compact.entries.map((entry) => entry.kind === "omitted" ? ["omitted", entry.omittedLineCount] : ["line", entry.pieces.map((piece) => piece.text).join("")]),
    [
      ["omitted", 8],
      ["line", "Linia 8"],
      ["line", "Łączny koszt: 204 199900 PLN"],
      ["line", "Stopka"],
    ],
  );
  const changedLine = compact.entries[2];
  assert.equal(changedLine.kind, "line");
  assert.equal(changedLine.pieces.some((piece) => piece.type === "removed" && piece.text === "199"), true);
  assert.equal(changedLine.pieces.some((piece) => piece.type === "added" && piece.text === "900"), true);
});

test("compactMultiLineSegments leaves short diffs untouched", () => {
  const compact = compactMultiLineSegments(diffLines("A\nB\nC", "A\nX\nC"), { contextLines: 1, minLines: 8 });

  assert.equal(compact.compacted, false);
  assert.equal(compact.entries.some((entry) => entry.kind === "omitted"), false);
  assert.equal(compact.entries.length, 3);
});
