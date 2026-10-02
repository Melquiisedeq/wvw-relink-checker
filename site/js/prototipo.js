// PROTOTYPE - preview branch only, never merged. Two places for the fights
// line and the update age, switched by the bar at the bottom left.
(function () {
  let mode = /[?&]proto=a\b/.test(location.search) ? 'a' : 'b';
  let match = null;
  let lastGood = 0;
  let fullW = 0;
  let zoomed = false;
  let openKey = null;
  const FIGHT_WANT_MS = 10 * 60 * 1000;

  window.__protoOpen = (m) => { match = m; lastGood = 0; fullW = 0; };
  window.__protoGood = (m) => { match = m; lastGood = Date.now(); paint(); };

  const currentType = () => {
    const b = document.querySelector('.wvw-tab.is-active');
    return b && b.dataset.type;
  };

  // The same reading the tab's swords come from (markHotTab).
  function fights(type) {
    const rates = match && matchIsLive(match) ? fightRates(match, FIGHT_WANT_MS) : null;
    if (!rates) return null;
    const rate = rates.per.get(type) || 0;
    return {
      kills: Math.round(rate * rates.span / 600000),
      mins: Math.round(rates.span / 60000),
    };
  }

  // The newest capture the API reports, anywhere in the match: the one
  // timestamp in the answer that belongs to the game, not to us.
  function latestCapture() {
    let best = 0;
    for (const mp of (match && match.maps) || []) {
      for (const ob of mp.objectives || []) {
        const t = Date.parse(ob.last_flipped || '');
        if (t > best) best = t;
      }
    }
    return best;
  }

  const shortAgo = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)} min ago`;
  };

  const EXPLAIN = {
    fights: 'Player kills on this map in the last few minutes, from snapshots of the game\'s API. '
      + 'The crossed swords on a map\'s tab mark the map with the most. The API has no player '
      + 'positions: this says where the fighting is, not how many players are there.',
    when: 'Updated: when this page last got an answer from the game\'s API; it asks every 30 s. '
      + 'Capture: the newest objective change in that answer. The API can run minutes behind '
      + 'the game, so this is the real age of what the map shows.',
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function tappable(node, key) {
    node.title = EXPLAIN[key];
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      openKey = openKey === key ? null : key;
      paint();
    });
  }

  function buildFights() {
    const f = fights(currentType());
    const b = el('button', 'proto-fights');
    b.type = 'button';
    const im = el('img');
    im.src = 'assets/icons/Event_Swords.webp';
    im.alt = '';
    im.width = 18;
    im.height = 18;
    b.appendChild(im);
    const txt = el('span', 'proto-txt');
    txt.appendChild(el('span', 'proto-big', f ? String(f.kills) : '—'));
    txt.appendChild(el('span', 'proto-small', f ? `kills · ${f.mins} min` : 'kills · waiting'));
    b.appendChild(txt);
    tappable(b, 'fights');
    return b;
  }

  function buildWhen() {
    const b = el('button', 'proto-when');
    b.type = 'button';
    const t = el('time', 'proto-ago');
    b.appendChild(t);
    b.appendChild(el('span', 'proto-cap'));
    fillWhen(b);
    tappable(b, 'when');
    return b;
  }

  function fillWhen(b) {
    const t = b.querySelector('.proto-ago');
    const c = b.querySelector('.proto-cap');
    t.textContent = '';
    if (!lastGood) {
      t.textContent = 'Updating…';
    } else {
      const age = Date.now() - lastGood;
      const stale = age > 90 * 1000;
      t.classList.toggle('is-stale', stale);
      t.dateTime = new Date(lastGood).toISOString();
      if (stale) {
        t.textContent = `No update · ${Math.floor(age / 60000)} min`;
      } else {
        t.appendChild(el('span', 'proto-word', 'Updated '));
        t.appendChild(document.createTextNode(shortAgo(age)));
      }
    }
    const cap = latestCapture();
    c.textContent = cap ? `capture ${shortAgo(Math.max(0, Date.now() - cap))}` : '';
  }

  function paint() {
    const tabs = document.querySelector('.wvw-tabs');
    if (!tabs) return;
    for (const old of document.querySelectorAll('.proto-el')) old.remove();
    const fightsEl = buildFights();
    const whenEl = buildWhen();
    const ex = openKey ? el('p', 'proto-explain', EXPLAIN[openKey]) : null;
    if (mode === 'a') {
      const strip = el('div', 'proto-el proto-strip');
      strip.appendChild(fightsEl);
      strip.appendChild(whenEl);
      if (ex) strip.appendChild(ex);
      tabs.after(strip);
      return;
    }
    const wrap = document.querySelector('.wvw-plot-wrap');
    if (!wrap) return;
    const left = el('div', 'proto-el proto-hud proto-hud-l');
    left.appendChild(fightsEl);
    const right = el('div', 'proto-el proto-hud proto-hud-r');
    right.appendChild(whenEl);
    wrap.appendChild(left);
    wrap.appendChild(right);
    if (ex) {
      ex.classList.add('proto-el', 'proto-bubble', openKey === 'fights' ? 'at-l' : 'at-r');
      ex.addEventListener('click', (e) => { e.stopPropagation(); openKey = null; paint(); });
      wrap.appendChild(ex);
    }
    for (const n of wrap.querySelectorAll('.proto-el')) n.classList.toggle('is-hidden', zoomed);
  }

  function watchZoom() {
    const svg = document.querySelector('.wvw-plot');
    if (!svg || svg.__proto) return;
    svg.__proto = true;
    fullW = svg.viewBox.baseVal.width;
    new MutationObserver(() => {
      const z = svg.viewBox.baseVal.width < fullW * 0.98;
      if (z === zoomed) return;
      zoomed = z;
      for (const n of document.querySelectorAll('.wvw-plot-wrap .proto-el')) n.classList.toggle('is-hidden', zoomed);
    }).observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
  }

  let lastTab = null;
  let lastKills = null;
  setInterval(() => {
    if (!document.querySelector('.wvw-tabs')) return;
    const tab = currentType();
    const svg = document.querySelector('.wvw-plot');
    if (svg && !svg.__proto) { zoomed = false; watchZoom(); }
    const f = fights(tab);
    const k = f ? `${f.kills}/${f.mins}` : '';
    if (tab !== lastTab || k !== lastKills || !document.querySelector('.proto-el')
      || (mode === 'b' && !document.querySelector('.wvw-plot-wrap .proto-el'))) {
      lastTab = tab; lastKills = k; paint(); return;
    }
    const w = document.querySelector('.proto-when');
    if (w) fillWhen(w);
  }, 1000);

  // The switch, bottom left.
  const bar = el('div', 'proto-switch');
  bar.appendChild(el('span', null, 'Prototype:'));
  for (const [m, name] of [['b', 'B · on the map'], ['a', 'A · above the map']]) {
    const b = el('button', null, name);
    b.type = 'button';
    b.dataset.m = m;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      mode = m;
      for (const x of bar.querySelectorAll('button')) x.classList.toggle('on', x.dataset.m === mode);
      paint();
    });
    bar.appendChild(b);
  }
  for (const x of bar.querySelectorAll('button')) x.classList.toggle('on', x.dataset.m === mode);
  const mount = () => document.body.appendChild(bar);
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();
