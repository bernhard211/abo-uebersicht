(function () {
  'use strict';

  var state = { group: 'thema', filter: 'Alle', range: 7, open: {} };
  var data = null;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  var MONTHS = ['Jan', 'Feb', 'März', 'Apr', 'Mai', 'Juni', 'Juli', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  function dateRange(from, to) {
    if (from.getMonth() === to.getMonth()) return from.getDate() + '.–' + to.getDate() + '. ' + MONTHS[to.getMonth()];
    return from.getDate() + '. ' + MONTHS[from.getMonth()] + ' – ' + to.getDate() + '. ' + MONTHS[to.getMonth()];
  }
  function ageLabel(ms) {
    var h = Math.floor(ms / 3600000);
    if (h < 1) return 'gerade eben';
    if (h < 24) return 'vor ' + plural(h, 'Std.', 'Std.');
    var d = Math.floor(h / 24);
    return d === 1 ? 'vor 1 Tag' : 'vor ' + d + ' Tagen';
  }
  function durLabel(sec) {
    if (!sec) return '';
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function totalLabel(sec) {
    var m = Math.round(sec / 60), h = Math.floor(m / 60);
    return h ? h + ' Std. ' + (m % 60) + ' Min.' : m + ' Min.';
  }

  function visibleVideos() {
    var now = Date.now(), limit = state.range * 86400000;
    return data.videos.filter(function (v) {
      var age = now - Date.parse(v.published);
      return age <= limit && (state.filter === 'Alle' || v.topic === state.filter);
    });
  }

  function fallbackDigest(vids) {
    var tc = {}, cc = {}, longest = vids[0];
    vids.forEach(function (v) {
      tc[v.topic] = (tc[v.topic] || 0) + 1;
      cc[v.channel] = (cc[v.channel] || 0) + 1;
      if ((v.seconds || 0) > (longest.seconds || 0)) longest = v;
    });
    var top = function (o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; })[0]; };
    var t = top(tc), c = top(cc);
    var txt = 'Schwerpunkt: ' + t + ' (' + plural(tc[t], 'Video', 'Videos') + '). Am aktivsten war ' + c + '.';
    if (longest.seconds) txt += ' Längstes Video: »' + longest.title + '« bei ' + longest.channel + '.';
    return txt;
  }

  function renderControls() {
    var max = data ? data.max_days : 7;
    var html = '';
    for (var d = 1; d <= max; d++) {
      html += '<button data-range="' + d + '" aria-pressed="' + (state.range === d) + '" aria-label="' +
        (d === 1 ? 'Letzter Tag' : 'Letzte ' + d + ' Tage') + '">' + d + '</button>';
    }
    $('ranges').innerHTML = html;
    $('ranges').style.gridTemplateColumns = 'repeat(' + max + ', minmax(0, 1fr))';
    $('rangeText').textContent = 'Zeitraum: ' + (state.range === 1 ? 'letzter Tag' : 'letzte ' + state.range + ' Tage');

    var now = new Date(), from = new Date(now.getTime() - state.range * 86400000);
    $('rangeLabel').textContent = (state.range === 1 ? 'Letzte 24 Stunden' : 'Letzte ' + state.range + ' Tage') +
      ' · ' + dateRange(from, now);

    document.querySelectorAll('.seg button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.group === state.group));
    });

    var topics = ['Alle'].concat(data ? data.topics : []);
    $('chips').innerHTML = topics.map(function (t) {
      return '<button data-topic="' + esc(t) + '" aria-pressed="' + (state.filter === t) + '">' + esc(t) + '</button>';
    }).join('');
  }

  function renderList() {
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
    $('digest').hidden = !digest;
    $('digestText').textContent = digest;

    var key = state.group === 'thema' ? 'topic' : 'channel';
    var groups = {}, names = [];
    vids.forEach(function (v) {
      if (!groups[v[key]]) { groups[v[key]] = []; names.push(v[key]); }
      groups[v[key]].push(v);
    });
    names.sort(function (a, b) {
      var sa = a === 'Sonstiges', sb = b === 'Sonstiges';  // "Sonstiges" immer ans Ende
      if (sa !== sb) return sa ? 1 : -1;
      return groups[b].length - groups[a].length || a.localeCompare(b, 'de');
    });

    var now = Date.now();
    var html = names.map(function (n) {
      var list = groups[n], gsec = 0;
      list.forEach(function (v) { gsec += v.seconds || 0; });
      var count = plural(list.length, 'Video', 'Videos') + (gsec ? ' · ' + totalLabel(gsec) : '');
      return '<section class="group"><div class="grouphead"><h2>' + esc(n) + '</h2><span>' + count + '</span></div>' +
        list.map(function (v) {
          var open = !!state.open[v.id];
          var sub = (state.group === 'thema' ? v.channel : v.topic) + ' · ' + ageLabel(now - Date.parse(v.published));
          var dur = durLabel(v.seconds);
          return '<article class="card"><div class="cardtop">' +
            '<div class="thumb"><img src="' + esc(v.thumb) + '" alt="" loading="lazy">' +
            (dur ? '<span class="dur">' + dur + '</span>' : '') + '</div>' +
            '<div class="meta"><h3>' + esc(v.title) + '</h3><span>' + esc(sub) + '</span></div></div>' +
            (open ? '<p class="summary">' + esc(v.summary || 'Keine Beschreibung vorhanden.') + '</p>' : '') +
            '<div class="actions"><button data-toggle="' + esc(v.id) + '" aria-expanded="' + open + '">' +
            (open ? 'Weniger' : 'Zusammenfassung') + '</button>' +
            '<a href="' + esc(v.url) + '" target="_blank" rel="noopener">In YouTube öffnen</a></div></article>';
        }).join('') + '</section>';
    }).join('');

    if (!vids.length) {
      html = '<div class="empty"><h2>Keine Videos in diesem Zeitraum</h2>' +
        '<p>Wähle einen längeren Zeitraum oder ein anderes Thema.</p></div>';
    }
    $('groups').innerHTML = html;

    var g = new Date(data.generated);
    $('foot').textContent = 'Stand: ' + g.toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
      ' · ' + plural(data.subscriptions, 'Abo', 'Abos');
  }

  function render() { renderControls(); renderList(); }

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
        if (!data) { $('stats').textContent = 'Übersicht konnte nicht geladen werden.'; renderControls(); }
      })
      .then(function () { btn.classList.remove('spin'); });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.range) { state.range = +b.dataset.range; render(); }
    else if (b.dataset.group) { state.group = b.dataset.group; render(); }
    else if (b.dataset.topic) { state.filter = b.dataset.topic; render(); }
    else if (b.dataset.toggle) { state.open[b.dataset.toggle] = !state.open[b.dataset.toggle]; renderList(); }
    else if (b.id === 'refresh') { load(); }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  renderControls();
  load();
})();
