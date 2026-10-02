// PROTOTYPE - preview branch only, never merged. A bar at the bottom left switches
// the map corners' background, the swords colour away from the busiest map, the
// "no update" wording, and simulates an update gap.
(function () {
  const P = window.__proto = { bg: 'vidro', cold: true, text: 'b', stale: false, btn: 'e' };
  const root = document.documentElement;
  const groups = [
    ['Fundo', 'bg', [['hoje', 'Hoje'], ['pilula', '1 Pílula'], ['vidro', '3 Vidro']]],
    ['Espadas fora do mapa quente', 'cold', [[false, 'Laranja'], [true, 'Neutras']]],
    ['Texto', 'text', [['a', 'A Updated / No update'], ['b', 'B Live / Paused'], ['c', 'C Updated / Map data old']]],
    ['Botão', 'btn', [['hoje', 'Hoje: Maps'], ['a', 'A Live maps'], ['b', 'B ● Maps'], ['ab', 'A+B ● Live maps'], ['d', 'D Live maps em destaque'], ['e', 'E Live maps + mapa quente'], ['f', 'F Espadas no ícone'], ['g', 'G Maps LIVE']]],
    ['Simular', 'stale', [[false, 'Normal'], [true, 'Sem atualização 2,5 min']]],
  ];
  const bar = document.createElement('div');
  bar.className = 'proto-bar';
  // Clicks here must not reach the page's outside-click handlers, which close the maps.
  for (const t of ['pointerdown', 'mousedown', 'click', 'touchstart']) bar.addEventListener(t, (e) => e.stopPropagation());
  const title = document.createElement('b');
  title.textContent = 'Protótipo';
  bar.appendChild(title);
  // The map buttons are rebuilt with the standings: rewrite each one as it appears.
  // The busiest map of a tier, the same reading as the swords on the map tabs.
  const hotOf = (match) => {
    const r = match && matchIsLive(match) ? fightRates(match, 10 * 60 * 1000) : null;
    if (!r) return null;
    let hot = null, best = 0;
    for (const [type, n] of r.per) if (n > best) { best = n; hot = type; }
    return best >= 10 ? hot : null;
  };
  const swords = (size) => {
    const im = document.createElement('img');
    im.src = 'assets/icons/Event_Swords.webp';
    im.alt = '';
    im.width = size;
    im.height = size;
    return im;
  };
  const dress = () => {
    root.dataset.protoBtn = P.btn;
    for (const lab of document.querySelectorAll('.tier-map-label')) {
      const want = ['hoje', 'b', 'g'].includes(P.btn) ? 'Maps' : 'Live maps';
      if (lab.textContent !== want) lab.textContent = want;
      const btn = lab.closest('.tier-map-btn');
      const hot = ['e', 'f'].includes(P.btn) ? hotOf(btn.__match) : null;
      const key = P.btn + ':' + hot;
      if (btn.dataset.proto === key) continue;
      btn.dataset.proto = key;
      for (const old of btn.querySelectorAll('.proto-dot,.proto-hot,.proto-tag,.proto-badge')) old.remove();
      if (P.btn === 'b' || P.btn === 'ab') {
        const dot = document.createElement('span');
        dot.className = 'proto-dot';
        btn.insertBefore(dot, btn.firstChild);
      }
      if (P.btn === 'g') {
        const tag = document.createElement('span');
        tag.className = 'proto-tag';
        tag.textContent = 'live';
        lab.after(tag);
      }
      if (P.btn === 'e' && hot) {
        const h = document.createElement('span');
        h.className = 'proto-hot';
        h.append(swords(12), MAP_TAB_NAME[hot] || hot);
        btn.appendChild(h);
      }
      if (P.btn === 'f' && hot) {
        const b = document.createElement('span');
        b.className = 'proto-badge';
        b.appendChild(swords(11));
        btn.appendChild(b);
      }
      btn.classList.toggle('proto-has-badge', P.btn === 'f' && !!hot);
    }
  };
  // A first visit has no fight history of its own; the shared one is what the
  // maps read on opening. Read at load here, so the button can say it at once.
  if (typeof getKillSheet === 'function') getKillSheet().then(() => {
    for (const b of document.querySelectorAll('.tier-map-btn')) delete b.dataset.proto;
    dress();
  }).catch(() => {});
  new MutationObserver(() => dress()).observe(document.documentElement, { childList: true, subtree: true });
  const paint = () => {
    root.dataset.protoBg = P.bg;
    dress();
    for (const b of bar.querySelectorAll('button[data-k]')) {
      b.setAttribute('aria-pressed', String(String(P[b.dataset.k]) === b.dataset.v));
    }
  };
  for (const [label, key, opts] of groups) {
    const g = document.createElement('span');
    g.className = 'g';
    g.append(label + ':');
    for (const [v, text] of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.k = key;
      b.dataset.v = String(v);
      b.textContent = text;
      b.addEventListener('click', () => { P[key] = v; paint(); });
      g.appendChild(b);
    }
    bar.appendChild(g);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'x';
  x.textContent = 'esconder';
  x.addEventListener('click', () => bar.remove());
  bar.appendChild(x);
  const mount = () => { document.body.appendChild(bar); paint(); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
