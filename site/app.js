(function () {
  'use strict';

  // ---------------------------------------------------------------- Speicher auf dem Gerät
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('abo.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('abo.' + k, JSON.stringify(v)); } catch (e) { /* voll oder gesperrt */ }
    }
  };

  var state = {
    view: 'main',              // 'main' | 'saved'
    group: 'kanal',            // Übersicht ist immer nach Kanal gruppiert
    range: 7,                  // wird bewusst nicht gespeichert
    open: {},                  // aufgeklappte Zusammenfassungen
    expanded: {},              // aufgeklappte Gruppen – beim Start alle zu
    editing: false,
    sort: store.get('sort', 'anzahl'),                 // 'anzahl' | 'eigene'
    order: store.get('order', { thema: [], kanal: [] }),
    saved: store.get('saved', {}),                     // id -> Video (+ savedAt)
    done: store.get('done', []),                       // abgehakte Kalendertage 'YYYY-MM-DD'
    theme: store.get('theme', 'auto'),                 // 'auto' | 'dark' | 'light'
    digestOpen: store.get('digestOpen', true),         // "Kurz gesagt" auf- oder zugeklappt
    locked: false,                                     // Passwort-Abfrage sichtbar
    chan: store.get('chan', {}),                       // Kanal-ID -> { name, color, lists: [] }
    lists: store.get('lists', []),                     // eigene Listen, in Anzeige-Reihenfolge
    list: 'Alle'                                       // aktiver Listen-Filter
  };
  var sheet = null;        // offenes Menü: { type: 'chan', cid, name } | { type: 'lists' }
  if (!state.order.thema) state.order.thema = [];
  if (!state.order.kanal) state.order.kanal = [];
  var data = null;
  var encPayload = null;   // verschlüsselte data.json, solange noch nicht entsperrt
  var groupNames = [];   // aktuell angezeigte Gruppen, Index = data-gi

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  // ---------------------------------------------------------------- Datum
  var MONTHS = ['Jan', 'Feb', 'März', 'Apr', 'Mai', 'Juni', 'Juli', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  var WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  // Zahl d im Zeitraum = der Kalendertag, bis zu dem sie zurückreicht (heute − d)
  function dayOf(d) { var x = startOfToday(); x.setDate(x.getDate() - d); return x; }
  function dayKey(date) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
  }
  function isDone(d) { return state.done.indexOf(dayKey(dayOf(d))) >= 0; }
  function fmtSpan(from, to) {
    var a = WD[from.getDay()] + ' ' + from.getDate() + '.', b = WD[to.getDay()] + ' ' + to.getDate() + '. ' + MONTHS[to.getMonth()];
    if (from.getMonth() !== to.getMonth()) a += ' ' + MONTHS[from.getMonth()];
    return a + ' – ' + b;
  }
  function ageLabel(ms) {
    var h = Math.floor(ms / 3600000);
    if (h < 1) return 'gerade eben';
    if (h < 24) return 'vor ' + h + ' Std.';
    var d = Math.floor(h / 24);
    return d === 1 ? 'vor 1 Tag' : 'vor ' + d + ' Tagen';
  }
  function durLabel(sec) {
    if (!sec) return '';
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }
  function totalLabel(sec) {
    var m = Math.round(sec / 60), h = Math.floor(m / 60);
    return h ? h + ' Std. ' + (m % 60) + ' Min.' : m + ' Min.';
  }

  // Alte Abhak-Markierungen (älter als 30 Tage) aufräumen
  (function () {
    var limit = startOfToday(); limit.setDate(limit.getDate() - 30);
    var lim = dayKey(limit);
    state.done = state.done.filter(function (k) { return k >= lim; });
    store.set('done', state.done);
  })();

  // ---------------------------------------------------------------- Darstellung (Dark Mode)
  var ICONS = {
    auto: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
    dark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    light: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  };
  var THEME_LABEL = { auto: 'automatisch (wie das Handy)', dark: 'dunkel', light: 'hell' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = state.theme;
    var dark = state.theme === 'dark' || (state.theme === 'auto' && mq && mq.matches);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#141312' : '#F6F5F2');
    $('themeBtn').innerHTML = ICONS[state.theme];
    $('themeBtn').setAttribute('aria-label', 'Darstellung: ' + THEME_LABEL[state.theme] + ' – tippen zum Wechseln');
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', applyTheme);

  // ---------------------------------------------------------------- Hilfen
  // Ganze Kalendertage: 0 = heute ab 0 Uhr, 1 = ab gestern 0 Uhr, …
  function inRange(v) {
    return Date.parse(v.published) >= dayOf(state.range).getTime();
  }
  function visibleVideos() {
    return data.videos.filter(function (v) {
      return inRange(v) && inList(v);
    });
  }

  // ---------------------------------------------------------------- Kanal-Farben und Listen
  var COLORS = [
    { id: 'rot', hex: '#DC2626', name: 'Rot' }, { id: 'orange', hex: '#EA580C', name: 'Orange' },
    { id: 'gelb', hex: '#EAB308', name: 'Gelb' }, { id: 'limette', hex: '#84CC16', name: 'Hellgrün' },
    { id: 'gruen', hex: '#15803D', name: 'Grün' }, { id: 'tuerkis', hex: '#14B8A6', name: 'Türkis' },
    { id: 'hellblau', hex: '#38BDF8', name: 'Hellblau' }, { id: 'blau', hex: '#1D4ED8', name: 'Blau' },
    { id: 'lila', hex: '#7C3AED', name: 'Lila' }, { id: 'pink', hex: '#EC4899', name: 'Pink' },
    { id: 'braun', hex: '#92400E', name: 'Braun' }
  ];
  function colorOf(id) { for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return COLORS[i]; return null; }
  function chanInfo(cid) { return state.chan[cid] || { lists: [] }; }
  function dotHtml(cid) {
    var c = colorOf(chanInfo(cid).color);
    return c ? '<span class="cdot" style="background:' + c.hex + '" title="' + c.name + '" aria-hidden="true"></span>' : '';
  }
  function inList(v) {
    return state.list === 'Alle' || (chanInfo(v.channel_id).lists || []).indexOf(state.list) >= 0;
  }
  function saveChan() {
    Object.keys(state.chan).forEach(function (k) {   // leere Einträge aufräumen
      var c = state.chan[k];
      if (!c.color && !(c.lists && c.lists.length)) delete state.chan[k];
    });
    store.set('chan', state.chan);
    store.set('lists', state.lists);
  }
  function editChan(cid, name) {
    var c = state.chan[cid] || (state.chan[cid] = { lists: [] });
    if (name) c.name = name;
    if (!c.lists) c.lists = [];
    return c;
  }
  function addList(name) {
    name = String(name || '').trim().slice(0, 30);
    if (!name || name === 'Alle') return null;
    if (state.lists.indexOf(name) < 0) state.lists.push(name);
    return name;
  }
  function listCount(name) {
    return Object.keys(state.chan).filter(function (k) { return (state.chan[k].lists || []).indexOf(name) >= 0; }).length;
  }
  function fallbackDigest(vids) {
    var cc = {};
    vids.forEach(function (v) { cc[v.channel] = (cc[v.channel] || 0) + 1; });
    var top = Object.keys(cc).sort(function (a, b) { return cc[b] - cc[a]; }).slice(0, 3);
    return plural(vids.length, 'Video', 'Videos') + ' aus ' + plural(Object.keys(cc).length, 'Kanal', 'Kanälen') +
      '. Am aktivsten: ' + top.map(function (c) { return c + ' (' + cc[c] + ')'; }).join(', ') + '.';
  }
  function savedList() {
    return Object.keys(state.saved).map(function (k) { return state.saved[k]; })
      .sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
  }
  function findVideo(id) {
    if (data) for (var i = 0; i < data.videos.length; i++) if (data.videos[i].id === id) return data.videos[i];
    return state.saved[id] || null;
  }

  var BOOKMARK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
  var BOOKMARK_FILLED = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
  var TRASH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  var CHEV = '<svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var GRIP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
  var PENCIL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
  var DOTS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  var BOX = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/></svg>';
  var BOX_ON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="currentColor"/><path d="M7.5 12.5l3 3 6-7" stroke="var(--card)" stroke-width="2.5"/></svg>';
  var ARROW_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
  var ARROW_DOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var CHECK = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';

  function cardHtml(v, inSaved) {
    var open = !!state.open[v.id];
    var isSaved = !!state.saved[v.id];
    var now = Date.now();
    // In der Übersicht steht der Kanal schon im Kopf der Gruppe, in der Merkliste an der Karte
    var sub = (inSaved
      ? '<button class="chanbtn" data-chan="' + esc(v.channel_id) + '" data-cname="' + esc(v.channel) + '" aria-label="Kanal ' + esc(v.channel) + ' markieren oder einer Liste zuordnen">' +
        dotHtml(v.channel_id) + esc(v.channel) + '</button> · '
      : '') + esc(ageLabel(now - Date.parse(v.published)));
    var dur = durLabel(v.seconds);
    var bgLabel = inSaved || isSaved ? 'Entfernen' : 'Merken';
    return '<div class="swipe' + (inSaved || isSaved ? ' remove' : '') + '" data-vid="' + esc(v.id) + '">' +
      '<div class="swipebg" aria-hidden="true">' + (inSaved || isSaved ? TRASH : BOOKMARK) + '<span>' + bgLabel + '</span></div>' +
      '<article class="card"><div class="cardtop">' +
      '<div class="thumb">' + (v.thumb ? '<img src="' + esc(v.thumb) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
      (dur ? '<span class="dur">' + dur + '</span>' : '') + '</div>' +
      '<div class="meta"><h3>' + esc(v.title) + '</h3><span class="sub">' + sub + '</span></div></div>' +
      (open ? '<p class="summary">' + esc(v.summary || 'Keine Beschreibung vorhanden.') + '</p>' : '') +
      '<div class="actions"><button data-toggle="' + esc(v.id) + '" aria-expanded="' + open + '">' +
      (open ? 'Weniger' : 'Zusammenfassung') + '</button>' +
      '<a href="' + esc(v.url) + '" target="_blank" rel="noopener">In YouTube öffnen</a>' +
      (inSaved
        ? '<button class="savebtn" data-save="' + esc(v.id) + '" aria-label="Von der Merkliste entfernen">' + TRASH + '</button>'
        : '<button class="savebtn" data-save="' + esc(v.id) + '" aria-pressed="' + isSaved + '" aria-label="' +
          (isSaved ? 'Von der Merkliste entfernen' : 'Auf die Merkliste') + '">' + (isSaved ? BOOKMARK_FILLED : BOOKMARK) + '</button>') +
      '</div></article></div>';
  }

  // ---------------------------------------------------------------- Zeichnen
  function rangeBtnHtml(d) {
    var day = dayOf(d), done = isDone(d);
    var when = WD_LONG[day.getDay()] + ' ' + day.getDate() + '. ' + MONTHS[day.getMonth()];
    return '<button data-range="' + d + '" class="' + (done ? 'done' : '') + (d === 0 ? ' today' : '') + '" aria-pressed="' + (state.range === d) + '" aria-label="' +
      (d === 0 ? 'Heute, ' + when : 'Ab ' + when + ' bis heute') + (done ? ', abgehakt' : '') + '">' +
      '<span class="num">' + (d === 0 ? 'Heute' : d) + '</span><span class="wd">' + WD[day.getDay()] + '</span>' +
      (done ? '<span class="check">' + CHECK + '</span>' : '') + '</button>';
  }

  function renderHeader() {
    var n = Object.keys(state.saved).length;
    $('savedCount').hidden = !n;
    $('savedCount').textContent = n > 99 ? '99+' : n;
    $('savedBtn').setAttribute('aria-pressed', String(state.view === 'saved'));
    $('savedBtn').setAttribute('aria-label', state.view === 'saved' ? 'Zurück zur Übersicht' : 'Merkliste öffnen (' + n + ')');
    var locked = state.locked;
    $('lock').hidden = !locked;
    $('savedBtn').hidden = locked;
    $('refresh').hidden = locked;
    $('lockBtn').hidden = locked || !encPayload;
    $('mainControls').hidden = state.view === 'saved' || locked;
    if (locked) {
      $('rangeLabel').innerHTML = '&nbsp;';
      $('title').textContent = 'Deine Abos';
      $('stats').textContent = 'Gesperrt';
      return;
    }

    if (state.view === 'saved') {
      $('rangeLabel').textContent = 'Für später';
      $('title').textContent = 'Merkliste';
      return;
    }
    $('title').textContent = 'Deine Abos';
    var max = data ? data.max_days : 7;
    var html = '';
    for (var d = 0; d <= max; d++) html += rangeBtnHtml(d);
    $('ranges').innerHTML = html;
    $('ranges').style.gridTemplateColumns = 'minmax(0, 1.45fr) repeat(' + max + ', minmax(0, 1fr))';
    var r = state.range, today = new Date();
    $('rangeText').textContent = 'Zeitraum: ' + (r === 0 ? 'heute' : r === 1 ? 'gestern + heute' : 'letzte ' + r + ' Tage + heute');
    $('rangeLabel').textContent = r === 0
      ? 'Heute · ' + WD[today.getDay()] + ' ' + today.getDate() + '. ' + MONTHS[today.getMonth()]
      : fmtSpan(dayOf(r), today);

    if (state.list !== 'Alle' && state.lists.indexOf(state.list) < 0) state.list = 'Alle';
    $('lists').innerHTML = ['Alle'].concat(state.lists).map(function (l) {
      return '<button data-lfilter="' + esc(l) + '" aria-pressed="' + (state.list === l) + '">' + (l === 'Alle' ? 'Alle Kanäle' : esc(l)) + '</button>';
    }).join('') + (state.lists.length
      ? '<button class="editchip" data-act="editlists" aria-label="Listen bearbeiten">' + PENCIL + '</button>'
      : '<button class="addchip" data-act="editlists">+ Liste anlegen</button>');
  }

  function orderedNames(groups) {
    var names = Object.keys(groups);
    var byCount = function (a, b) {
      return groups[b].length - groups[a].length || a.localeCompare(b, 'de');
    };
    if (state.sort !== 'eigene') return names.sort(byCount);
    var ord = state.order[state.group];
    var known = names.filter(function (n) { return ord.indexOf(n) >= 0; })
      .sort(function (a, b) { return ord.indexOf(a) - ord.indexOf(b); });
    var rest = names.filter(function (n) { return ord.indexOf(n) < 0; }).sort(byCount);
    return known.concat(rest);
  }

  function renderToolbar(hasGroups) {
    if (state.view === 'saved' || !hasGroups) { $('toolbar').innerHTML = ''; $('toolbar').hidden = true; return; }
    $('toolbar').hidden = false;
    if (state.editing) {
      $('toolbar').innerHTML = '<span class="label" style="font-size:13px;color:var(--ink2)">Am Griff ziehen zum Sortieren</span>' +
        '<span class="spacer"></span><button class="tbtn primary" data-act="edit">Fertig</button>';
      return;
    }
    var anyOpen = Object.keys(state.expanded).some(function (k) { return state.expanded[k]; });
    $('toolbar').innerHTML =
      '<div class="sortseg" role="group" aria-label="Sortierung">' +
      '<button data-sort="anzahl" aria-pressed="' + (state.sort === 'anzahl') + '">Anzahl</button>' +
      '<button data-sort="eigene" aria-pressed="' + (state.sort === 'eigene') + '">Eigene</button></div>' +
      '<span class="spacer"></span>' +
      (state.sort === 'eigene' ? '<button class="tbtn" data-act="edit">' + GRIP.replace('width="20" height="20"', 'width="16" height="16"') + 'Ordnen</button>' : '') +
      '<button class="tbtn" data-act="expandall">' + (anyOpen ? 'Alle zu' : 'Alle auf') + '</button>';
  }

  function renderSaved() {
    var list = savedList(), secs = 0;
    list.forEach(function (v) { secs += v.seconds || 0; });
    $('stats').textContent = plural(list.length, 'Video', 'Videos') + (secs ? ' · ' + totalLabel(secs) : '');
    $('digest').hidden = true;
    renderToolbar(false);
    var html = '<button class="tbtn backbtn" data-act="back">← Zurück zur Übersicht</button>';
    html += list.length
      ? '<div class="cards">' + list.map(function (v) { return cardHtml(v, true); }).join('') + '</div>'
      : '<div class="empty"><h2>Noch nichts gemerkt</h2><p>Wische ein Video in der Übersicht nach rechts oder tippe auf das Lesezeichen.</p></div>';
    $('groups').innerHTML = html;
    $('foot').textContent = list.length ? 'Zum Entfernen zur Seite wischen' : '';
  }

  function renderList() {
    if (state.locked) {
      $('digest').hidden = true; $('toolbar').hidden = true; $('groups').innerHTML = ''; $('foot').textContent = '';
      return;
    }
    if (state.view === 'saved') { renderSaved(); return; }
    if (!data) return;
    var vids = visibleVideos();
    var channels = {}, secs = 0;
    vids.forEach(function (v) { channels[v.channel_id] = 1; secs += v.seconds || 0; });
    var stats = plural(vids.length, 'neues Video', 'neue Videos') + ' · ' + plural(Object.keys(channels).length, 'Kanal', 'Kanäle');
    if (secs) stats += ' · ' + totalLabel(secs);
    $('stats').textContent = stats;

    // "Kurz gesagt" nur für abgeschlossene Tage (bis gestern), nicht für "Heute"
    var digest = '';
    if (state.range >= 1) {
      var todayStart = startOfToday().getTime();
      var past = vids.filter(function (v) { return Date.parse(v.published) < todayStart; });
      if (past.length) {
        digest = state.list === 'Alle' && data.digests && data.digests[String(state.range)]
          ? data.digests[String(state.range)] : fallbackDigest(past);
      }
    }
    $('digest').hidden = !digest || state.editing;
    $('digest').classList.toggle('closed', !state.digestOpen);
    $('digestToggle').setAttribute('aria-expanded', String(state.digestOpen));
    $('digestText').hidden = !state.digestOpen;
    $('digestText').textContent = digest;

    var groups = {};
    vids.forEach(function (v) { (groups[v.channel] = groups[v.channel] || []).push(v); });
    groupNames = orderedNames(groups);
    renderToolbar(groupNames.length > 0);

    var html = groupNames.map(function (n, gi) {
      var list = groups[n], gsec = 0;
      list.forEach(function (v) { gsec += v.seconds || 0; });
      var open = !state.editing && !!state.expanded[n];
      var count = plural(list.length, 'Video', 'Videos') + (gsec ? ' · ' + totalLabel(gsec) : '');
      var cid = list[0].channel_id;
      return '<section class="group' + (open ? ' open' : '') + '" data-gi="' + gi + '">' +
        '<div class="ghead">' +
        (state.editing ? '<span class="handle" data-handle="' + gi + '" aria-hidden="true">' + GRIP + '</span>' : '') +
        '<button class="gtoggle" data-expand="' + gi + '" aria-expanded="' + open + '"' + (state.editing ? ' tabindex="-1"' : '') + '>' +
        '<span class="gtext"><span class="gname">' + (cid ? dotHtml(cid) : '') + esc(n) + '</span><span class="gcount">' + count + '</span></span>' + (state.editing ? '' : CHEV) + '</button>' +
        (cid && !state.editing ? '<button class="gmenu" data-chan="' + esc(cid) + '" data-cname="' + esc(n) + '" aria-label="Kanal ' + esc(n) + ' markieren oder einer Liste zuordnen">' + DOTS + '</button>' : '') +
        '</div>' +
        (open ? '<div class="cards">' + list.map(function (v) { return cardHtml(v, false); }).join('') + '</div>' : '') +
        '</section>';
    }).join('');

    if (!vids.length) {
      html = '<div class="empty"><h2>Keine Videos in diesem Zeitraum</h2><p>Wähle einen längeren Zeitraum oder eine andere Liste.</p></div>';
    }
    $('groups').innerHTML = html;
    $('groups').classList.toggle('editing', state.editing);

    var g = new Date(data.generated);
    $('foot').textContent = 'Stand: ' + g.toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
      ' · ' + plural(data.subscriptions, 'Abo', 'Abos');
  }

  function render() { renderHeader(); renderList(); }

  // ---------------------------------------------------------------- Merkliste
  var toastTimer = null, undoFn = null;
  function toast(text, undo) {
    $('toastText').textContent = text;
    $('toastUndo').hidden = !undo;
    undoFn = undo || null;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').hidden = true; undoFn = null; }, 4000);
  }
  function setSaved(v, on) {
    if (on) {
      state.saved[v.id] = {
        id: v.id, title: v.title, channel: v.channel, channel_id: v.channel_id,
        thumb: v.thumb, url: v.url, seconds: v.seconds, summary: v.summary, published: v.published,
        savedAt: v.savedAt || Date.now()
      };
    } else {
      delete state.saved[v.id];
    }
    store.set('saved', state.saved);
  }
  function toggleSaved(id) {
    var v = findVideo(id);
    if (!v) return;
    var was = !!state.saved[id];
    var snapshot = was ? state.saved[id] : null;
    setSaved(v, !was);
    render();
    if (was) toast('Von der Merkliste entfernt', function () { setSaved(snapshot, true); render(); });
    else toast('Auf die Merkliste gesetzt', function () { setSaved(v, false); render(); });
  }

  // ---------------------------------------------------------------- Tage abhaken
  function toggleDone(d, btn) {
    var k = dayKey(dayOf(d)), i = state.done.indexOf(k);
    if (i >= 0) state.done.splice(i, 1); else state.done.push(k);
    store.set('done', state.done);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* egal */ } }
    // Knopf direkt anpassen statt neu zeichnen – der Finger liegt noch drauf
    var tmp = document.createElement('div');
    tmp.innerHTML = rangeBtnHtml(d);
    var fresh = tmp.firstChild;
    btn.className = fresh.className;
    btn.setAttribute('aria-label', fresh.getAttribute('aria-label'));
    btn.innerHTML = fresh.innerHTML;
  }

  // ---------------------------------------------------------------- Laden
  // ---------------------------------------------------------------- Menü für Kanäle und Listen
  var lastFocus = null;
  function openSheet(s) {
    sheet = s;
    lastFocus = document.activeElement;
    $('sheet').hidden = false;
    document.body.style.overflow = 'hidden';
    renderSheet();
    var first = $('sheetBody').querySelector('button, input');
    if (first) first.focus();
  }
  function closeSheet() {
    sheet = null;
    $('sheet').hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  function newListForm() {
    return '<form class="newlist" id="newListForm"><label class="sr" for="newList">Neue Liste</label>' +
      '<input id="newList" maxlength="30" placeholder="Neue Liste, z. B. Favoriten" autocomplete="off">' +
      '<button type="submit" class="tbtn">Anlegen</button></form>';
  }
  function renderSheet() {
    if (!sheet) return;
    var html = '';
    if (sheet.type === 'chan') {
      var c = chanInfo(sheet.cid), lists = c.lists || [];
      html += '<h2 id="sheetTitle">' + dotHtml(sheet.cid) + esc(sheet.name) + '</h2>' +
        '<h3>Farbe</h3><div class="swatches" role="group" aria-label="Farbe">' +
        '<button class="swatch none" data-color="" aria-pressed="' + !c.color + '" aria-label="Keine Farbe"></button>' +
        COLORS.map(function (col) {
          return '<button class="swatch" data-color="' + col.id + '" style="background:' + col.hex + '" aria-pressed="' + (c.color === col.id) + '" aria-label="' + col.name + '">' +
            (c.color === col.id ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>' : '') + '</button>';
        }).join('') + '</div>' +
        '<h3>Listen</h3>' +
        (state.lists.length
          ? '<div class="listopts">' + state.lists.map(function (l) {
              var on = lists.indexOf(l) >= 0;
              return '<button class="listopt" data-tlist="' + esc(l) + '" aria-pressed="' + on + '">' + (on ? BOX_ON : BOX) + '<span>' + esc(l) + '</span></button>';
            }).join('') + '</div>'
          : '<p class="hint2">Noch keine Listen. Leg unten eine an – der Kanal kommt gleich mit hinein.</p>') +
        newListForm();
    } else {
      html += '<h2 id="sheetTitle">Listen bearbeiten</h2>' +
        (state.lists.length
          ? '<div class="listedit">' + state.lists.map(function (l, i) {
              var n = state.lists.length;
              return '<div class="lrow">' +
                '<div class="lmoves">' +
                '<button class="lmove" data-lmove="' + i + '" data-dir="-1" aria-label="Liste ' + esc(l) + ' nach oben"' + (i === 0 ? ' disabled' : '') + '>' + ARROW_UP + '</button>' +
                '<button class="lmove" data-lmove="' + i + '" data-dir="1" aria-label="Liste ' + esc(l) + ' nach unten"' + (i === n - 1 ? ' disabled' : '') + '>' + ARROW_DOWN + '</button>' +
                '</div>' +
                '<div class="lmain"><input class="lname" data-li="' + i + '" value="' + esc(l) + '" maxlength="30" aria-label="Name der Liste ' + esc(l) + '">' +
                '<span class="lcount">' + plural(listCount(l), 'Kanal', 'Kanäle') + '</span></div>' +
                '<button class="ldel" data-dellist="' + i + '" aria-label="Liste ' + esc(l) + ' löschen">' + TRASH + '</button></div>';
            }).join('') + '</div><p class="hint2">Mit den Pfeilen änderst du die Reihenfolge der Filter. Zum Umbenennen einfach den Namen ändern. Kanäle ordnest du über ⋯ beim Kanal zu.</p>'
          : '<p class="hint2">Noch keine Listen.</p>') +
        newListForm();
    }
    html += '<button class="tbtn primary done" data-act="closesheet">Fertig</button>';
    $('sheetBody').innerHTML = html;
  }
  function deleteList(name) {
    if (!name) return;
    var snapLists = state.lists.slice(), snapChan = JSON.parse(JSON.stringify(state.chan));
    state.lists = state.lists.filter(function (l) { return l !== name; });
    Object.keys(state.chan).forEach(function (k) {
      state.chan[k].lists = (state.chan[k].lists || []).filter(function (l) { return l !== name; });
    });
    saveChan(); render(); renderSheet();
    toast('Liste „' + name + '“ gelöscht', function () { state.lists = snapLists; state.chan = snapChan; saveChan(); render(); renderSheet(); });
  }
  function renameList(i, name) {
    var old = state.lists[i];
    name = String(name || '').trim().slice(0, 30);
    if (!name || name === old || name === 'Alle' || state.lists.indexOf(name) >= 0) { renderSheet(); return; }
    state.lists[i] = name;
    Object.keys(state.chan).forEach(function (k) {
      var ls = state.chan[k].lists || [], j = ls.indexOf(old);
      if (j >= 0) ls[j] = name;
    });
    if (state.list === old) state.list = name;
    saveChan(); render();
  }

  // ---------------------------------------------------------------- Entschlüsseln
  function b64ToBytes(s) {
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function bytesToB64(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function decryptWith(rawKey, enc) {
    return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt'])
      .then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(enc.iv) }, k, b64ToBytes(enc.data)); })
      .then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }
  function deriveRaw(password, enc) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
      .then(function (base) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(enc.salt), iterations: enc.iter }, base, 256);
      });
  }
  // Mit dem gemerkten Schlüssel entsperren; null = Passwort nötig
  function unlockStored(enc) {
    var st = store.get('key', null);
    if (!st || st.salt !== enc.salt) return Promise.resolve(null);
    return decryptWith(b64ToBytes(st.k), enc).catch(function () {
      $('lockMsg').textContent = 'Das Passwort wurde geändert – bitte neu eingeben.';
      return null;
    });
  }
  function applyData(d) {
    data = d;
    state.locked = false;
    if (state.range > d.max_days) state.range = d.max_days;
    render();
  }
  function showLock() {
    data = null;
    state.locked = true;
    render();
  }

  function load() {
    var btn = $('refresh');
    btn.classList.add('spin');
    return fetch('data.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        if (!d || !d.enc) { encPayload = null; return d; }
        encPayload = d;
        return unlockStored(d);
      })
      .then(function (d) {
        if (d) applyData(d); else showLock();
      })
      .catch(function () {
        if (!data) { $('stats').textContent = 'Übersicht konnte nicht geladen werden.'; renderHeader(); }
      })
      .then(function () { btn.classList.remove('spin'); });
  }

  // ---------------------------------------------------------------- Klicks
  var suppress = { until: 0, el: null };   // Klick direkt nach Langdruck oder Wischen ignorieren
  function suppressOn(el) { suppress = { until: Date.now() + 400, el: el }; }
  document.addEventListener('click', function (e) {
    if (Date.now() < suppress.until && suppress.el && suppress.el.contains(e.target)) {
      suppress.until = 0; e.preventDefault(); return;
    }
    var b = e.target.closest('button');
    if (!b) return;
    var ds = b.dataset;
    if (b.id === 'toastUndo') { var f = undoFn; $('toast').hidden = true; undoFn = null; if (f) f(); return; }
    if (b.id === 'refresh') { load(); return; }
    if (ds.act === 'lock') { store.set('key', null); state.view = 'main'; showLock(); window.scrollTo(0, 0); return; }
    if (b.id === 'digestToggle') {
      state.digestOpen = !state.digestOpen; store.set('digestOpen', state.digestOpen); renderList(); return;
    }
    if (b.id === 'themeBtn') {
      state.theme = { auto: 'dark', dark: 'light', light: 'auto' }[state.theme];
      store.set('theme', state.theme); applyTheme(); return;
    }
    if (b.id === 'savedBtn' || ds.act === 'back') {
      state.view = state.view === 'saved' ? 'main' : 'saved'; state.editing = false;
      render(); window.scrollTo(0, 0); return;
    }
    if (ds.range) { state.range = +ds.range; render(); return; }
    if (ds.lfilter) { state.list = ds.lfilter; render(); return; }
    if (ds.chan) { openSheet({ type: 'chan', cid: ds.chan, name: ds.cname }); return; }
    if (ds.act === 'editlists') { openSheet({ type: 'lists' }); return; }
    if (ds.act === 'closesheet') { closeSheet(); return; }
    if (sheet && 'color' in ds) {
      editChan(sheet.cid, sheet.name).color = ds.color || null;
      saveChan(); render(); renderSheet(); return;
    }
    if (sheet && ds.tlist) {
      var c = editChan(sheet.cid, sheet.name), i = c.lists.indexOf(ds.tlist);
      if (i >= 0) c.lists.splice(i, 1); else c.lists.push(ds.tlist);
      saveChan(); render(); renderSheet(); return;
    }
    if (sheet && ds.dellist !== undefined) { deleteList(state.lists[+ds.dellist]); return; }
    if (sheet && ds.lmove !== undefined) {
      var from = +ds.lmove, to = from + (+ds.dir);
      if (to < 0 || to >= state.lists.length) return;
      var moved = state.lists.splice(from, 1)[0];
      state.lists.splice(to, 0, moved);
      saveChan(); render(); renderSheet();
      // Fokus bleibt auf demselben Pfeil der verschobenen Liste
      var again = $('sheetBody').querySelector('[data-lmove="' + to + '"][data-dir="' + ds.dir + '"]');
      if (again && !again.disabled) again.focus();
      else { var other = $('sheetBody').querySelector('[data-lmove="' + to + '"]:not([disabled])'); if (other) other.focus(); }
      return;
    }
    if (ds.sort) { state.sort = ds.sort; store.set('sort', state.sort); renderList(); return; }
    if (ds.act === 'edit') {
      state.editing = !state.editing;
      if (state.editing) { state.sort = 'eigene'; store.set('sort', 'eigene'); }
      renderList(); return;
    }
    if (ds.act === 'expandall') {
      var anyOpen = Object.keys(state.expanded).some(function (k) { return state.expanded[k]; });
      state.expanded = {};
      if (!anyOpen) groupNames.forEach(function (n) { state.expanded[n] = true; });
      renderList(); return;
    }
    if (ds.expand !== undefined && !state.editing) {
      var n = groupNames[+ds.expand];
      state.expanded[n] = !state.expanded[n];
      renderList(); return;
    }
    if (ds.toggle) { state.open[ds.toggle] = !state.open[ds.toggle]; renderList(); return; }
    if (ds.save) { toggleSaved(ds.save); return; }
  });

  // Lange drücken auf eine Zahl = Tag abhaken
  var lp = null;
  $('ranges').addEventListener('pointerdown', function (e) {
    var b = e.target.closest('button[data-range]');
    if (!b || (e.pointerType === 'mouse' && e.button !== 0)) return;
    b.classList.add('pressing');
    var cur = { b: b, x: e.clientX, y: e.clientY, fired: false };
    cur.t = setTimeout(function () {
      cur.fired = true;
      b.classList.remove('pressing');
      toggleDone(+b.dataset.range, b);
    }, 550);
    lp = cur;
  });
  function endLp(up) {
    if (!lp) return;
    clearTimeout(lp.t);
    lp.b.classList.remove('pressing');
    if (up && lp.fired) suppressOn(lp.b);   // den Klick nach dem Langdruck verwerfen
    lp = null;
  }
  $('ranges').addEventListener('pointerup', function () { endLp(true); });
  $('ranges').addEventListener('pointercancel', function () { endLp(false); });
  $('ranges').addEventListener('pointerleave', function () { endLp(false); });
  $('ranges').addEventListener('pointermove', function (e) {
    if (lp && !lp.fired && (Math.abs(e.clientX - lp.x) > 10 || Math.abs(e.clientY - lp.y) > 10)) endLp(false);
  });
  $('ranges').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ---------------------------------------------------------------- Wischen
  var sw = null;
  var list = $('list');
  list.addEventListener('pointerdown', function (e) {
    var card = e.target.closest('.card');
    if (!card || state.editing || e.target.closest('button, a')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sw = { el: card, wrap: card.parentNode, x: e.clientX, y: e.clientY, dx: 0, active: false, id: card.parentNode.dataset.vid, pid: e.pointerId };
  });
  window.addEventListener('pointermove', function (e) {
    if (!sw || e.pointerId !== sw.pid) return;
    var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (!sw.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
      if (Math.abs(dx) < 12) return;
      sw.active = true;
      sw.wrap.classList.add('swiping');
      try { sw.el.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
    }
    if (state.view === 'main' && dx < 0) dx = dx / 4;   // in der Übersicht nur nach rechts
    sw.dx = dx;
    sw.el.style.transform = 'translateX(' + dx + 'px)';
    sw.wrap.classList.toggle('left', dx < 0);
    sw.wrap.classList.toggle('armed', Math.abs(dx) > 90);
  });
  function endSwipe(cancelled) {
    if (!sw) return;
    var s = sw; sw = null;
    if (!s.active) return;
    suppressOn(s.wrap);
    var trigger = !cancelled && (state.view === 'main' ? s.dx > 90 : Math.abs(s.dx) > 90);
    s.el.style.transition = 'transform .18s ease-out';
    if (trigger && state.view === 'saved') {
      s.el.style.transform = 'translateX(' + (s.dx > 0 ? 1 : -1) * window.innerWidth + 'px)';
      setTimeout(function () { toggleSaved(s.id); }, 170);
      return;
    }
    s.el.style.transform = '';
    setTimeout(function () {
      s.wrap.classList.remove('swiping', 'armed', 'left');
      s.el.style.transition = '';
      if (trigger) toggleSaved(s.id);
    }, 180);
  }
  window.addEventListener('pointerup', function () { endSwipe(false); });
  window.addEventListener('pointercancel', function () { endSwipe(true); });

  // ---------------------------------------------------------------- Gruppen verschieben
  var drag = null;
  list.addEventListener('pointerdown', function (e) {
    var h = e.target.closest('[data-handle]');
    if (!h || !state.editing) return;
    e.preventDefault();
    var sec = h.closest('.group');
    sec.classList.add('dragging');
    drag = { sec: sec, pid: e.pointerId };
    try { h.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var y = e.clientY, sec = drag.sec;
    var prev = sec.previousElementSibling, next = sec.nextElementSibling;
    if (prev) { var r = prev.getBoundingClientRect(); if (y < r.top + r.height / 2) { sec.parentNode.insertBefore(sec, prev); } }
    if (next) { var q = next.getBoundingClientRect(); if (y > q.top + q.height / 2) { sec.parentNode.insertBefore(next, sec); } }
    if (y < 70) window.scrollBy(0, -12); else if (y > window.innerHeight - 70) window.scrollBy(0, 12);
  });
  function endDrag() {
    if (!drag) return;
    drag.sec.classList.remove('dragging');
    drag = null;
    var visible = Array.prototype.map.call(document.querySelectorAll('#groups .group'), function (s) { return groupNames[+s.dataset.gi]; });
    var rest = state.order[state.group].filter(function (n) { return visible.indexOf(n) < 0; });
    state.order[state.group] = visible.concat(rest);
    store.set('order', state.order);
    renderList();
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- Start
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  $('sheet').addEventListener('submit', function (e) {
    if (e.target.id !== 'newListForm') return;
    e.preventDefault();
    var name = addList($('newList').value);
    if (!name) return;
    if (sheet && sheet.type === 'chan') {
      var c = editChan(sheet.cid, sheet.name);
      if (c.lists.indexOf(name) < 0) c.lists.push(name);
    }
    saveChan(); render(); renderSheet();
    var inp = $('newList'); if (inp) inp.focus();
  });
  $('sheet').addEventListener('change', function (e) {
    if (e.target.classList.contains('lname')) renameList(+e.target.dataset.li, e.target.value);
  });
  document.addEventListener('keydown', function (e) {
    if (sheet && e.key === 'Escape') closeSheet();
  });

  $('showPw').addEventListener('change', function () { $('pw').type = this.checked ? 'text' : 'password'; });
  $('lock').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = $('pw').value;
    if (!pw || !encPayload) return;
    var enc = encPayload, btn = $('unlockBtn');
    btn.disabled = true;
    $('lockMsg').textContent = 'Entsperre …';
    deriveRaw(pw, enc)
      .then(function (raw) {
        return decryptWith(raw, enc).then(function (d) {
          store.set('key', { salt: enc.salt, k: bytesToB64(raw) });
          $('pw').value = '';
          $('lockMsg').textContent = '';
          applyData(d);
        });
      })
      .catch(function () { $('lockMsg').textContent = 'Passwort falsch. Bitte noch einmal versuchen.'; })
      .then(function () { btn.disabled = false; });
  });

  applyTheme();
  renderHeader();
  load();
})();
