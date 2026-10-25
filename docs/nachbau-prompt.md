# Prompt: „Abo-Übersicht“ – YouTube-Abos als private Handy-App nachbauen

> **So benutzt du diesen Prompt:** Kopiere alles ab der Linie unten in einen neuen Chat mit Claude, in dem Claude Dateien erstellen und Code ausführen kann. Passe vorher die mit **[ANPASSEN]** markierten Stellen an. Claude baut dann alles in einem Rutsch und führt dich anschließend durch die Einrichtung.

---

Bitte baue mir eine **private Web-App (PWA) für mein Android-Handy**, die mir eine Übersicht über die neuen Videos meiner **YouTube-Abos** gibt. Ich habe sehr viele Abos (**[ANPASSEN: ca. 800]**). Ich möchte alles in einem Durchgang umgesetzt haben, inklusive Tests und einer Schritt-für-Schritt-Anleitung zur Einrichtung. Antworte und beschrifte die App auf **Deutsch**. Meine Zeitzone ist **Europe/Berlin [ANPASSEN]**.

## 1. Rahmenbedingungen und Architektur

- **Kein eigener Server, keine Datenbank, kein Build-Schritt.** Ein Python-Skript läuft in **GitHub Actions**, erzeugt eine Datendatei und veröffentlicht die App über **GitHub Pages** (öffentliches Repo, kostenlos).
- Die App auf dem Handy ist nur eine Anzeige. Alle persönlichen Einstellungen (Listen, Farben, Merkliste usw.) speichert sie im **localStorage** des Handys.
- Der Ablauf: Einmaliger Google-Login am PC → Refresh-Token als GitHub-Secret → Workflow baut regelmäßig `site/data.json` (verschlüsselt) → GitHub Pages → App auf dem Handy entschlüsselt mit Passwort.
- Abos werden **automatisch** über die YouTube Data API gelesen, damit neue oder gelöschte Abos ohne mein Zutun stimmen. Als Ersatzlösung soll ein Google-Takeout-CSV (Secret `SUBSCRIPTIONS_CSV`) funktionieren.

## 2. Projektstruktur (bitte genau so anlegen)

```
build.py                      Kernskript (Python 3.12)
auth_setup.py                 einmaliger Google-Login am PC
config.toml                   Einstellungen
requirements.txt              anthropic, cryptography
README.md                     Einrichtungsanleitung
.gitignore                    subscriptions.csv, data/, site/data.json
.github/workflows/update.yml  Automatik
site/index.html, app.js, styles.css, sw.js, manifest.webmanifest, datenschutz.html
site/icons/icon-192.png, icon-512.png, icon-maskable-512.png
tests/subscriptions.csv, tests/feeds/<channel_id>.xml   erfundene Testdaten
```

## 3. Hintergrund-Skript `build.py`

**Abos laden**
- Den Refresh-Token per `oauth2.googleapis.com/token` (`grant_type=refresh_token`) gegen einen Zugriffstoken tauschen.
- `subscriptions.list` mit `part=snippet, mine=true, maxResults=50` seitenweise abrufen.
- Fallback: Takeout-CSV (Spalten Kanal-ID, URL, Titel; Kopfzeile egal, auch deutsch).

**Neue Videos**
- Den RSS-Feed `https://www.youtube.com/feeds/videos.xml?channel_id=…` je Kanal abrufen, 8 parallel, 3 Versuche. Ein einzelner Kanal darf scheitern.
- Gesammelt werden **ganze Kalendertage**: ab 0 Uhr vor `max_days` (=7) Tagen in meiner Zeitzone (`zoneinfo`) bis jetzt.
- Shorts ausblenden: Links mit `/shorts/` und, sobald die Dauer bekannt ist, alles ≤ 60 Sekunden.
- **Sehr aktive Kanäle:** Der RSS-Feed liefert nur die letzten 15 Videos. Liegen alle 15 Einträge im Zeitraum, fehlen vermutlich ältere. Dann über die API die Upload-Playlist (`UU` + Kanal-ID ab dem 3. Zeichen) mit `playlistItems.list` (`part=snippet,contentDetails`, 50 pro Seite) seitenweise nachladen, bis Videos vor dem Zeitraum kommen (max. 10 Seiten). `videoPublishedAt` als Datum nehmen, Einträge ohne dieses Feld (privat/gelöscht) überspringen, Duplikate zum Feed vermeiden. Im Protokoll: „N Kanäle über die API nachgeladen (+X Videos)“.

**Dauer:** `videos.list` mit `part=contentDetails`, 50 IDs pro Anfrage, mit dem OAuth-Token. ISO-8601-Dauer in Sekunden umrechnen.

**Zusammenfassungen mit Claude** (Python-SDK `anthropic`)
- Modell **`claude-haiku-5-5`** [ANPASSEN, falls es ein neueres günstiges Modell gibt], einstellbar in `config.toml`.
- **Wichtig, sonst brechen die Antworten ab:** Das adaptive **Thinking abschalten** (`thinking: {"type": "disabled"}`). Bei neueren Modellen ist es standardmäßig an und frisst das `max_tokens`-Budget.
- **Structured Outputs** nutzen (`output_config.format` mit `json_schema`, `additionalProperties: false`), damit garantiert gültiges JSON zurückkommt. `effort: "low"` setzen.
- Beides über `extra_body` übergeben, damit es mit jeder SDK-Version klappt. `stop_reason` `max_tokens` oder `refusal` als Fehler behandeln.
- Pro Video gehen Kanal, Titel und die ersten 1.200 Zeichen der Beschreibung an Claude. Zurück kommen 2–3 sachliche Sätze auf Deutsch, ohne Werbung, Sponsoren oder Links. Bei leerer Beschreibung ehrlich nur das, was der Titel hergibt.
- 15 Videos pro Anfrage, 4 Anfragen parallel. Scheitert ein Block, wird er **halbiert und erneut versucht**. Das Protokoll zählt ehrlich (erfolgreich und fehlgeschlagen).
- **Cache** `data/cache.json`: Nur Videos ohne Zusammenfassung werden angefragt. Danach auf das aktuelle Zeitfenster kürzen.
- **Keine Themen-Zuordnung.** Die automatische Einteilung hat sich nicht bewährt, eigene Listen in der App ersetzen sie.

**„Kurz gesagt“**
- Je ein Überblick (2–3 Sätze, locker und konkret: Schwerpunkte, auffällige Kanäle, welches Video sich lohnt) für jeden Zeitraum 1…7.
- Nur aus **abgeschlossenen Tagen**: Jedes Video bekommt `tage_zurueck` (1 = gestern), heute zählt nicht mit.
- Wird **einmal pro Kalendertag** erzeugt, in `data/digests.json` mit Datum gespeichert und bei weiteren Läufen des Tages wiederverwendet.

**Verschlüsselung** (Paket `cryptography`)
- Passwort aus dem Secret `APP_PASSWORD`, Unicode-NFC-normalisiert.
- Schlüssel per PBKDF2-SHA256 mit **600.000 Runden**. Salz = SHA-256 von `"abo-uebersicht|" + GITHUB_REPOSITORY`, die ersten 16 Bytes (pro Repo fest, damit die App den abgeleiteten Schlüssel behalten kann).
- AES-256-GCM mit zufälligem 12-Byte-IV pro Lauf.
- Ausgabe: `{"v":1,"enc":"AES-256-GCM","kdf":"PBKDF2-SHA256","iter":600000,"salt":b64,"iv":b64,"data":b64}`.
- Ohne Passwort unverschlüsselt schreiben, mit deutlicher Warnung im Protokoll.

**Inhalt von data.json (entschlüsselt):** `generated`, `timezone`, `max_days`, `subscriptions` (Anzahl), `digests` {"1".."7"}, `videos`: [{`id, title, channel, channel_id, published, url, thumb, summary, seconds`}].

**Protokoll:** keine Kanalnamen oder Themen ausgeben, nur Zahlen (das Protokoll ist öffentlich).

**Testmodus:** `--offline <ordner>` liest Feeds aus Dateien, `--now <ISO>` setzt den Bezugszeitpunkt, `--out` bestimmt die Zieldatei.

## 4. `auth_setup.py` (einmalig am PC, nur Standardbibliothek)

- Fragt nach Client-ID und Client-Secret eines **Desktop-App**-OAuth-Clients.
- OAuth mit **PKCE (S256)**, `state`-Prüfung, Rückleitung auf `http://127.0.0.1:<freier Port>`. Scope `youtube.readonly`, `access_type=offline`, `prompt=consent`. Der Browser öffnet sich automatisch.
- Danach ein **Test** (die ersten 5 Abos anzeigen) und Ausgabe der drei Werte `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` für GitHub.
- Hinweis für den Bildschirm „Google hat diese App nicht überprüft“: **Erweitert › Weiter zu …**.

## 5. Workflow `.github/workflows/update.yml`

- **Nur** `workflow_dispatch`, **kein Zeitplan**: gestartet wird aus der App („Neue Videos abrufen“) oder unter Actions › Run workflow. GitHub lässt geplante Läufe oft aus oder verspätet sie um Stunden, deshalb verzichten wir darauf (und damit auch auf eine Uhrzeit-Prüfung und einen Keepalive-Job gegen die 60-Tage-Abschaltung).
- **Job `build`:** Python 3.12, `pip install -r requirements.txt`, Takeout-Fallback aus dem Secret, `actions/cache` für den Ordner `data/` (Key `summaries-${{ github.run_id }}`, `restore-keys: summaries-`), `python build.py` mit allen Secrets als Umgebungsvariablen, dann `configure-pages` und `upload-pages-artifact` (Ordner `site`).
- **Job `deploy`:** `actions/deploy-pages`.
- Workflow-Berechtigungen: `contents: read`, `pages: write`, `id-token: write`.

## 6. Die App (`site/`): reines JavaScript, ein Skript, kein Framework

**Allgemein**
- Handyformat, max. 560 px Breite, Touch-Ziele ≥ 44 px, Schrift Inter.
- Akzent Orange `#C2410C`, warmes Hellgrau als Hintergrund. **Dark Mode** über CSS-Variablen: automatisch, fest dunkel oder fest hell, umschaltbar oben, gespeichert, ohne Aufblitzen beim Start.
- **PWA:** Manifest (standalone, Icons 192/512/maskable), Service Worker *network-first* mit Offline-Fallback auf die letzte Version, `data.json` immer unter demselben Cache-Schlüssel.
- Alle Einstellungen in `localStorage` mit Präfix `abo.`, jeder Zugriff in try/catch.

**Entsperren**
- Ist `data.json` verschlüsselt, erscheint eine Passwort-Abfrage (Feld, „Passwort anzeigen“, Fehlermeldung bei falschem Passwort).
- Web Crypto: PBKDF2 (`deriveBits`, 256 Bit) und AES-GCM-Entschlüsselung. Den **abgeleiteten Schlüssel** (nicht das Passwort) mit Salz speichern.
- Passt der gespeicherte Schlüssel nicht mehr: „Das Passwort wurde geändert – bitte neu eingeben“.
- Unten in der App: „App sperren“.

**Kopf**
- Datumszeile mit Wochentagen, z. B. „Sa 17. – Sa 24. Okt“ bzw. „Heute · Sa 24. Okt“.
- Titel, Statistik (Videos · Kanäle · Gesamtdauer · „N neu“).
- Runde Knöpfe: Darstellung, Merkliste (mit Zähler), Aktualisieren (öffnet das Menü „Aktualisieren“, s. u.).

**Zeitraum**
- Knöpfe **„Heute“** (breiter) und **1–7**, jeweils mit Wochentag darunter. Ganze Kalendertage: 0 = heute ab 0 Uhr, 1 = ab gestern 0 Uhr usw. Standard 7, **nicht** gespeichert.
- **Langdruck** (550 ms) hakt den Kalendertag ab: grün mit Häkchen. Die Markierung hängt am Datum und wandert daher täglich eine Zahl weiter. Der Klick nach dem Langdruck darf den Zeitraum nicht wechseln. Abhaken älter als 30 Tage aufräumen.

**Listen (statt Themen)**
- Eine Chip-Zeile „Alle Kanäle“ + eigene Listen + Stift. Ohne Listen erscheint „+ Liste anlegen“.
- **Mehrfachauswahl** (ODER-Verknüpfung), „Alle Kanäle“ setzt zurück. Gilt in Übersicht **und** Merkliste.
- Jede Liste hat eine **Farbe aus 11** (Rot, Orange, Gelb, Hellgrün, Grün, Türkis, Hellblau, Blau, Lila, Pink, Braun) oder keine. Eine neue Liste bekommt automatisch eine freie Farbe.
- **Kanäle übernehmen die Farben ihrer Listen** als Punkte, mehrere Listen ergeben mehrere Punkte.
- **Listen bearbeiten** (Stift, Bottom-Sheet): umbenennen (Feld), Farbkreis → Farbwahl als Raster mit 6 Spalten (keine + 11 = zwei volle Reihen), ↑↓ zum Umsortieren der Filter-Reihenfolge, Löschen mit **Rückgängig**, neue Liste anlegen. Beliebig viele Listen.
- **Kanal-Menü** (⋯ beim Kanal; in der Merkliste über den Kanalnamen): Listen zum Abhaken (mit Farbpunkt), neue Liste direkt anlegen (Kanal kommt hinein), **„Kanal stummschalten“**.

**Übersicht**
- Immer **nach Kanal gruppiert**. Gruppen starten **eingeklappt**: Name mit Farbpunkten, darunter „3 Videos · 59 Min. · 1 neu“, rechts Pfeil und ⋯.
- Werkzeugleiste mit Sortierung **Listen | Anzahl** und „Alle auf/zu“.
  - **Listen** (ganz links, Standard): Reihenfolge der Listen-Filter, mit kleinen Zwischenüberschriften (Farbpunkt + Listenname), Kanäle ohne Liste unten unter „Ohne Liste“. Ein Kanal in mehreren Listen erscheint einmal, bei seiner ersten (bei aktivem Filter: ersten gewählten) Liste.
  - **Ordnen** (nur bei „Listen“): Kanäle am Griff ziehen (Pointer Events), **nur innerhalb ihrer Liste** bzw. innerhalb „Ohne Liste“. Reihenfolge **pro Liste** speichern (Kanal-IDs). Gerade nicht sichtbare Kanäle behalten ihren Platz, neue Kanäle landen unten. Beim Umbenennen/Löschen einer Liste mitziehen.
  - **Anzahl**: nach Videoanzahl.
- **„Kurz gesagt“**-Karte (dunkel, Stern-Symbol, Zusatz „bis gestern“, einklappbar, Zustand gespeichert). Nur bei Zeitraum ≥ 1. Ohne Listen-Filter der Claude-Text, sonst eine einfache Auswertung (Anzahl, aktivste Kanäle) der gefilterten, abgeschlossenen Tage.
- **Filterzeile:** runder **Such-Knopf** (öffnet Suchfeld mit ×, Suche nach Titel/Kanal, mehrere Wörter, akzent-unabhängig; Treffer klappen auf), „**Gesehene ausblenden**“ (gespeichert), **Dauer**: Alle / unter 15 / 15–30 / über 30 Min.
- **Alt-Hinweis** (gelb) ab 3 Std. Alter: „Die Übersicht ist N Std. alt. Neue Videos kommen, wenn du sie abrufst.“ mit Link „Jetzt neue Videos abrufen“ (öffnet das Menü „Aktualisieren“).
- Unten: „N Kanäle stummgeschaltet · anzeigen“ (stumme Kanäle dann blass mit „stumm“), „Stand: …“, Hinweise zu den Gesten, **Sichern · Wiederherstellen**, App sperren, Datenschutz.

**Videokarte**
- Vorschaubild mit Dauer, Titel (max. 3 Zeilen), Alter.
- „Zusammenfassung“ aufklappbar, **„In YouTube öffnen“** (öffnet die YouTube-App und markiert als gesehen), Lesezeichen.
- **NEU**-Schild für Videos, die seit dem letzten Besuch dazugekommen sind. Besuch = App-Start oder Rückkehr nach > 30 Min. im Hintergrund; bekannte IDs speichern.
- **Gesehen**: Karte blass, „👁 gesehen“ antippbar zum Zurücksetzen; nach 30 Tagen aufräumen.
- **Wischen:** rechts = merken/entfernen (grün bzw. rot), links = gesehen/ungesehen (grau). Hinweis mit **Rückgängig**. Beim Wischen keinen Text markieren.

**Merkliste**
- Speichert komplette Videodaten, bleibt also auch nach 7 Tagen erhalten.
- Listen-Filter, Sortierung als Chips: **Zuletzt gemerkt · Kürzeste zuerst · Längste zuerst · Nach Kanal** (mit Kanal-Überschriften) **· Eigene**. Die gewählte Chip scrollt in Sicht.
- Bei „Eigene“: „Ordnen“ zeigt kompakte Zeilen mit Griff (ziehen) und ↑↓. Neu Gemerktes landet oben. Bei aktivem Filter behalten ausgefilterte Videos ihren Platz.
- Entfernen per Wischen in beide Richtungen.

**Sichern / Wiederherstellen**
- Download als `abo-uebersicht-sicherung-JJJJ-MM-TT.json` mit `{app, v, exported, data}`: Listen, Farben, Kanal-Zuordnungen inkl. stumm, Merkliste, Gesehen, abgehakte Tage, Sortierungen, eigene Reihenfolgen, Darstellung. **Ohne** Passwort-Schlüssel und GitHub-Token.
- Wiederherstellen per Dateiauswahl, mit Prüfung (falsche Datei → Hinweis) und Rückgängig.

**Aktualisieren / Neue Videos abrufen**
- Der Knopf öffnet ein Bottom-Sheet mit „Stand: … (vor N Std.)“, **Neue Videos abrufen** und **Nur neu laden** (lädt nur `data.json` neu).
- „Neue Videos abrufen“ startet den Workflow per `POST https://api.github.com/repos/<repo>/actions/workflows/update.yml/dispatches` mit `{"ref":"main"}`, fragt danach alle 8 s `…/runs?event=workflow_dispatch&per_page=1` ab (wartet / läuft / fertig) und lädt nach Erfolg `data.json` neu, bis zu 3-mal im Abstand von 10 s, falls Pages noch den alten Stand liefert. Der Knopf oben dreht sich, solange es läuft. Fehler verständlich anzeigen: Token ungültig oder abgelaufen, fehlende Berechtigung, Lauf fehlgeschlagen (mit Tipp zu `auth_setup.py` bei „Google-Login fehlgeschlagen“) oder abgebrochen, jeweils mit Link zum Lauf.
- Repo aus der Pages-Adresse ableiten (`<besitzer>.github.io/<repo>/`). Unter einer anderen Adresse (z. B. lokal) nur der Hinweis „geht nur in der veröffentlichten App“.
- Einmalig einen **Fine-grained Token** einfügen (nur dieses Repo, *Actions: Read and write*), mit kurzer Anleitung im Sheet. Format prüfen (`github_pat_…`), dann per `GET …/actions/workflows/update.yml` testen. Speichern als `abo.ghToken` **nur auf dem Gerät**, nicht in der Sicherung. „GitHub-Token ändern“ und „… entfernen“.

**Barrierefreiheit:** echte `<button>`/`<a>`, `aria-pressed`/`aria-expanded`, `aria-label` an Symbol-Knöpfen, sichtbarer Fokus, Escape schließt Menüs.

## 7. Einrichtung (bitte als README und dann interaktiv mit mir durchgehen)

Führe mich danach **Schritt für Schritt** durch die Einrichtung und warte jeweils auf meine Rückmeldung. Diese Stolpersteine kennen wir schon, bitte vorab darauf hinweisen:

1. **Google Cloud Console:** neues Projekt. **Der Name darf keine Umlaute enthalten** (z. B. „Abo-Uebersicht“). YouTube Data API v3 aktivieren.
2. **Google Auth Platform:** Assistent mit Zielgruppe **Extern**.
   - Auf der Seite **Branding** müssen für die Veröffentlichung *Startseite* und *Datenschutzerklärung* eingetragen sein. **Nicht `github.com` nehmen** (sonst „Domain fehlt“), sondern `https://<github-name>.github.io/<repo>/` und `…/datenschutz.html`. Unter *Autorisierte Domains* `<github-name>.github.io` eintragen. **Kein Logo** hochladen (sonst ist eine Prüfung nötig).
   - Unter **Zielgruppe** auf „App veröffentlichen“ → **In Produktion**. Im Testmodus laufen Refresh-Tokens nach 7 Tagen ab.
   - Unter **Clients** einen Client vom Typ **Desktop-App** anlegen. Desktop-App ist richtig, auch wenn die App aufs Handy kommt: Der Login passiert nur einmal am PC.
3. **Python** am PC installieren (`winget install Python.Python.3.12` oder python.org mit „Add to PATH“), dann `python auth_setup.py`.
4. **Anthropic Console:** „Mit einem API-Schlüssel fortfahren“ wählen (nicht Identitätsföderation), Schlüssel erstellen, **Ausgabenlimit** setzen.
5. **GitHub:** Repo **öffentlich** (GitHub Pages ist nur dann kostenlos), Dateien hochladen.
   - **Achtung:** Der Ordner `.github` wird beim Web-Upload oft verschluckt. Dann `.github/workflows/update.yml` über „Add file › Create new file“ anlegen.
   - Secrets anlegen: `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `APP_PASSWORD` (langes Passwort, z. B. 4–5 zufällige Wörter).
   - Pages-Quelle „GitHub Actions“, dann „Run workflow“ (in der Workflow-Übersicht, **nicht** „Re-run all jobs“, das nutzt alten Code).
6. **Handy:** Adresse in **Chrome** öffnen (nicht im eingebetteten Browser einer anderen App), ⋮ › „App installieren“, Passwort eingeben.
7. **Abruf aus der App:** Fine-grained Token nur für dieses Repo mit *Actions: Read and write* anlegen und in der App unter ↻ einfügen. Ohne Token gibt es neue Daten nur über Actions › Run workflow.

Erkläre mir dabei kurz, was öffentlich sichtbar ist (Code, Protokoll-Zahlen, die verschlüsselte Datei) und was nicht (Secrets, Cache, Einstellungen auf dem Handy). Und dass alte Läufe von vor der Verschlüsselung gelöscht werden sollten.

## 8. Qualität und Tests (bitte selbst durchführen, bevor du mir Dateien gibst)

- `build.py` offline mit den Testfeeds laufen lassen, einmal ohne und einmal mit **nachgestellter Claude-Antwort** (normal, abgeschnitten, verweigert, mehrseitige Abo-Liste).
- Prüfen: Shorts und alte Videos fliegen raus, „Kurz gesagt“ wird pro Tag nur einmal erzeugt und am Folgetag neu, die Verschlüsselung lässt sich in der App mit dem richtigen Passwort öffnen (auch mit Umlauten), ein falsches Passwort wird abgelehnt.
- Die App im **Handyformat 390 × 844** mit Playwright/Chromium durchklicken: Wischen, Langdruck, Ziehen, Listen, Mehrfachfilter, Merkliste-Sortierungen, Sichern/Wiederherstellen, „Neue Videos abrufen“ mit nachgestellter GitHub-API (Erfolg, Fehlschlag, fehlende Berechtigung, ungültiger Token). Hell **und** dunkel ansehen, keine JavaScript-Fehler, kein horizontales Scrollen.
- Zum Schluss alles als ZIP liefern. Bei späteren Änderungen immer sagen, **welche Dateien in welchen Ordner** hochgeladen werden müssen.

## 9. Optional, nur auf Nachfrage

- Push-Benachrichtigung bei neuer Übersicht (Web Push ohne eigenen Server).
- Zusammenfassungen aus Untertiteln statt aus der Beschreibung (YouTube blockiert Abrufe von GitHub-Servern häufig, daher unzuverlässig).
- Seite zusätzlich hinter Cloudflare Access verstecken (privates Repo + Cloudflare Pages).
