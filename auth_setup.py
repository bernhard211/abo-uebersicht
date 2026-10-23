#!/usr/bin/env python3
"""Einmalige Google-Anmeldung für die Abo-Übersicht.

Holt einen Refresh-Token, mit dem build.py deine Abos täglich selbst auslesen kann
(nur Lesezugriff auf YouTube). Läuft auf deinem PC, braucht nur Python, keine Zusatzpakete.

Aufruf:  python auth_setup.py
"""
import base64
import hashlib
import http.server
import json
import secrets
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def main() -> int:
    print("Client-ID und Client-Secret findest du in der Google Cloud Console unter")
    print("Google Auth Platform › Clients (Typ: Desktop-App).\n")
    client_id = input("Client-ID:     ").strip()
    client_secret = input("Client-Secret: ").strip()
    if not client_id or not client_secret:
        print("Beides wird benötigt.")
        return 1

    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    redirect_uri = f"http://127.0.0.1:{port}"
    result: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" not in q and "error" not in q:
                self.send_response(404)
                self.end_headers()
                return
            result.update({k: v[0] for k, v in q.items()})
            ok = "code" in q and result.get("state") == state
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "Fertig – du kannst dieses Fenster schließen." if ok else "Anmeldung fehlgeschlagen – siehe Konsole."
            self.wfile.write(f"<html><body style='font-family:sans-serif;padding:40px'><h2>{msg}</h2></body></html>".encode())

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent",
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
    })
    print("\nIm Browser öffnet sich die Google-Anmeldung. Falls nicht, diese Adresse öffnen:\n")
    print(url + "\n")
    print('Hinweis "Google hat diese App nicht überprüft": auf "Erweitert" und dann "Weiter zu …" klicken.')
    webbrowser.open(url)
    while "code" not in result and "error" not in result:
        server.handle_request()
    server.server_close()

    if "error" in result:
        print(f"\nAbgebrochen: {result['error']}")
        return 1
    if result.get("state") != state:
        print("\nSicherheitsprüfung fehlgeschlagen (state passt nicht).")
        return 1

    form = {
        "code": result["code"], "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code", "code_verifier": verifier,
    }
    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=urllib.parse.urlencode(form).encode())) as r:
            tokens = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"\nToken-Abruf fehlgeschlagen: {e.read().decode(errors='replace')}")
        return 1

    refresh = tokens.get("refresh_token")
    if not refresh:
        print("\nKein Refresh-Token erhalten. Unter myaccount.google.com/permissions den Zugriff entfernen und neu starten.")
        return 1

    # Kurzer Test: ein paar Abos lesen
    req = urllib.request.Request(
        "https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=5",
        headers={"Authorization": f"Bearer {tokens['access_token']}"})
    try:
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
        total = data.get("pageInfo", {}).get("totalResults", "?")
        names = ", ".join(i["snippet"]["title"] for i in data.get("items", []))
        print(f"\nTest OK – {total} Abos gefunden, z. B.: {names}")
    except urllib.error.HTTPError as e:
        print(f"\nAnmeldung OK, aber Abo-Test fehlgeschlagen: {e.read().decode(errors='replace')}")
        print("Ist die YouTube Data API v3 im Projekt aktiviert?")

    print("\nLege diese drei Secrets in GitHub an (Settings › Secrets and variables › Actions):\n")
    print(f"  YT_CLIENT_ID      = {client_id}")
    print(f"  YT_CLIENT_SECRET  = {client_secret}")
    print(f"  YT_REFRESH_TOKEN  = {refresh}")
    print("\nDen Refresh-Token wie ein Passwort behandeln und nirgends sonst speichern.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
