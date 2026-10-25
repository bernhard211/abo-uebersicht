# Abo-Übersicht

Die App zeigt neue Videos deiner YouTube-Abos von heute bis 7 Tage zurück, nach Kanal gruppiert. Kanäle kannst du farbig markieren und eigenen Listen zuordnen. Jedes Video hat eine Kurz-Zusammenfassung, und oben steht ein Überblick über die abgeschlossenen Tage. Sie läuft als Web-App (PWA) auf dem Handy, ist per Passwort verschlüsselt (Secret `APP_PASSWORD`) und wird aktualisiert, wenn du in der App auf **Neue Videos abrufen** tippst.

```
Google-Login (einmalig) ──► build.py (GitHub Actions, auf Knopfdruck)
                              ├─ deine Abos über die YouTube-API
                              ├─ neue Videos über den RSS-Feed je Kanal
                              ├─ Videodauer über die YouTube-API
                              └─ Zusammenfassung per Claude
                                     │
                                     ▼
                              site/data.json ──► GitHub Pages ──► App auf dem Handy
```

## Einrichtung (einmalig, ca. 30 Minuten)

Die Bezeichnungen in der Google-Oberfläche können leicht abweichen. Google benennt Menüs ab und zu um.

### 1. Google-Cloud-Projekt anlegen
1. Öffne [console.cloud.google.com](https://console.cloud.google.com) und lege oben über die Projektauswahl ein **neues Projekt** an, z. B. „Abo-Übersicht“.
2. Gehe zu **APIs & Dienste › Bibliothek**, suche nach **YouTube Data API v3** und klicke auf **Aktivieren**.

### 2. Anmeldung (OAuth) einrichten
1. Öffne **Google Auth Platform**. Das Menü hieß früher „OAuth-Zustimmungsbildschirm“. Klicke auf **Jetzt starten**:
   - App-Name: „Abo-Übersicht“, Support-E-Mail: deine Adresse
   - Zielgruppe: **Extern**
   - Kontakt-E-Mail: deine Adresse, Richtlinien bestätigen und erstellen
2. Unter **Zielgruppe** klickst du auf **App veröffentlichen** und bestätigst. Der Status steht dann auf **In Produktion**.
   *Das ist wichtig: Im Testmodus läuft die Anmeldung nach 7 Tagen ab.*
3. Unter **Clients › Client erstellen** wählst du als Anwendungstyp **Desktop-App** und vergibst einen beliebigen Namen. Notiere dir **Client-ID** und **Clientschlüssel** (Client-Secret).

### 3. Einmal anmelden
Dafür brauchst du Python auf dem PC: [python.org/downloads](https://www.python.org/downloads/). Setze bei der Installation den Haken bei *Add python.exe to PATH*. Dann im entpackten Ordner:
```
python auth_setup.py
```
1. Gib Client-ID und Client-Secret ein. Der Browser öffnet sich.
2. Melde dich mit dem Google-Konto an, mit dem du YouTube nutzt.
3. Beim Hinweis **„Google hat diese App nicht überprüft“** klickst du auf **Erweitert › Weiter zu Abo-Übersicht (unsicher)**. Das ist bei selbst gebauten Apps normal, es ist deine eigene App.
4. Erlaube den Lesezugriff auf YouTube.

Das Skript testet den Zugriff, zeigt ein paar deiner Abos an und gibt **drei Werte** für GitHub aus.

### 4. Claude-API-Schlüssel
Unter [console.anthropic.com](https://console.anthropic.com) › API Keys legst du einen Schlüssel an. Die Kosten bleiben gering, weil jedes Video nur einmal zusammengefasst wird.

### 5. GitHub einrichten
1. Lege auf GitHub ein neues Repository an, z. B. `abo-uebersicht`, und lade alle Dateien dieses Ordners hoch.
2. Unter **Settings › Secrets and variables › Actions › New repository secret** legst du vier Secrets an:
   - `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`: die drei Werte aus Schritt 3
   - `ANTHROPIC_API_KEY`
3. Unter **Settings › Pages › Build and deployment › Source** wählst du **GitHub Actions**.
4. Unter **Actions › Übersicht aktualisieren › Run workflow** startest du den ersten Lauf.

Danach ist die App unter `https://<dein-name>.github.io/abo-uebersicht/` erreichbar.

### 6. Aufs Handy holen
Öffne die Adresse in Chrome und tippe auf **⋮ › App installieren** (oder **Zum Startbildschirm hinzufügen**). Tippst du auf **In YouTube öffnen**, startet die YouTube-App.

### 7. Neue Videos direkt in der App abrufen
Es gibt keine automatischen Läufe. Über den Aktualisieren-Knopf (↻) oben rechts startest du einen Lauf vom Handy aus, ohne GitHub zu öffnen. Dafür braucht die App einmalig einen GitHub-Token:
1. Im Browser unter [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) einen **Fine-grained Token** anlegen.
2. **Repository access:** *Only select repositories* › `abo-uebersicht`.
3. **Permissions:** *Actions* › *Read and write*. Mehr braucht er nicht.
4. Ablaufdatum wählen, Token erzeugen und kopieren.
5. In der App auf ↻ tippen, Token einfügen, **Speichern**.

Danach startet **Neue Videos abrufen** einen Lauf. Nach meist 1–3 Minuten lädt die App von selbst neu. Der Token liegt nur auf dem Handy und nicht in der Sicherungsdatei. Er kann nur die Workflows dieses Repos starten und verwalten, aber keinen Code ändern.

## Anpassen
In `config.toml` kannst du ändern:
- **effort** (Aufwand) für Claude.
- **max_days**, also wie weit zurück gesammelt wird.
- ob **Shorts** angezeigt werden.
- das **Claude-Modell**.

Der Workflow `.github/workflows/update.yml` läuft nur, wenn du ihn startest: in der App (↻), in GitHub unter **Actions › Übersicht aktualisieren › Run workflow** oder per `gh workflow run update.yml`. Einen Zeitplan gibt es bewusst nicht, weil GitHub geplante Läufe oft auslässt oder stark verspätet.

## Wenn etwas nicht klappt
- **Lauf schlägt mit „Google-Login fehlgeschlagen“ fehl:** Führe `python auth_setup.py` erneut aus und ersetze das Secret `YT_REFRESH_TOKEN`. Das passiert z. B., wenn du den Zugriff unter myaccount.google.com › Sicherheit entfernt hast oder die App doch im Testmodus war.
- **App meldet beim Abrufen „Token ungültig oder abgelaufen“ oder „darf den Abruf nicht starten“:** Lege wie in Schritt 7 einen neuen Token an und füge ihn in der App unter ↻ › *GitHub-Token ändern* ein.
- **Ersatzlösung ohne Login:** Exportiere die Abo-Liste über [takeout.google.com](https://takeout.google.com) (nur *YouTube › Abos*) und lege den Inhalt der CSV als Secret `SUBSCRIPTIONS_CSV` an. Sie wird automatisch genutzt, wenn der Login nicht funktioniert. Neue Abos tauchen dann aber erst nach einem neuen Export auf.

## Lokal ausprobieren
```powershell
pip install -r requirements.txt
$env:YT_CLIENT_ID = "..."        # ebenso YT_CLIENT_SECRET, YT_REFRESH_TOKEN, ANTHROPIC_API_KEY
python build.py
cd site && python -m http.server 8000   # dann http://localhost:8000
```
Ohne Netz und ohne Schlüssel funktioniert ein Testlauf mit Beispiel-Feeds: `tests/subscriptions.csv` nach `subscriptions.csv` kopieren, dann
`python build.py --offline tests/feeds --now 2026-10-23T20:00:00Z`.

## Gut zu wissen
- **Datenschutz:** Zugangsdaten und Abo-Liste liegen nur als Secrets bei GitHub, nicht im Code. Die App hat nur **Lesezugriff** auf YouTube. Die fertige Seite ist bei kostenlosem GitHub Pages aber unter ihrer Adresse öffentlich abrufbar. Sie wird nicht von Suchmaschinen indexiert, hat aber auch kein Passwort. Willst du einen Schutz, kannst du dieselben Dateien bei Cloudflare Pages hosten und dort *Cloudflare Access* davorschalten.
- **Zusammenfassungen** entstehen aus Titel und Videobeschreibung, nicht aus dem Gesprochenen.
- **RSS-Feeds** enthalten pro Kanal nur die letzten 15 Videos. Bei sehr aktiven Kanälen lädt das Skript die übrigen automatisch über die YouTube-API nach (1 Kontingent-Einheit pro 50 Videos).
- **Shorts** werden ausgeblendet, das heißt alle Videos bis 60 Sekunden sowie alles, was der Feed als Short kennzeichnet.
- **YouTube-Kontingent:** Ein Lauf verbraucht nur wenige Einheiten des kostenlosen Tageskontingents von 10.000.
