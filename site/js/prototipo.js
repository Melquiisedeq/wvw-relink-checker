// PROTOTYPE - preview branch only, never merged. Two places for the live
// summary and the "Updated Xs ago", switched by the bar at the bottom left.
(function () {
  let mode = /[?&]proto=b\b/.test(location.search) ? 'b' : 'a';
  let match = null;
  let lastGood = 0;
  const snaps = [];          // { at, maps: { type: { kills, deaths } } }
  let fullW = 0;
  let zoomed = false;
  const TEAMS = ['red', 'blue', 'green'];
  const SHORT = { red: 'R', blue: 'B', green: 'G' };

  window.__protoOpen = (m) => { match = m; lastGood = 0; snaps.length = 0; fullW = 0; };
  window.__protoGood = (m) => {
    match = m; lastGood = Date.now();
    const maps = {};
    for (const mp of m.maps || []) maps[mp.type] = { kills: mp.kills || {}, deaths: mp.deaths || {} };
    snaps.push({ at: lastGood, maps });
    while (snaps.length > 40) snaps.shift();
    paint();
  };

  const currentType = () => {
    const b = document.querySelector('.wvw-tab.is-active');
    return b && b.dataset.type;
  };

  function summary(type) {
    const mp = match && (match.maps || []).find((x) => x.type === type);
    if (!mp) return null;
    const ri = { red: 0, blue: 0, green: 0 };
    let soon = Infinity;
    const t3 = { red: 0, blue: 0, green: 0 };
    for (const ob of mp.objectives || []) {
      const own = String(ob.owner || '').toLowerCase();
      if (ob.type !== 'Ruins' && ob.type !== 'Spawn') {
        const left = riLeft(ob.last_flipped);
        if (left && own in ri) { ri[own] += 1; soon = Math.min(soon, left); }
      }
      const meta = objectiveCatalogue && objectiveCatalogue.get(ob.id);
      const tier = meta ? objectiveTier(meta, ob) : null;
      if (tier && tier.tier >= 3 && own in t3) t3[own] += 1;
    }
    // Kills plus deaths per team on this map, from our own 30 s pulls.
    let fight = null;
    if (snaps.length >= 2) {
      const now = snaps[snaps.length - 1];
      let base = snaps[0];
      for (const s of snaps) if (now.at - s.at >= 10 * 60 * 1000) base = s;
      const a = base.maps[type], b = now.maps[type];
      if (a && b) {
        fight = { mins: Math.max(1, Math.round((now.at - base.at) / 60000)) };
        for (const t of TEAMS) {
          const d = (Number(b.kills[t] || 0) - Number(a.kills[t] || 0))
            + (Number(b.deaths[t] || 0) - Number(a.deaths[t] || 0));
          fight[t] = Math.max(0, d);
        }
      }
    }
    return { ri, soon, t3, fight };
  }

  const ago = () => {
    if (!lastGood) return { text: 'Updating…', stale: false };
    const s = Math.floor((Date.now() - lastGood) / 1000);
    if (s > 90) return { text: `No update for ${Math.round(s / 60)} min`, stale: true };
    return { text: `Updated ${s}s ago`, stale: false };
  };

  function teamNums(obj) {
    const f = document.createDocumentFragment();
    TEAMS.forEach((t, i) => {
      if (i) f.appendChild(document.createTextNode(' '));
      const s = document.createElement('span');
      s.className = `proto-n proto-${t}`;
      s.textContent = `${SHORT[t]} ${obj[t]}`;
      f.appendChild(s);
    });
    return f;
  }

  function item(label, body, explain) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'proto-item';
    b.title = explain;
    const l = document.createElement('span');
    l.className = 'proto-label';
    l.textContent = label;
    b.appendChild(l);
    b.appendChild(body);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = b.closest('.proto-box');
      const ex = box && box.querySelector('.proto-explain');
      if (!ex) return;
      const same = ex.dataset.for === label && !ex.hidden;
      ex.hidden = same;
      ex.dataset.for = label;
      ex.textContent = explain;
    });
    return b;
  }

  function build() {
    const type = currentType();
    const s = summary(type);
    const box = document.createElement('div');
    box.className = `proto-box proto-${mode}`;
    const list = document.createElement('div');
    list.className = 'proto-list';
    if (s) {
      const riBody = document.createElement('span');
      riBody.appendChild(teamNums(s.ri));
      if (s.soon !== Infinity) {
        const c = document.createElement('span');
        c.className = 'proto-soon';
        c.textContent = ` · next ${riClock(s.soon)}`;
        riBody.appendChild(c);
      }
      list.appendChild(item('RI', riBody,
        'Righteous Indignation: objectives each team took in the last 5 minutes. Their guards take no damage until it runs out. "next" is the first one to open up.'));
      const fb = document.createElement('span');
      if (s.fight) fb.appendChild(teamNums(s.fight));
      else fb.textContent = 'counting…';
      list.appendChild(item(s.fight ? `Fights ${s.fight.mins}m` : 'Fights', fb,
        'Kills plus deaths of each team on this map since we started reading it (up to 10 min). The API gives no player positions: a high number means that team is fighting here, not how many players it has.'));
      list.appendChild(item('T3', teamNums(s.t3),
        'Objectives each team has fully upgraded (tier 3) on this map.'));
    }
    const a = ago();
    const t = document.createElement('time');
    t.className = 'proto-ago' + (a.stale ? ' is-stale' : '');
    if (lastGood) t.dateTime = new Date(lastGood).toISOString();
    t.textContent = a.text;
    t.title = 'When this page last got a good answer from the game\'s API. It asks every 30 s.';
    box.appendChild(list);
    box.appendChild(t);
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
    const soon = document.querySelector('.proto-soon');
    if (soon) {
      const s = summary(tab);
      if (s && s.soon !== Infinity) soon.textContent = ` · next ${riClock(s.soon)}`;
      else soon.remove();
    }
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
