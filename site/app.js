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
    group: 'thema',            // 'kanal' | 'thema'
    filter: 'Alle',
    range: 7,                  // wird bewusst nicht gespeichert
    open: {},                  // aufgeklappte Zusammenfassungen
    expanded: {},              // aufgeklappte Gruppen – beim Start alle zu
    editing: false,
    sort: store.get('sort', 'anzahl'),                 // 'anzahl' | 'eigene'
    order: store.get('order', { thema: [], kanal: [] }),
    saved: store.get('saved', {}),                     // id -> Video (+ savedAt)
    done: store.get('done', []),                       // abgehakte Kalendertage 'YYYY-MM-DD'
    theme: store.get('theme', 'auto')                  // 'auto' | 'dark' | 'light'
  };
  if (!state.order.thema) state.order.thema = [];
  if (!state.order.kanal) state.order.kanal = [];
  var data = null;
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
  function inRange(v) {
    return Date.now() - Date.parse(v.published) <= state.range * 86400000;
  }
  function visibleVideos() {
    return data.videos.filter(function (v) {
      return inRange(v) && (state.filter === 'Alle' || v.topic === state.filter);
    });
  }
  function fallbackDigest(vids) {
    var tc = {}, cc = {};
    vids.forEach(function (v) { tc[v.topic] = (tc[v.topic] || 0) + 1; cc[v.channel] = (cc[v.channel] || 0) + 1; });
    var top = function (o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; })[0]; };
    var t = top(tc), c = top(cc);
    return 'Schwerpunkt: ' + t + ' (' + plural(tc[t], 'Video', 'Videos') + '). Am aktivsten war ' + c + '.';
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
  var CHECK = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';

  function cardHtml(v, inSaved) {
    var open = !!state.open[v.id];
    var isSaved = !!state.saved[v.id];
    var now = Date.now();
    var sub = (inSaved ? v.channel : (state.group === 'thema' ? v.channel : v.topic)) + ' · ' + ageLabel(now - Date.parse(v.published));
    var dur = durLabel(v.seconds);
    var bgLabel = inSaved || isSaved ? 'Entfernen' : 'Merken';
    return '<div class="swipe' + (inSaved || isSaved ? ' remove' : '') + '" data-vid="' + esc(v.id) + '">' +
      '<div class="swipebg" aria-hidden="true">' + (inSaved || isSaved ? TRASH : BOOKMARK) + '<span>' + bgLabel + '</span></div>' +
      '<article class="card"><div class="cardtop">' +
      '<div class="thumb">' + (v.thumb ? '<img src="' + esc(v.thumb) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
      (dur ? '<span class="dur">' + dur + '</span>' : '') + '</div>' +
      '<div class="meta"><h3>' + esc(v.title) + '</h3><span>' + esc(sub) + '</span></div></div>' +
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
    return '<button data-range="' + d + '" class="' + (done ? 'done' : '') + '" aria-pressed="' + (state.range === d) + '" aria-label="' +
      (d === 1 ? 'Letzter Tag' : 'Letzte ' + d + ' Tage') + ', bis ' + WD_LONG[day.getDay()] + ' ' + day.getDate() + '. ' + MONTHS[day.getMonth()] +
      (done ? ', abgehakt' : '') + '">' +
      '<span class="num">' + d + '</span><span class="wd">' + WD[day.getDay()] + '</span>' +
      (done ? '<span class="check">' + CHECK + '</span>' : '') + '</button>';
  }

  function renderHeader() {
    var n = Object.keys(state.saved).length;
    $('savedCount').hidden = !n;
    $('savedCount').textContent = n > 99 ? '99+' : n;
    $('savedBtn').setAttribute('aria-pressed', String(state.view === 'saved'));
    $('savedBtn').setAttribute('aria-label', state.view === 'saved' ? 'Zurück zur Übersicht' : 'Merkliste öffnen (' + n + ')');
    $('mainControls').hidden = state.view === 'saved';

    if (state.view === 'saved') {
      $('rangeLabel').textContent = 'Für später';
      $('title').textContent = 'Merkliste';
      return;
    }
    $('title').textContent = 'Deine Abos';
    var max = data ? data.max_days : 7;
    var html = '';
    for (var d = 1; d <= max; d++) html += rangeBtnHtml(d);
    $('ranges').innerHTML = html;
    $('ranges').style.gridTemplateColumns = 'repeat(' + max + ', minmax(0, 1fr))';
    $('rangeText').textContent = 'Zeitraum: ' + (state.range === 1 ? 'letzter Tag' : 'letzte ' + state.range + ' Tage');
    $('rangeLabel').textContent = (state.range === 1 ? 'Letzte 24 Stunden' : 'Letzte ' + state.range + ' Tage') +
      ' · ' + fmtSpan(dayOf(state.range), new Date());

    document.querySelectorAll('.seg button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.group === state.group));
    });
    var topics = ['Alle'].concat(data ? data.topics : []);
    $('chips').innerHTML = topics.map(function (t) {
      return '<button data-topic="' + esc(t) + '" aria-pressed="' + (state.filter === t) + '">' + esc(t) + '</button>';
    }).join('');
  }

  function orderedNames(groups) {
    var names = Object.keys(groups);
    var byCount = function (a, b) {
      var sa = a === 'Sonstiges', sb = b === 'Sonstiges';
      if (sa !== sb) return sa ? 1 : -1;
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
    if (state.view === 'saved') { renderSaved(); return; }
    if (!data) return;
    var vids = visibleVideos();
    var channels = {}, secs = 0;
    vids.forEach(function (v) { channels[v.channel_id] = 1; secs += v.seconds || 0; });
    var stats = plural(vids.length, 'neues Video', 'neue Videos') + ' · ' + plural(Object.keys(channels).length, 'Kanal', 'Kanäle');
    if (secs) stats += ' · ' + totalLabel(secs);
    $('stats').textContent = stats;

    var digest = '';
    if (vids.length) {
      digest = state.filter === 'Alle' && data.digests && data.digests[String(state.range)]
        ? data.digests[String(state.range)] : fallbackDigest(vids);
    }
    $('digest').hidden = !digest || state.editing;
    $('digestText').textContent = digest;

    var key = state.group === 'thema' ? 'topic' : 'channel';
    var groups = {};
    vids.forEach(function (v) { (groups[v[key]] = groups[v[key]] || []).push(v); });
    groupNames = orderedNames(groups);
    renderToolbar(groupNames.length > 0);

    var html = groupNames.map(function (n, gi) {
      var list = groups[n], gsec = 0;
      list.forEach(function (v) { gsec += v.seconds || 0; });
      var open = !state.editing && !!state.expanded[n];
      var count = plural(list.length, 'Video', 'Videos') + (gsec ? ' · ' + totalLabel(gsec) : '');
      return '<section class="group' + (open ? ' open' : '') + '" data-gi="' + gi + '">' +
        '<div class="ghead">' +
        (state.editing ? '<span class="handle" data-handle="' + gi + '" aria-hidden="true">' + GRIP + '</span>' : '') +
        '<button class="gtoggle" data-expand="' + gi + '" aria-expanded="' + open + '"' + (state.editing ? ' tabindex="-1"' : '') + '>' +
        '<span class="gname">' + esc(n) + '</span><span class="gcount">' + count + '</span>' + (state.editing ? '' : CHEV) + '</button></div>' +
        (open ? '<div class="cards">' + list.map(function (v) { return cardHtml(v, false); }).join('') + '</div>' : '') +
        '</section>';
    }).join('');

    if (!vids.length) {
      html = '<div class="empty"><h2>Keine Videos in diesem Zeitraum</h2><p>Wähle einen längeren Zeitraum oder ein anderes Thema.</p></div>';
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
        id: v.id, title: v.title, channel: v.channel, channel_id: v.channel_id, topic: v.topic,
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
  function load() {
    var btn = $('refresh');
    btn.classList.add('spin');
    return fetch('data.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        data = d;
        if (state.range > d.max_days) state.range = d.max_days;
        if (state.filter !== 'Alle' && d.topics.indexOf(state.filter) < 0) state.filter = 'Alle';
        render();
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
    if (b.id === 'themeBtn') {
      state.theme = { auto: 'dark', dark: 'light', light: 'auto' }[state.theme];
      store.set('theme', state.theme); applyTheme(); return;
    }
    if (b.id === 'savedBtn' || ds.act === 'back') {
      state.view = state.view === 'saved' ? 'main' : 'saved'; state.editing = false;
      render(); window.scrollTo(0, 0); return;
    }
    if (ds.range) { state.range = +ds.range; render(); return; }
    if (ds.group) { if (state.group !== ds.group) { state.group = ds.group; state.expanded = {}; state.editing = false; } render(); return; }
    if (ds.topic) { state.filter = ds.topic; render(); return; }
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
  applyTheme();
  renderHeader();
  load();
})();
