# CLAUDE.md – Abo-Übersicht

Private Web-App (PWA) für Android: Übersicht der neuen Videos aus ~850 YouTube-Abos, nach Kanal gruppiert, mit eigenen farbigen Listen, Kurz-Zusammenfassungen von Claude und Merkliste. Ausführliche Beschreibung: `docs/projektbuch.html` (Funktionen + Technik) und `docs/nachbau-prompt.md` (vollständige Spezifikation).

## Arbeitsweise

- **Sprache:** Mit mir Deutsch sprechen. Alle Texte in der App, im Protokoll und in Kommentaren auf Deutsch.
- **Keine Secrets in Dateien.** Zugangsdaten liegen ausschließlich als GitHub-Secrets: `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `APP_PASSWORD` (optional `YT_API_KEY`, `SUBSCRIPTIONS_CSV`). Nie Tokens, Passwörter oder echte Abo-Daten ins Repo schreiben.
- **Das Repo ist öffentlich.** Keine Kanalnamen, Themen oder sonstigen persönlichen Daten in Code, Tests oder Logs. Das Protokoll von `build.py` gibt nur Zahlen aus.
- Vor dem Arbeiten `git pull`: Der Workflow legt gelegentlich automatische „Repo aktiv halten“-Commits an.
- Commit-Nachrichten kurz auf Deutsch. Nach dem Push wirken App-Änderungen sofort (App neu öffnen). Für neue Daten den Workflow starten: `gh workflow run update.yml` oder in GitHub unter Actions › Run workflow.
- Bei Änderungen an Verhalten oder Funktionen auch `docs/projektbuch.html`, `docs/nachbau-prompt.md` und `README.md` nachziehen.

## Aufbau

```
build.py                      Kernskript (Python 3.12): Abos → Feeds → Nachladen aktiver Kanäle → Dauer → Claude → „Kurz gesagt“ → Verschlüsselung → site/data.json
auth_setup.py                 einmaliger Google-Login am PC (OAuth Desktop-Client, PKCE, Loopback)
config.toml                   max_days, timezone, include_shorts, [llm] model/batch_size/effort
.github/workflows/update.yml  Jobs: gate (Uhrzeit) → build → deploy (GitHub Pages); keepalive
site/                         die App: index.html, app.js (gesamte Logik), styles.css, sw.js, manifest, icons, datenschutz.html
tests/                        erfundene Testkanäle und Feeds für den Offline-Lauf
docs/                         Projektbuch und Nachbau-Prompt (werden NICHT mit der App veröffentlicht)
```

Datenhaltung: Actions-Cache `data/cache.json` (Zusammenfassungen) und `data/digests.json` („Kurz gesagt“ des Tages); `site/data.json` wird bei jedem Lauf neu erzeugt und ist nie im Repo (`.gitignore`). Persönliches (Listen, Farben, Merkliste, Gesehen, Häkchen, Reihenfolgen) liegt im localStorage des Handys mit Präfix `abo.`.

## Wichtige Entscheidungen (nicht versehentlich rückgängig machen)

- **Claude-Aufrufe:** Modell aus `config.toml` (`claude-haiku-5-5`). Thinking **abgeschaltet** (`thinking: {"type": "disabled"}`), sonst brechen Antworten ab. **Structured Outputs** über `output_config.format` (json_schema), `effort: low`. Beides per `extra_body`. Batches à 15, 4 parallel, misslungene Blöcke halbieren und wiederholen.
- **Keine Themen-Zuordnung mehr.** Gruppiert wird nur nach Kanal, gefiltert über eigene Listen in der App.
- **Ganze Kalendertage** in Zeitzone Europe/Berlin: „Heute“ = ab 0 Uhr, 1–7 = ab 0 Uhr vor N Tagen.
- **„Kurz gesagt“** nur aus abgeschlossenen Tagen (bis gestern), einmal pro Kalendertag erzeugt.
- **RSS liefert nur 15 Videos je Kanal.** Liegen alle im Zeitraum, lädt `fetch_uploads()` die Upload-Playlist (`UU…`) über `playlistItems.list` nach.
- **Verschlüsselung:** PBKDF2-SHA256 mit 600.000 Runden, Salz = SHA-256(`"abo-uebersicht|" + GITHUB_REPOSITORY`)[:16], AES-256-GCM, Passwort NFC-normalisiert. Die App speichert den abgeleiteten Schlüssel (`abo.key`), nicht das Passwort. Salz- oder Formatänderungen sperren alle Geräte aus.
- **Zeitplan:** cron `17 8-23 * * *` UTC, der Job `gate` lässt stündlich 10–0 Uhr deutscher Zeit durch. Nicht auf jede zweite Stunde reduzieren: GitHub lässt geplante Läufe bei Last aus.
- **keepalive:** leerer Commit, wenn der letzte älter als 50 Tage ist (60-Tage-Regel für geplante Läufe).
- **App:** reines JavaScript (ES5-Stil, eine IIFE), kein Framework, kein Build-Schritt. UI nur über `render()`/`renderList()` aus `state` neu zeichnen. Jeder localStorage-Zugriff über `store.get/set` (try/catch). Neue persistente Einstellungen auch in `BACKUP_KEYS` aufnehmen (Sichern/Wiederherstellen).
- **Service Worker** network-first. Bei größeren Änderungen am Cache-Inhalt `CACHE` in `sw.js` hochzählen.
- Touch-Ziele ≥ 44 px, Hell **und** Dunkel über CSS-Variablen, echte `<button>`/`<a>` mit `aria-*`.

## Testen (vor jedem Commit)

```bash
pip install -r requirements.txt
cp tests/subscriptions.csv subscriptions.csv
python build.py --offline tests/feeds --now 2026-10-23T20:00:00Z     # ohne Schlüssel: unverschlüsselt, ohne Claude
node --check site/app.js && node --check site/sw.js
cd site && python -m http.server 8000                                # App im Browser, Handyansicht 390 × 844
```

- Claude- und Google-Aufrufe für Tests **nachstellen** (z. B. `anthropic` per `PYTHONPATH` durch einen Stub ersetzen, `build.http_get/http_post` monkeypatchen). Keine echten API-Aufrufe in Tests.
- App-Änderungen mit Playwright/Chromium im Handyformat durchklicken (Wischen, Langdruck, Ziehen, Filter, Merkliste, Dark Mode), keine Konsolenfehler, kein horizontales Scrollen.
- Danach die Testreste löschen: `subscriptions.csv`, `data/`, `site/data.json`.

## Bekannte Stolpersteine

- Ordner mit Punkt (`.github`) gehen beim Web-Upload auf GitHub verloren, deshalb lieber per Git arbeiten.
- Das Repo nicht in einem OneDrive-synchronisierten Ordner ablegen (gesperrte Dateien, langsames Kopieren).
- Läuft der Google-Login ab („Google-Login fehlgeschlagen“): `python auth_setup.py` erneut ausführen und das Secret `YT_REFRESH_TOKEN` ersetzen. Die Google-App muss „In Produktion“ sein.
- In GitHub Actions „Run workflow“ verwenden, nicht „Re-run all jobs“ (das nutzt den alten Code).
