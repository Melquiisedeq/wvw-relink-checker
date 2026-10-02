// PROTOTYPE - preview branch only, never merged. A bar at the bottom left switches
// the map corners' background, the swords colour away from the busiest map, the
// "no update" wording, and simulates an update gap.
(function () {
  const P = window.__proto = { bg: 'pilula', cold: true, text: 'b', stale: false, btn: 'hoje' };
  const root = document.documentElement;
  const groups = [
    ['Fundo', 'bg', [['hoje', 'Hoje'], ['pilula', '1 Pílula'], ['vidro', '3 Vidro']]],
    ['Espadas fora do mapa quente', 'cold', [[false, 'Laranja'], [true, 'Neutras']]],
    ['Texto', 'text', [['a', 'A Updated / No update'], ['b', 'B Live / Paused'], ['c', 'C Updated / Map data old']]],
    ['Botão', 'btn', [['hoje', 'Hoje: Maps'], ['a', 'A Live maps'], ['b', 'B ● Maps'], ['ab', 'A+B ● Live maps'], ['d', 'D Live maps em destaque']]],
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
  const dress = () => {
    root.dataset.protoBtn = P.btn;
    for (const lab of document.querySelectorAll('.tier-map-label')) {
      const want = P.btn === 'hoje' || P.btn === 'b' ? 'Maps' : 'Live maps';
      if (lab.textContent !== want) lab.textContent = want;
      const btn = lab.closest('.tier-map-btn');
      let dot = btn.querySelector('.proto-dot');
      if ((P.btn === 'b' || P.btn === 'ab') && !dot) {
        dot = document.createElement('span');
        dot.className = 'proto-dot';
        btn.insertBefore(dot, btn.firstChild);
      } else if (!(P.btn === 'b' || P.btn === 'ab') && dot) dot.remove();
    }
  };
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
