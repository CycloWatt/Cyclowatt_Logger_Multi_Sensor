# Raw-Stream CSV im logger-fw-Schema — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Dashboard-Export „Export to CSV“ schreibt dieselben Spalten in derselben Reihenfolge und mit derselben Kraftkanal-Zuordnung wie `logger-fw/srm_cw_logger_raw.py` (`cyclowatt.csv`).

**Architecture:** Einzige Logikänderung in `lib/raw-stream/csv.ts`. Header und Zellen kommen künftig aus EINER Spaltentabelle (`{ header, cell }[]`), damit Name und Wert nicht auseinanderlaufen können. Die Kraftkanäle werden dort so permutiert wie in logger-fw (`FORCE_PERM = [0,3,1,4,2,5]`). `cw_time` kommt aus dem schon vorhandenen `DataPoint.timestamp`. Die Seite (`app/page.tsx`) ruft weiter `rawStreamToCsv`/`rawCsvFilename` auf; dort und in `lib/raw-stream/force-channels.ts` ändern sich nur Kommentare.

**Tech Stack:** TypeScript, Next.js 16 (static export), vitest 4.

**Spec:** Nutzerauftrag 2026-10-20: „das Dashboard so anpassen, dass es logger-fw entspricht“. Referenz-Schema: `C:/Users/cyclo/cw-repos/logger-ws/logger-fw/srm_cw_logger_raw.py` — Header in `main()` (Zeile ~434), Zeilenaufbau in `parse_cyclowatt()` (Zeile ~119).

## Global Constraints

- Die ersten 17 Spalten sind **exakt** der logger-fw-Header, in dieser Reihenfolge:
  `cw_time, force1_channel1, force1_channel2, force2_channel1, force2_channel2, force3_channel1, force3_channel2, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, power, tick, tick_mcu, synch`
- Kraft-Zuordnung (Wire-Slot → Spalte), wie `parse_cyclowatt`:
  `force1_channel1 = force0`, `force1_channel2 = force3`, `force2_channel1 = force1`, `force2_channel2 = force4`, `force3_channel1 = force2`, `force3_channel2 = force5`.
- `cw_time` = `formatEpochSeconds(point.timestamp)` aus `lib/trainer/session-log.ts` (Epoch-Sekunden, PC-Uhr, genau 3 Nachkommastellen). Das ist dieselbe Uhr wie Pythons `time.time()` und derselbe Formatter, den der Trainer-Export schon für den `cw_time`-Join nutzt.
- `synch` = **immer 0** (Entscheidung des Nutzers 2026-10-20, nach dem Claude-Review auf PR #63: „am Dashboard kann es keinen Sync geben“). PAS verankert `time_cw_sync_s` am ersten 0→≠0-Wechsel in `synch` (`preprocess_map.json`, `self_rising_flag`); jeder Serial-Wert dort würde als Sync-Ereignis gelesen. Mit 0 lädt die Datei, und ein Sync-abhängiger Schritt bricht laut ab. Der Serial-Wert selbst wird als Zusatzspalte `serial_input` hinter `reference_power` behalten — bewusst ohne „synch“ im Namen, weil PAS' `find_column` ohne exakten Treffer per Teilstring sucht (Claude-Review PR #63).
- `reference_power` bleibt erhalten, als **18.** Spalte (vor `serial_input`). Es gibt dafür keine Logger-Spalte. Weglassen würde die Trainer-Referenz aus jeder Bench-Aufnahme löschen; als angehängte Spalte stört sie keinen Leser: PAS (`templates/session/schema_map.json`) und `logger-fw/scripts/remap_force_channels.py` wählen per Name bzw. verlangen einen exakten Header (letzteres schützt sogar davor, eine Dashboard-Datei doppelt zu permutieren).
- Dateiname: `<YYYY-MM-DD>_<HHMMSS>[_fw<v>]_cyclowatt.csv` in Ortszeit (z.B. `2026-10-20_143005_fw1.4.2_cyclowatt.csv`). Die Uhrzeit ist Pflicht (Code-Review): mit Datum allein speichert der Browser den zweiten Export des Tages als `..._cyclowatt (1).csv`, und der Glob greift nicht mehr. Grund: PAS findet die CW-Quelle per `"file_glob": "*cyclowatt.csv"`; der alte Name `cyclowatt_data_….csv` matcht nie. Die Firmware-Version bleibt im Namen.
- Unverändert: `\n` als Zeilentrenner, kein Newline am Dateiende, JS-Standard-Zahlformat (kein Runden). Python schreibt `\r\n` und `1.0` statt `1` — für pandas/`csv.reader` gleichwertig, bewusst kein Ziel.
- Import innerhalb `lib/` **relativ** (`../trainer/session-log`): ohne vitest-Config löst vitest `@/` nicht auf (Value-Imports zwischen lib-Modulen sind im Repo durchweg relativ).
- Kein Abwärtskompatibilitäts-Schalter, keine alten Spaltennamen. Kein Repo im Workspace liest das alte Schema (geprüft per grep über `cw-repos` nach `ticks_mcu`, `force_0`, `reference_power`, `cyclowatt_data_`).

## Review Focus

1. Vertauschte Kraftkanäle — die naheliegende Fehlumsetzung ist reines Umbenennen nach Position (`force_1 → force1_channel2`). Test: sechs verschiedene Slotwerte, Zellenreihenfolge muss `[force0, force3, force1, force4, force2, force5]` sein.
2. `cw_time` mit Millisekunden: `1767225907300` → `"1767225907.300"` (nicht `"1767225907.3"` und kein Float-Artefakt). Test in Task 1.
3. `tick_mcu` über 2^32 bleibt exakt (`4294967296`) — Test in Task 1 (bestehender Wert, neue Position).
4. Header- und Zellenzahl stimmen in jeder Zeile überein (18) — Test in Task 1.
5. Leere Aufnahme liefert nur die Headerzeile — bestehender Test bleibt, läuft gegen den neuen Header.

---

### Task 1: Spaltentabelle im logger-fw-Schema

**Files:**
- Modify: `lib/raw-stream/csv.ts` (gesamtes Modul)
- Modify: `lib/raw-stream/csv.test.ts`
- Modify (nur Kommentare): `app/page.tsx:1350-1353`, `lib/raw-stream/force-channels.ts:18-21`

**Interfaces:**
- Consumes: `formatEpochSeconds(epochMs: number): string` aus `../trainer/session-log`; `DataPoint` aus `./packet`.
- Produces (Signaturen unverändert, nur Inhalt neu):
  - `export const RAW_CSV_HEADERS: readonly string[]` — abgeleitet aus der Spaltentabelle, 18 Einträge.
  - `export function rawStreamToCsv(points: readonly DataPoint[]): string`
  - `export function rawCsvFilename(date: Date, fwVersion: string | null): string` — Signatur gleich, liefert `<YYYY-MM-DD>_<HHMMSS>[_fw<v>]_cyclowatt.csv` (Ortszeit).
  - Die Spaltentabelle selbst bleibt modul-privat (`const RAW_CSV_COLUMNS: readonly { header: string; cell: (p: DataPoint) => string | number }[]`).

- [ ] **Step 1: Tests auf das neue Schema umschreiben (`lib/raw-stream/csv.test.ts`)**

  > **Überholt durch die Umsetzung (PR #63):** Die Spaltenliste hat inzwischen 19 Einträge. `synch` ist immer 0, und `serial_input` ist die 19. Spalte (siehe Global Constraints). Die Testfälle und Erwartungswerte unten sind der ursprüngliche Plan; maßgeblich ist `csv.test.ts`.

  - `describe("RAW_CSV_HEADERS")` → `it("is logger-fw's 17 cyclowatt.csv columns, then reference_power")`:
    `expect([...RAW_CSV_HEADERS]).toEqual([...17 Logger-Namen aus Global Constraints..., "reference_power"])`.
    Kommentar: Quelle ist `srm_cw_logger_raw.py` `main()`; Änderung dort = Änderung hier.
  - `it("writes one row per sample with the 18 cells in header order")` mit dem bestehenden `point()`-Fixture (timestamp `1_767_225_907_300`, force0..5 = 1..6, tick 99, ticksMcu 4294967296, power 7, referencePower 150, synchronization 3):
    ```ts
    expect(cells).toEqual([
      "1767225907.300",
      "1", "4", "2", "5", "3", "6",
      "1.5", "-1.5", "9.81",
      "-0.25", "0.25", "0",
      "7", "99", "4294967296", "3",
      "150",
    ])
    ```
  - Neu: `it("regroups the wire slots per sensor exactly like logger-fw parse_cyclowatt")` — liest Spalten über den Header-Index statt über Positionen: `force1_channel1→1, force1_channel2→4, force2_channel1→2, force2_channel2→5, force3_channel1→3, force3_channel2→6`.
  - Neu: `it("writes cw_time as epoch seconds with exactly 3 decimals")` — `point({ timestamp: 1_767_225_907_000 })` → erste Zelle `"1767225907.000"`.
  - Ersetzen: `it("does NOT export timestamp or the chart label")` → `it("does NOT export the chart label")`: nur noch `expect(csv).not.toContain("05:07.3")`.
  - `it("keeps samples in capture order ...")`: Spalte über `RAW_CSV_HEADERS.indexOf("tick")` lesen statt Index 0.
  - Neu: `it("pins the logger column order from the wire bytes, not from DataPoint fields")` — 64-Byte-Paket mit Slots 0..5 = 10,11,12,13,14,15 durch `parseDataPacket`, dann `rawStreamToCsv`; Kraftzellen müssen `10,13,11,14,12,15` sein (entspricht `parse_cyclowatt` auf denselben Bytes).
  - `rawCsvFilename`-Tests: Erwartungen auf `2026-09-02_cyclowatt.csv` bzw. `2026-09-02_fw1.4.2_cyclowatt.csv`; neuer Test `it("ends in cyclowatt.csv so PAS's *cyclowatt.csv glob picks it up")`.
  - Unverändert: header-first, no trailing newline, empty capture.

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

  Run: `npx vitest run lib/raw-stream/csv.test.ts`
  Expected: FAIL in den Header-, Zeilen-, Permutations- und cw_time-Tests.

- [ ] **Step 3: `lib/raw-stream/csv.ts` umbauen**

  - Modul-privat `RAW_CSV_COLUMNS` in Header-Reihenfolge aus Global Constraints; jede Zeile mit Kommentar auf den Wire-Slot bei den Kräften (wie `parse_cyclowatt`).
  - `RAW_CSV_HEADERS = RAW_CSV_COLUMNS.map((c) => c.header)`.
  - `rawStreamToCsv` baut jede Zeile als `RAW_CSV_COLUMNS.map((c) => c.cell(point)).join(",")`; Header, `\n`-Join und kein abschließendes Newline wie bisher.
  - Modulkommentar neu schreiben: Das Schema IST logger-fws `cyclowatt.csv` (Pfad + Funktionsnamen nennen), damit eine Dashboard-Aufnahme durch dieselbe Python-Kette geht; Permutation gehört dorthin, weil die App intern Wire-Slots führt (siehe `force-channels.ts`); `reference_power` als einzige Zusatzspalte, angehängt; `cw_time` = PC-Uhr beim Empfang der Notification; die Aussage „bench scripts select force_0 …“ entfällt. Den Absatz über Zahlformat (kein Runden) behalten und um die Ausnahme `cw_time` ergänzen (ms-Ganzzahl / 1000 mit 3 Stellen ist verlustfrei).

- [ ] **Step 4: Tests laufen lassen**

  Run: `npx vitest run lib/raw-stream/csv.test.ts`
  Expected: PASS

- [ ] **Step 5: Kommentare an den Aufrufern nachziehen**

  - `app/page.tsx:1350-1353`: „17 header strings … bench analysis scripts select them by name“ → Columns folgen logger-fws `cyclowatt.csv` (+ `reference_power`), gepinnt in `csv.test.ts`.
  - `lib/raw-stream/force-channels.ts:102`: „The chart/CSV key for a slot“ → nur noch Chart-/`DataPoint`-Key.
  - `lib/raw-stream/force-channels.ts:18-21`: Satz „So this app's `force_N` is logger WIRE index N, not logger column N“ ergänzen: gilt für Charts und `DataPoint`; der CSV-Export wendet dieselbe Permutation an wie logger-fw (`lib/raw-stream/csv.ts`), seine Spalten sind also Logger-Spalten.

- [ ] **Step 6: Volle Verifikation**

  Run: `npm test` → Expected: alle Suiten PASS.
  Run: `npm run build` → Expected: Build erfolgreich (Typecheck inklusive).

- [ ] **Step 7: Commit**

  ```bash
  git add lib/raw-stream/csv.ts lib/raw-stream/csv.test.ts app/page.tsx lib/raw-stream/force-channels.ts docs/superpowers/plans/2026-10-20-csv-logger-schema.md
  git commit -m "feat(csv): export raw stream in logger-fw cyclowatt.csv schema"
  ```

### Task 2: Ausliefern

- [ ] **Step 1:** Ganzbranch-Review (frischer Reviewer gegen diesen Plan und `srm_cw_logger_raw.py`), Findings beheben, erneut `npm test` + `npm run build`.
- [ ] **Step 2:** `git push -u origin feat/csv-logger-schema`, PR gegen `main` öffnen. PR-Text: Spalten-Mapping-Tabelle alt → neu, Hinweis „Breaking für jedes private Skript, das das alte Schema liest; im Workspace keins gefunden“.
- [ ] **Step 3:** Auto-Memory `force-channel-wire-order.md` aktualisieren: Der CSV-Export permutiert jetzt wie der Logger; nur Charts/`DataPoint` führen Wire-Slots.
