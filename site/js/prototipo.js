// PROTOTYPE - preview branch only, never merged. Two places for the live
// fights line and the "Updated Xs ago", switched by the bar at the bottom left.
(function () {
  let mode = /[?&]proto=b\b/.test(location.search) ? 'b' : 'a';
  let match = null;
  let lastGood = 0;
  let fullW = 0;
  let zoomed = false;
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
    const hotTab = document.querySelector('.wvw-tab.is-hot');
    return {
      kills: Math.round(rate * rates.span / 600000),
      mins: Math.round(rates.span / 60000),
      hot: !!hotTab && hotTab.dataset.type === type,
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

  const minsAgo = (ms) => {
    const m = Math.floor(ms / 60000);
    return m < 1 ? 'under a minute ago' : `${m} min ago`;
  };

  const ago = () => {
    if (!lastGood) return { text: 'Updating…', stale: false };
    const s = Math.floor((Date.now() - lastGood) / 1000);
    if (s > 90) return { text: `No update for ${Math.round(s / 60)} min`, stale: true };
    return { text: `Updated ${s}s ago`, stale: false };
  };

  function explainOn(el, key, text) {
    el.title = text;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = el.closest('.proto-box');
      const ex = box && box.querySelector('.proto-explain');
      if (!ex) return;
      const same = ex.dataset.for === key && !ex.hidden;
      ex.hidden = same;
      ex.dataset.for = key;
      ex.textContent = text;
    });
  }

  function build() {
    const type = currentType();
    const f = fights(type);
    const box = document.createElement('div');
    box.className = `proto-box proto-${mode}`;

    const fb = document.createElement('button');
    fb.type = 'button';
    fb.className = 'proto-item proto-fights' + (f && f.hot ? ' is-hot' : '');
    const im = document.createElement('img');
    im.src = 'assets/icons/Event_Swords.webp';
    im.alt = '';
    im.width = 16;
    im.height = 16;
    fb.appendChild(im);
    const head = document.createElement('span');
    head.className = 'proto-head';
    const lab = document.createElement('span');
    lab.className = 'proto-label';
    lab.textContent = 'Fights';
    head.appendChild(lab);
    fb.appendChild(head);
    const val = document.createElement('span');
    val.className = 'proto-val';
    if (f) {
      const n = document.createElement('strong');
      n.textContent = String(f.kills);
      val.appendChild(n);
      val.appendChild(document.createTextNode(` kills · last ${f.mins} min`));
    } else {
      val.textContent = 'not enough history yet';
    }
    fb.appendChild(val);
    if (f && f.hot) {
      const tag = document.createElement('span');
      tag.className = 'proto-tag';
      tag.textContent = 'busiest map';
      head.appendChild(tag);
    }
    explainOn(fb, 'fights',
      'Player kills on this map, from snapshots of the game\'s API taken every few minutes. '
      + 'The crossed swords on a map\'s tab mark the map with the most fighting (10 kills or more per 10 min). '
      + 'The API has no player positions, so this says where the fighting is, not how many players are there.');

    const right = document.createElement('button');
    right.type = 'button';
    right.className = 'proto-item proto-when';
    const a = ago();
    const t = document.createElement('time');
    t.className = 'proto-ago' + (a.stale ? ' is-stale' : '');
    if (lastGood) t.dateTime = new Date(lastGood).toISOString();
    t.textContent = a.text;
    right.appendChild(t);
    const cap = latestCapture();
    const c = document.createElement('span');
    c.className = 'proto-cap';
    c.textContent = cap ? `latest capture ${minsAgo(Date.now() - cap)}` : '';
    right.appendChild(c);
    explainOn(right, 'when',
      'Updated: when this page last got an answer from the game\'s API; it asks every 30 s. '
      + 'Latest capture: the newest objective change in that answer. The API can run several minutes behind the game, '
      + 'so this is the honest age of what the map shows.');

    box.appendChild(fb);
    box.appendChild(right);
    const ex = document.createElement('p');
    ex.className = 'proto-explain';
    ex.hidden = true;
    box.appendChild(ex);
    return box;
  }

  function paint() {
    const tabs = document.querySelector('.wvw-tabs');
    if (!tabs) return;
    const old = document.querySelector('.proto-box');
    const keep = old && old.querySelector('.proto-explain');
    const box = build();
    if (keep && !keep.hidden) {
      const ex = box.querySelector('.proto-explain');
      ex.hidden = false; ex.dataset.for = keep.dataset.for; ex.textContent = keep.textContent;
    }
    if (old) old.remove();
    if (mode === 'a') tabs.after(box);
    else {
      const wrap = document.querySelector('.wvw-plot-wrap');
      if (!wrap) return;
      wrap.appendChild(box);
      box.classList.toggle('is-hidden', zoomed);
    }
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
      const box = document.querySelector('.proto-box.proto-b');
      if (box) box.classList.toggle('is-hidden', zoomed);
    }).observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
  }

  let lastTab = null;
  setInterval(() => {
    if (!document.querySelector('.wvw-tabs')) return;
    const tab = currentType();
    const svg = document.querySelector('.wvw-plot');
    if (svg && !svg.__proto) { zoomed = false; watchZoom(); }
    if (tab !== lastTab || !document.querySelector('.proto-box')
      || (mode === 'b' && !document.querySelector('.wvw-plot-wrap .proto-box'))) {
      lastTab = tab; paint(); return;
    }
    const t = document.querySelector('.proto-ago');
    if (t) {
      const a = ago();
      t.textContent = a.text;
      t.classList.toggle('is-stale', a.stale);
    }
    // markHotTab runs after the hook, so the tag catches up here.
    const hotTab = document.querySelector('.wvw-tab.is-hot');
    const isHot = !!hotTab && hotTab.dataset.type === tab;
    if (isHot !== !!document.querySelector('.proto-tag')) { paint(); return; }
    const cap = document.querySelector('.proto-cap');
    const at = latestCapture();
    if (cap && at) cap.textContent = `latest capture ${minsAgo(Date.now() - at)}`;
  }, 1000);

  // The switch, bottom left.
  const bar = document.createElement('div');
  bar.className = 'proto-switch';
  const lab = document.createElement('span');
  lab.textContent = 'Prototype:';
  bar.appendChild(lab);
  for (const [m, name] of [['a', 'A · strip'], ['b', 'B · on the map']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
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
