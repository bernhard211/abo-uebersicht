#!/usr/bin/env python3
"""Erstellt site/data.json: neue Videos deiner YouTube-Abos der letzten Tage,
mit Thema und Kurz-Zusammenfassung.

Umgebungsvariablen (optional):
  ANTHROPIC_API_KEY  Themen + Zusammenfassungen per Claude (ohne: Beschreibung als Ersatz)
  YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
                     Abos automatisch über die YouTube-API lesen (einrichten mit auth_setup.py);
                     ohne: Abo-Liste aus subscriptions.csv (Takeout)
  YT_API_KEY         nur ohne Login nötig: Videodauer über die YouTube Data API

Aufruf:
  python build.py                        normaler Lauf
  python build.py --offline tests/feeds  Feeds aus Dateien statt aus dem Netz (<channel_id>.xml)
  python build.py --now 2026-10-23T20:00:00Z
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import threading
import time
import tomllib
from zoneinfo import ZoneInfo
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
CACHE_FILE = ROOT / "data" / "cache.json"
FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={}"
UA = "Mozilla/5.0 (Abo-Uebersicht)"
NS = {
    "a": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}
FALLBACK_TOPIC = "Sonstiges"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- Abos

def load_subscriptions(path: Path) -> list[dict]:
    """Takeout-CSV: Spalten Kanal-ID, Kanal-URL, Kanaltitel (Kopfzeile egal, auch deutsch)."""
    subs, seen = [], set()
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.reader(f):
            if not row:
                continue
            cid = row[0].strip()
            if not re.fullmatch(r"UC[\w-]{22}", cid) or cid in seen:
                continue
            seen.add(cid)
            title = row[2].strip() if len(row) > 2 and row[2].strip() else cid
            subs.append({"id": cid, "title": title})
    return subs


# ---------------------------------------------------------------- RSS

def http_get(url: str, timeout: int = 20, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def http_post(url: str, form: dict, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(),
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- Google-Login (optional)

def oauth_access_token() -> str | None:
    """Tauscht den gespeicherten Refresh-Token gegen einen kurzlebigen Zugriffstoken."""
    cid, secret, refresh = (os.environ.get(k) for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"))
    if not (cid and secret and refresh):
        return None
    data = json.loads(http_post("https://oauth2.googleapis.com/token", {
        "client_id": cid, "client_secret": secret,
        "refresh_token": refresh, "grant_type": "refresh_token",
    }))
    return data["access_token"]


def fetch_subscriptions_api(token: str) -> list[dict]:
    """Alle eigenen Abos, 50 pro Seite (1 Kontingent-Einheit je Seite)."""
    subs, page = [], None
    while True:
        params = {"part": "snippet", "mine": "true", "maxResults": 50, "order": "alphabetical"}
        if page:
            params["pageToken"] = page
        data = json.loads(http_get("https://www.googleapis.com/youtube/v3/subscriptions?" +
                                   urllib.parse.urlencode(params),
                                   headers={"Authorization": f"Bearer {token}"}))
        for item in data.get("items", []):
            sn = item["snippet"]
            subs.append({"id": sn["resourceId"]["channelId"], "title": sn.get("title", "")})
        page = data.get("nextPageToken")
        if not page:
            return subs


def fetch_feed(cid: str, offline_dir: Path | None) -> bytes | None:
    if offline_dir:
        p = offline_dir / f"{cid}.xml"
        return p.read_bytes() if p.exists() else None
    for attempt in range(3):
        try:
            return http_get(FEED_URL.format(cid))
        except Exception as e:  # noqa: BLE001 – einzelner Kanal darf scheitern
            if attempt == 2:
                log(f"  ! Feed {cid}: {e}")
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def parse_feed(xml: bytes, sub: dict) -> list[dict]:
    root = ET.fromstring(xml)
    channel = root.findtext("a:author/a:name", default="", namespaces=NS) or \
        root.findtext("a:title", default="", namespaces=NS) or sub["title"]
    out = []
    for e in root.findall("a:entry", NS):
        vid = e.findtext("yt:videoId", default="", namespaces=NS)
        if not vid:
            continue
        link_el = e.find("a:link", NS)
        link = link_el.get("href", "") if link_el is not None else ""
        thumb_el = e.find("media:group/media:thumbnail", NS)
        out.append({
            "id": vid,
            "title": e.findtext("a:title", default="", namespaces=NS).strip(),
            "channel": channel.strip(),
            "channel_id": sub["id"],
            "published": e.findtext("a:published", default="", namespaces=NS),
            "description": (e.findtext("media:group/media:description", default="", namespaces=NS) or "").strip(),
            "thumb": thumb_el.get("url") if thumb_el is not None else f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            "is_short": "/shorts/" in link,
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return out


def parse_time(s: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


# ---------------------------------------------------------------- Dauer (optional)

def iso_duration_seconds(s: str) -> int:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + se


def fetch_durations(ids: list[str], key: str | None = None, token: str | None = None) -> dict[str, int]:
    """1 Kontingent-Einheit pro 50 Videos – praktisch kostenlos."""
    out = {}
    headers = {"Authorization": f"Bearer {token}"} if token else None
    for i in range(0, len(ids), 50):
        params = {"part": "contentDetails", "id": ",".join(ids[i:i + 50])}
        if not token:
            params["key"] = key
        q = urllib.parse.urlencode(params)
        try:
            data = json.loads(http_get(f"https://www.googleapis.com/youtube/v3/videos?{q}", headers=headers))
        except Exception as e:  # noqa: BLE001
            log(f"  ! Dauer-Abfrage: {e}")
            continue
        for item in data.get("items", []):
            out[item["id"]] = iso_duration_seconds(item["contentDetails"].get("duration", ""))
    return out


# ---------------------------------------------------------------- Claude

class ClaudeError(Exception):
    pass


def extract_json(text: str):
    """Nur als Rückfall, falls die Antwort doch nicht reines JSON ist."""
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1)
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=0)
    return json.loads(text[start:])


EFFORT = "low"   # wird in main() aus config.toml gesetzt


def claude_json(client, model: str, user: str, schema: dict, max_tokens: int = 16000,
                system: str = "Antworte ausschließlich mit JSON nach dem vorgegebenen Schema."):
    """Fragt Claude und bekommt garantiert JSON nach `schema` zurück (Structured Outputs).

    Das Nachdenken (adaptive thinking) wird abgeschaltet: Es verbraucht sonst das Antwortbudget
    und schneidet die Antwort ab. Über extra_body, damit es mit jeder SDK-Version funktioniert.
    """
    output_config = {"format": {"type": "json_schema", "schema": schema}}
    if EFFORT:
        output_config["effort"] = EFFORT
    extra = {"thinking": {"type": "disabled"}, "output_config": output_config}
    resp = client.messages.create(
        model=model, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}],
        extra_body=extra,
    )
    stop = getattr(resp, "stop_reason", None)
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    if stop in ("max_tokens", "refusal"):
        raise ClaudeError(f"Antwort unvollständig (stop_reason={stop})")
    if not text.strip():
        raise ClaudeError(f"leere Antwort (stop_reason={stop})")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return extract_json(text)


TOPICS_FILE = ROOT / "data" / "topics.json"
DEFAULT_TOPICS = ["Technik", "Wissenschaft", "Nachrichten", "Unterhaltung", "Musik", "Gaming"]


def derive_topics(client, cfg: dict, subs: list[dict], videos: list[dict]) -> list[str]:
    """Einmalig passende Themen aus den abonnierten Kanälen ableiten und merken."""
    if TOPICS_FILE.exists():
        saved = json.loads(TOPICS_FILE.read_text("utf-8")).get("topics") or []
        if saved:
            return saved
    channels = sorted({s["title"] for s in subs if s.get("title")} | {v["channel"] for v in videos})[:500]
    examples = [f'{v["channel"]}: {v["title"]}' for v in videos[:150]]
    user = (
        f"Das sind die YouTube-Kanäle, die ich abonniert habe:\n{json.dumps(channels, ensure_ascii=False)}\n\n"
        f"Beispiele aktueller Videos:\n{json.dumps(examples, ensure_ascii=False, indent=0)}\n\n"
        "Schlage 6 bis 10 Themen vor, mit denen sich diese Videos sinnvoll gruppieren lassen. "
        "Kurze deutsche Bezeichnungen (1–2 Wörter), klar voneinander abgegrenzt, so konkret wie möglich "
        "(lieber \"Elektronik\" und \"Software\" als nur \"Technik\", wenn beides viel vorkommt). "
        "Kein \"Sonstiges\". Sortiert nach Häufigkeit."
    )
    schema = {
        "type": "object",
        "properties": {"themen": {"type": "array", "items": {"type": "string"}}},
        "required": ["themen"],
        "additionalProperties": False,
    }
    try:
        raw = claude_json(client, cfg["llm"]["model"], user, schema, 2000)["themen"]
        topics = []
        for t in raw:
            t = str(t).strip()
            if t and t.lower() != FALLBACK_TOPIC.lower() and t not in topics:
                topics.append(t)
        topics = topics[:10]
    except Exception as e:  # noqa: BLE001
        log(f"  ! Themen ableiten: {e} – nutze Standardliste (nächster Lauf versucht es erneut)")
        return DEFAULT_TOPICS
    if not topics:
        return DEFAULT_TOPICS
    TOPICS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOPICS_FILE.write_text(json.dumps({"topics": topics}, ensure_ascii=False, indent=1), "utf-8")
    log(f"Themen abgeleitet: {', '.join(topics)}")
    return topics


def summarize_videos(client, cfg: dict, videos: list[dict], cache: dict) -> None:
    topics = cfg["topics"]
    sig = "|".join(topics)
    allowed = topics + [FALLBACK_TOPIC]
    by_lower = {t.lower(): t for t in allowed}
    # Neu einsortieren, wenn sich die Themenliste geändert hat
    todo = [v for v in videos if cache.get(v["id"], {}).get("sig") != sig]
    if not todo:
        return
    schema = {
        "type": "object",
        "properties": {
            "videos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "thema": {"type": "string", "enum": allowed},
                        "zusammenfassung": {"type": "string"},
                    },
                    "required": ["id", "thema", "zusammenfassung"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["videos"],
        "additionalProperties": False,
    }
    stats = {"ok": 0, "fail": 0}
    lock = threading.Lock()

    def run(batch: list[dict]) -> None:
        items = [{"id": v["id"], "kanal": v["channel"], "titel": v["title"],
                  "beschreibung": v["description"][:1200]} for v in batch]
        user = (
            f"Ordne jedes Video genau einem dieser Themen zu: {json.dumps(topics, ensure_ascii=False)}. "
            f"Nur wenn wirklich keines passt: \"{FALLBACK_TOPIC}\".\n"
            "Schreibe zu jedem Video eine Zusammenfassung auf Deutsch: 2–3 sachliche Sätze, worum es geht "
            "und was man mitnimmt. Keine Werbung, Sponsoren oder Links aus der Beschreibung übernehmen. "
            "Wenn die Beschreibung kaum Inhalt hat, schreibe ehrlich nur, was der Titel erkennen lässt.\n\n"
            f"Videos:\n{json.dumps(items, ensure_ascii=False, indent=1)}"
        )
        try:
            result = claude_json(client, cfg["llm"]["model"], user, schema)["videos"]
        except Exception as e:  # noqa: BLE001
            if len(batch) > 1:  # halbieren und nochmal
                mid = len(batch) // 2
                run(batch[:mid])
                run(batch[mid:])
            else:
                with lock:
                    stats["fail"] += 1
                log(f"  ! Zusammenfassung {batch[0]['id']}: {e}")
            return
        ids = {v["id"] for v in batch}
        for r in result:
            vid = r.get("id")
            if vid in ids:
                topic = by_lower.get(str(r.get("thema", "")).strip().lower(), FALLBACK_TOPIC)
                with lock:
                    cache[vid] = {"topic": topic, "summary": str(r.get("zusammenfassung", "")).strip(), "sig": sig}
                    stats["ok"] += 1

    bs = cfg["llm"].get("batch_size", 15)
    batches = [todo[i:i + bs] for i in range(0, len(todo), bs)]
    # 4 Anfragen parallel – schneller, aber weit unter den API-Ratenlimits
    with ThreadPoolExecutor(max_workers=4) as ex:
        for _ in ex.map(run, batches):
            log(f"  Zusammengefasst: {stats['ok']}/{len(todo)}" + (f" ({stats['fail']} fehlgeschlagen)" if stats["fail"] else ""))


DIGEST_FILE = ROOT / "data" / "digests.json"
WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


def make_digests(client, cfg: dict, videos: list[dict], today: dt.date, tz) -> dict[str, str]:
    """'Kurz gesagt' pro Zeitraum 1..max_days – nur aus abgeschlossenen Tagen (bis gestern 24 Uhr).

    Wird einmal pro Kalendertag erzeugt und für alle weiteren Läufe des Tages wiederverwendet.
    """
    if DIGEST_FILE.exists():
        saved = json.loads(DIGEST_FILE.read_text("utf-8"))
        if saved.get("date") == today.isoformat() and saved.get("digests"):
            log("Kurz gesagt: von heute schon vorhanden, wird wiederverwendet")
            return saved["digests"]
    max_days = cfg["max_days"]
    items = []
    for v in videos:
        day = parse_time(v["published"]).astimezone(tz).date()
        back = (today - day).days
        if 1 <= back <= max_days:
            items.append({"tage_zurueck": back, "kanal": v["channel"], "titel": v["title"], "thema": v["topic"]})
    if not items:
        return {}
    days = [str(d) for d in range(1, max_days + 1)]
    names = ", ".join(f"{d} = ab {WD[(today - dt.timedelta(days=int(d))).weekday()]} "
                      f"{(today - dt.timedelta(days=int(d))):%d.%m.}" for d in days)
    user = (
        "Hier sind Videos aus meinen Abos der letzten Tage "
        "(tage_zurueck: 1 = gestern, 2 = vorgestern usw.; heute ist nicht dabei):\n"
        f"{json.dumps(items, ensure_ascii=False, indent=0)}\n\n"
        f"Schreibe für jeden Zeitraum ({names}, jeweils bis gestern) einen kurzen Überblick auf Deutsch, "
        "2–3 Sätze, locker und konkret: Schwerpunkte, auffällige Kanäle und welches Video sich am meisten "
        "lohnt. Zeitraum N umfasst alle Videos mit tage_zurueck <= N. Keine Aufzählung aller Titel. "
        "Gibt es in einem Zeitraum keine Videos, schreibe einen leeren Text."
    )
    schema = {
        "type": "object",
        "properties": {d: {"type": "string"} for d in days},
        "required": days,
        "additionalProperties": False,
    }
    try:
        data = claude_json(client, cfg["llm"]["model"], user, schema, 8000)
    except Exception as e:  # noqa: BLE001 – nächster Lauf versucht es erneut
        log(f"  ! Kurz gesagt: {e}")
        return {}
    digests = {k: str(v).strip() for k, v in data.items() if k in days and str(v).strip()}
    DIGEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    DIGEST_FILE.write_text(json.dumps({"date": today.isoformat(), "digests": digests},
                                      ensure_ascii=False, indent=1), "utf-8")
    log(f"Kurz gesagt: neu erstellt für {today:%d.%m.%Y} (bis gestern)")
    return digests


# ---------------------------------------------------------------- Hauptablauf

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", type=Path, help="Ordner mit <channel_id>.xml statt Netzabruf")
    ap.add_argument("--now", help="Bezugszeitpunkt (ISO), nur für Tests")
    ap.add_argument("--out", type=Path, default=SITE / "data.json")
    args = ap.parse_args()

    with open(ROOT / "config.toml", "rb") as f:
        cfg = tomllib.load(f)
    global EFFORT
    EFFORT = cfg.get("llm", {}).get("effort", "low") or None
    tz = ZoneInfo(cfg.get("timezone", "Europe/Berlin"))
    now = parse_time(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    today = now.astimezone(tz).date()
    # Ganze Kalendertage: heute ab 0 Uhr plus max_days volle Tage davor
    cutoff = dt.datetime.combine(today - dt.timedelta(days=cfg["max_days"]), dt.time(), tzinfo=tz)

    token = None
    subs: list[dict] = []
    try:
        token = oauth_access_token()
    except Exception as e:  # noqa: BLE001
        log(f"  ! Google-Login fehlgeschlagen ({e}) – auth_setup.py erneut ausführen?")
    if token:
        try:
            subs = fetch_subscriptions_api(token)
            log(f"{len(subs)} Abos über die YouTube-API geladen")
        except Exception as e:  # noqa: BLE001
            log(f"  ! Abos über die API fehlgeschlagen: {e}")
    if not subs:
        subs_path = ROOT / cfg.get("subscriptions_file", "subscriptions.csv")
        if not subs_path.exists():
            log("Keine Abos: weder Google-Login eingerichtet noch subscriptions.csv vorhanden (siehe README)")
            return 1
        subs = load_subscriptions(subs_path)
        log(f"{len(subs)} Abos aus {subs_path.name} geladen")

    def work(sub):
        xml = fetch_feed(sub["id"], args.offline)
        if not xml:
            return []
        try:
            return parse_feed(xml, sub)
        except ET.ParseError as e:
            log(f"  ! Feed {sub['id']} unlesbar: {e}")
            return []

    with ThreadPoolExecutor(max_workers=1 if args.offline else 8) as ex:
        all_videos = [v for vs in ex.map(work, subs) for v in vs]

    videos = []
    for v in all_videos:
        t = parse_time(v["published"])
        if t and cutoff <= t <= now + dt.timedelta(hours=1):
            if cfg.get("include_shorts") or not v["is_short"]:
                videos.append(v)
    videos.sort(key=lambda v: v["published"], reverse=True)
    log(f"{len(videos)} neue Videos seit {cutoff:%d.%m.} 0 Uhr")

    yt_key = os.environ.get("YT_API_KEY")
    durations = {}
    if token or yt_key:
        durations = fetch_durations([v["id"] for v in videos], key=yt_key, token=token)
    if durations and not cfg.get("include_shorts"):
        # Kurze Hochkant-Videos, die der Feed nicht als Short markiert
        videos = [v for v in videos if durations.get(v["id"], 999) > 60]

    cache = json.loads(CACHE_FILE.read_text("utf-8")) if CACHE_FILE.exists() else {}
    digests: dict[str, str] = {}
    if os.environ.get("ANTHROPIC_API_KEY"):
        import anthropic
        client = anthropic.Anthropic()
        if not cfg.get("topics"):
            cfg["topics"] = derive_topics(client, cfg, subs, videos)
        summarize_videos(client, cfg, videos, cache)
        for v in videos:
            v["topic"] = cache.get(v["id"], {}).get("topic", FALLBACK_TOPIC)
        digests = make_digests(client, cfg, videos, today, tz)
    else:
        log("Kein ANTHROPIC_API_KEY – Beschreibung statt Zusammenfassung, ohne Themen")

    out_videos = []
    for v in videos:
        c = cache.get(v["id"], {})
        desc = re.sub(r"\s+", " ", v["description"])
        secs = durations.get(v["id"])
        out_videos.append({
            "id": v["id"], "title": v["title"], "channel": v["channel"], "channel_id": v["channel_id"],
            "published": v["published"], "url": v["url"], "thumb": v["thumb"],
            "topic": c.get("topic", FALLBACK_TOPIC),
            "summary": c.get("summary") or (desc[:280] + ("…" if len(desc) > 280 else "")),
            "seconds": secs,
        })

    # Cache klein halten: nur Videos aus dem Zeitfenster behalten
    keep = {v["id"] for v in videos}
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps({k: v for k, v in cache.items() if k in keep},
                                     ensure_ascii=False, indent=1), "utf-8")

    topics_used = [t for t in (cfg.get("topics") or []) + [FALLBACK_TOPIC] if any(v["topic"] == t for v in out_videos)]
    data = {
        "generated": now.isoformat(),
        "timezone": cfg.get("timezone", "Europe/Berlin"),
        "max_days": cfg["max_days"],
        "subscriptions": len(subs),
        "topics": topics_used,
        "digests": digests,
        "videos": out_videos,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    log(f"Geschrieben: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
