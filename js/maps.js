'use strict';
// ---------------------------------------------------------------------
// Tier maps
// The interactive WvW maps: sector polygons, objective markers, tiers,
// claim emblems, tactics, pan and zoom. The big one.
//
// Three sources, all of them already paid for or tiny. Ownership comes
// free with the match object the standings fetch anyway. Position and
// name come from the objective catalogue, which never changes: one
// request per session. The map itself is the sector polygons the API
// publishes for every WvW map, in the same coordinate space as the
// objectives - which is why the markers land where they belong by
// construction rather than by fitting. There is no terrain image
// because ArenaNet publishes no tiles for WvW; see the top of
// css/maps.css.
// ---------------------------------------------------------------------
// Tab order, left to right. Red last by request - it reads as the
// heaviest of the three and sitting second made it fight EBG for the
// eye, so it anchors the far end instead.
const MAP_PANEL_ORDER = ['Center', 'BlueHome', 'GreenHome', 'RedHome'];
const MAP_PANEL_NAME = Object.freeze({
  Center: 'Eternal Battlegrounds',
  RedHome: 'Red Borderlands',
  BlueHome: 'Blue Borderlands',
  GreenHome: 'Green Borderlands',
});
const MAP_TAB_NAME = Object.freeze({
  Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL',
});
// Spawns never change hands, so they are only clutter on a map whose
// whole job is showing what changed.
const MAP_SKIP_TYPES = new Set(['Spawn']);
// Drawn biggest first: a camp painted over a keep would hide it, and the
// smaller thing is the one that has to stay on top.
const OBJ_DRAW_ORDER = ['Castle', 'Keep', 'Tower', 'Mercenary', 'Camp', 'Ruins'];
// Marker radius in map units - the map is a few thousand across, and
// markers scale by the inverse of the zoom, so this is also their size
// on screen at the default view. Type is already carried by the glyph,
// so these only have to keep a hierarchy rather than spell one out. The
// closest two objectives on any map are 261 units apart, so 118 at the
// top leaves every pair clear.
const OBJ_SIZE = Object.freeze({
  Castle: 118, Keep: 110, Tower: 100, Camp: 92, Mercenary: 92, Ruins: 80,
});
// How hard markers follow the zoom. 1 holds them at a fixed size on
// screen, so they shrink against the terrain the further in you go; 0
// pins them to the ground outright. 0.2 is near enough to pinned that
// every notch of the wheel visibly grows them, which the earlier 0.45
// did not - it worked out to 9% a notch and read as no change at all.
const MARKER_FOLLOW = 0.2;
// With markers that nearly follow the ground, the old 8.3x ceiling would
// have ended with a castle the size of a dinner plate. 4.5x is as far in
// as the terrain has detail to show anyway.
const MAX_ZOOM = 4.5;

// Where each picture sits in continent coordinates. Solved, not
// eyeballed: the renders carry the sector borders and the API gives the
// same borders as polygons, so the transform is whatever makes the two
// coincide.
//
// `edge` is how wide our own border is drawn, in map units, and it has
// to cover the one already printed into the picture or you see both.
// EBG printed a 23-unit line against the borderlands' 5, so EBG's was
// painted out of the image rather than widening ours - which is why all
// four can share the same 14.
const MAP_IMAGE = Object.freeze({
  38: { src: 'assets/map-ebg.webp', x: 8846.4, y: 12710.9, w: 3308.0, h: 3293.5, edge: 14 },
  1099: { src: 'assets/map-rbl.webp', x: 9133.8, y: 8866.1, w: 3228.6, h: 3245.6, edge: 14 },
  96: { src: 'assets/map-bbl.webp', x: 12718.3, y: 10865.3, w: 2660.6, h: 3623.1, edge: 14 },
  95: { src: 'assets/map-gbl.webp', x: 5534.1, y: 11493.7, w: 2693.0, h: 3638.3, edge: 14 },
});

// The game's own icons off the wiki, copied into assets/icons: a disc in
// the team colour with the structure knocked out of it. Only Keep and
// Tower are published in all four colours, so Camp, Castle and Ruins
// were rebuilt - the coloured variants are the same image with only RGB
// changed, alpha pixel-identical, so grey -> team was learned from the
// Keep and Tower pairs. Replaying it on those reproduces them to within
// 0.2/255.
const MARKER_ICON = Object.freeze({
  Castle: 'Event_Castle', Keep: 'Event_Keep', Tower: 'Event_Tower',
  Camp: 'Event_Camp', Ruins: 'Event_Ruins',
  // The three mercenary camps in Eternal Battlegrounds. The wiki has
  // the crossed poleaxes the game uses for them, but as a bare glyph -
  // no disc, and in no team colour - so the disc was rebuilt from the
  // camp icon (radially averaged, its own glyph skipped) and the axes
  // knocked into it, the way every other marker is drawn.
  Mercenary: 'Event_Mercenary',
});
let plotSerial = 0;
// How often open tier maps re-read their own match. The API serves match
// data with max-age=1, so the only lag is ours. One match is 82KB, and
// this runs only while the maps are open and the window has focus.
const MAP_REFRESH_MS = 30 * 1000;
let mapPollTimer = null;

function markerIcon(type, owner) {
  const base = MARKER_ICON[type];
  if (!base) return null;
  const c = String(owner || '').toLowerCase();
  return `assets/icons/${base}${COLORS.includes(c) ? `_${c}` : ''}.png`;
}

// The twenty guild tactics, likewise copied in. Serving every picture
// ourselves is what lets img-src stay 'self': no third-party host ever
// learns who is looking at a map.
const TACTIC_ICONS = new Set([
  '1202661','1202663','1202664','1202665','1202666','1202667','1202668',
  '1202669','1202670','1202671','1202672','1202673','1202674','1202675',
  '1202676','1202677','1202678','1202679','1202680','1202681',
]);
const RENDER_FILE_RE = /^https:\/\/render\.guildwars2\.com\/file\/[0-9A-F]+\/(\d+)\.png$/;

function tacticIcon(url) {
  const m = RENDER_FILE_RE.exec(String(url || ''));
  if (!m || !TACTIC_ICONS.has(m[1])) return null;
  return `assets/icons/${m[1]}.webp`;
}

let objectiveCatalogue = null;
let upgradeCatalogue = null;
let tacticCatalogue = null;
const sectorCache = new Map();

async function getObjectiveCatalogue() {
  if (objectiveCatalogue) return objectiveCatalogue;
  const list = await fetchJsonCached(`${API_BASE}/wvw/objectives?ids=all`);
  const byId = new Map();
  for (const o of Array.isArray(list) ? list : []) byId.set(o.id, o);
  objectiveCatalogue = byId;
  return byId;
}

// This used to pick out only the upgrade lines the live objectives use,
// which meant waiting for the objective catalogue first. Asking for all
// of them turns out to return the same bytes - 48 lines, 137KB either
// way - so the filtering bought nothing and cost a round trip, and this
// can now run alongside everything else instead of behind it.
async function getUpgradeCatalogue() {
  if (upgradeCatalogue) return upgradeCatalogue;
  const byId = new Map();
  try {
    const list = await fetchJsonCached(`${API_BASE}/wvw/upgrades?ids=all`);
    for (const u of Array.isArray(list) ? list : []) byId.set(u.id, u);
  } catch { /* upgrades are a nicety; the map works without them */ }
  upgradeCatalogue = byId;
  return byId;
}

// The guild tactics installed on an objective, which is a different
// thing from the upgrade tier: tiers are bought by yaks and arrive on
// their own, tactics are chosen by whoever claimed it. Fetched for the
// whole match in one request rather than per objective.
async function getTacticCatalogue(ids) {
  if (!tacticCatalogue) tacticCatalogue = new Map();
  const want = [...new Set(ids)].filter((id) => !tacticCatalogue.has(id));
  if (!want.length) return tacticCatalogue;
  try {
    const list = await fetchJsonCached(`${API_BASE}/guild/upgrades?ids=${want.map(encodeURIComponent).join(',')}`);
    for (const u of Array.isArray(list) ? list : []) tacticCatalogue.set(u.id, u);
  } catch { /* tactics are a nicety; the panel reads fine without them */ }
  return tacticCatalogue;
}

// The API hands out a foreground id per guild and a catalogue of what
// each id draws, as layered PNGs. Only the first layer is used - it
// carries the design and the rest turn to mush at this size - painted
// white, so one image per guild is enough. The catalogue is one request
// per session.
let emblemForegrounds = null;
let emblemForegroundsPromise = null;

function getEmblemForegrounds() {
  if (emblemForegrounds) return Promise.resolve(emblemForegrounds);
  if (!emblemForegroundsPromise) {
    emblemForegroundsPromise = fetchJsonCached(`${API_BASE}/emblem/foregrounds?ids=all`)
      .then((list) => {
        const byId = new Map();
        for (const f of Array.isArray(list) ? list : []) byId.set(f.id, f);
        emblemForegrounds = byId;
        return byId;
      })
      // Dropped rather than remembered as an empty catalogue: kept, it
      // would blank every claim emblem until the page was reloaded,
      // because the answer is only ever fetched once. Clearing the
      // promise is what lets the next claimed objective ask again.
      .catch(() => { emblemForegroundsPromise = null; return new Map(); });
  }
  return emblemForegroundsPromise;
}

function emblemSrc(info, foregrounds) {
  const fg = info && info.emblem && info.emblem.foreground;
  const entry = fg && foregrounds.get(fg.id);
  return (entry && Array.isArray(entry.layers) && entry.layers[0]) || null;
}

// Everything the emblem needs, resolved together. Keyed by guild and
// kept as the promise rather than the answer, so six markers held by the
// same guild share one request instead of racing to make six.
const emblemPending = new Map();

function guildEmblem(guildId) {
  if (!emblemPending.has(guildId)) {
    const pending = Promise.all([getGuildInfo(guildId), getEmblemForegrounds()])
      .then(([info, fgs]) => ({ info, src: emblemSrc(info, fgs) }));
    // Dropped again if it fails, so the next marker can retry. Keeping a
    // rejected promise here blanked that guild's emblem for the rest of
    // the session over one bad request.
    pending.catch(() => emblemPending.delete(guildId));
    emblemPending.set(guildId, pending);
  }
  return emblemPending.get(guildId);
}

async function getSectors(mapId) {
  if (sectorCache.has(mapId)) return sectorCache.get(mapId);
  const list = await fetchJsonCached(
    `${API_BASE}/continents/2/floors/3/regions/7/maps/${encodeURIComponent(mapId)}/sectors?ids=all`);
  const arr = (Array.isArray(list) ? list : []).filter((x) => Array.isArray(x.bounds));
  // Only a real answer is worth keeping, the same rule getGuildInfo
  // follows. Empty means the response came back malformed, and cached it
  // would blank that map for the rest of the session: the popover would
  // report no objective data for the tier, with nothing left to retry
  // against short of a reload.
  if (arr.length) sectorCache.set(mapId, arr);
  return arr;
}

function flippedAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

// Tier is not in the objective data - it is how many upgrade steps the
// yaks delivered have paid for. yaks_required is the cost of that step
// alone and not the running total, which is why this sums as it goes: a
// tower's steps cost 15, 20 and 35, so fortified is 70 yaks, not 35.
// yaks_delivered stops at exactly the sum of a line's three steps on all
// four lines - 60, 70, 100 and 190 - which only holds if they add up.
function objectiveTier(meta, ob) {
  const line = upgradeCatalogue && upgradeCatalogue.get(meta.upgrade_id);
  if (!line || !Array.isArray(line.tiers)) return null;
  const yaks = Number(ob.yaks_delivered || 0);
  let spent = 0;
  let reached = 0;
  for (const t of line.tiers) {
    spent += Number(t.yaks_required || 0);
    if (yaks >= spent) reached += 1;
  }
  return { tier: reached, tiers: line.tiers };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

// The guild's own emblem on a shield in the corner, which is what a
// claimed objective shows in game. The shield is drawn straight away and
// the emblem drops in when the lookup lands, so a slow guild call never
// holds up the map.
function claimBadge(r, guildId, whiteFilter) {
  const w = r * 0.86, h = w * 1.1;
  const x = r * 0.66 - w / 2, y = -r * 0.74 - h / 2;
  const g = svgEl('g', { class: 'wvw-claim' });
  g.appendChild(svgEl('path', {
    class: 'claim-shield',
    d: `M${x} ${y}h${w}v${h * 0.52}`
      + `q0 ${h * 0.32} ${-w / 2} ${h * 0.48}`
      + `q${-w / 2} ${-h * 0.16} ${-w / 2} ${-h * 0.48}z`,
  }));
  guildEmblem(guildId).then(({ src }) => {
    if (!src) return;
    const im = svgEl('image', {
      class: 'claim-emblem', href: src, filter: `url(#${whiteFilter})`,
      x: x + w * 0.16, y: y + h * 0.08, width: w * 0.68, height: w * 0.68,
    });
    im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', src);
    g.appendChild(im);
  }).catch(() => { /* the shield alone still says claimed */ });
  return g;
}

// One shield per tier along the bottom of the marker, none at tier 0. A
// digit in a badge was only legible once you were already looking at it.
// The marker also gets a tier-N class, which lights the ring around it -
// that is the part you can read across a whole map.
function tierShields(r, tier) {
  const g = svgEl('g', { class: 'wvw-tierpips' });
  if (!tier) return g;
  const w = r * 0.5, h = w * 1.2, gap = r * 0.09;
  let x = -(tier * w + (tier - 1) * gap) / 2;
  const y = r * 0.68;
  for (let i = 0; i < tier; i++) {
    g.appendChild(svgEl('path', {
      d: `M${x} ${y}h${w}v${h * 0.5}`
        + `q0 ${h * 0.32} ${-w / 2} ${h * 0.5}`
        + `q${-w / 2} ${-h * 0.18} ${-w / 2} ${-h * 0.5}z`,
    }));
    x += w + gap;
  }
  return g;
}

// One map, drawn. Returns the wrapper plus a redraw hook, so the caller
// can swap maps without rebuilding the whole popover.
function buildMapStage(match, mapData, sectors, catalogue, onSelect) {
  // Who holds what, and only that. Empty means nobody knows yet, which
  // is a real state and not an error: during the relink of 26/09 the API
  // published the new match with the objective lists blank while the
  // maps came up - tier 4 blank on all four, tier 2 blank on three and
  // full on the Green borderland - and a tier that has not turned over
  // yet is still serving last week's owners.
  const ownersOf = (data, isLive) => {
    const byId = new Map();
    if (isLive) for (const ob of (data && data.objectives) || []) byId.set(ob.id, ob);
    return byId;
  };
  let owners = ownersOf(mapData, matchIsLive(match));

  // The markers come from the catalogue, never from the match. The
  // catalogue knows what exists on a map and where it sits, and neither
  // of those changes at a relink - so the map is always whole, and
  // ownership is the only thing that has to wait. An objective with no
  // owner is drawn Neutral, which is the game's own uncoloured icon.
  const blank = (meta) => ({ id: meta.id, type: meta.type, owner: 'Neutral' });
  const pts = [];
  for (const meta of catalogue.values()) {
    if (meta.map_id !== mapData.id) continue;
    if (MAP_SKIP_TYPES.has(meta.type)) continue;
    // label_coord, not coord. coord is the thing's position in the world - a
    // lord's room, a gate - while label_coord is where the game itself
    // writes the objective. Measured against the centre of each one's own
    // sector, label_coord is 42 units off on average and coord is 138.
    const at = meta.label_coord || meta.coord;
    if (!at) continue;
    pts.push({ ob: owners.get(meta.id) || blank(meta), meta, x: at[0], y: at[1] });
  }

  // The viewBox comes from the sector outlines, so the drawing defines
  // its own frame and nothing has to agree about map bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sec of sectors) {
    for (const [x, y] of sec.bounds) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const pad = (maxX - minX) * 0.02;
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const fullW = maxX - minX, fullH = maxY - minY;

  const wrap = document.createElement('div');
  wrap.className = 'wvw-plot-wrap';

  const svg = svgEl('svg', {
    class: 'wvw-plot',
    viewBox: `${minX} ${minY} ${fullW} ${fullH}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  // Emblem layers ship in the game's neutral base red, and a guild's
  // colours arrive as dye ids rather than RGB. Turning those into the real
  // colours means implementing ArenaNet's own colour-shift maths in an
  // order they do not publish, and an emblem in the wrong colours is worse
  // than one in none. These stay monochrome: the shape is what identifies
  // the guild, and white is legible on every team colour. Not a
  // placeholder.
  const whiteFilter = `wvw-white-${++plotSerial}`;
  const defs = svgEl('defs', {});
  const filt = svgEl('filter', {
    id: whiteFilter, 'color-interpolation-filters': 'sRGB',
    x: '0', y: '0', width: '100%', height: '100%',
  });
  filt.appendChild(svgEl('feColorMatrix', {
    type: 'matrix',
    values: '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0',
  }));
  defs.appendChild(filt);
  svg.appendChild(defs);

  // Which side holds the objective inside each sector, so the ground
  // itself can be tinted.
  const ownerBySector = new Map();
  for (const p of pts) {
    if (p.meta.sector_id) ownerBySector.set(p.meta.sector_id, p.ob.owner);
  }
  // Terrain first, everything else on top of it.
  const picture = MAP_IMAGE[mapData.id];
  if (picture) {
    const img = svgEl('image', {
      href: picture.src, x: picture.x, y: picture.y,
      width: picture.w, height: picture.h,
      preserveAspectRatio: 'none',
    });
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', picture.src);
    svg.appendChild(img);
  }

  // Three passes, not one. A single pass lets the next sector's fill paint
  // over the previous one's outline, which is exactly where the border
  // matters most - the line between two owners. The dark pass also buries
  // the pale sector borders printed into the wiki render.
  const land = svgEl('g', { class: picture ? 'over-terrain' : '' });
  const edgeW = (picture && picture.edge) || 14;
  const tinted = [];
  const fills = svgEl('g', { class: 'wvw-fills' });
  const unders = svgEl('g', { class: 'wvw-edges-under', 'stroke-width': edgeW });
  const overs = svgEl('g', { class: 'wvw-edges', 'stroke-width': edgeW * 0.44 });
  for (const sec of sectors) {
    const owner = String(ownerBySector.get(sec.id) || 'neutral').toLowerCase();
    const points = sec.bounds.map(([x, y]) => `${x},${y}`).join(' ');
    const poly = svgEl('polygon', { class: `wvw-sector own-${owner}`, points });
    const t = svgEl('title', {});
    t.textContent = sec.name || '';
    poly.appendChild(t);
    fills.appendChild(poly);
    unders.appendChild(svgEl('polygon', { points }));
    const edge = svgEl('polygon', { class: `own-${owner}`, points });
    overs.appendChild(edge);
    tinted.push({ id: sec.id, fill: poly, edge });
  }
  land.appendChild(fills);
  land.appendChild(unders);
  land.appendChild(overs);
  svg.appendChild(land);

  const markers = svgEl('g', {});
  pts.sort((a, b) => OBJ_DRAW_ORDER.indexOf(a.ob.type) - OBJ_DRAW_ORDER.indexOf(b.ob.type));
  const nodes = [];

  // Everything about a marker that can change while you are looking at it,
  // in one function, so a live update runs the same code as the first
  // draw. The listeners live on the group itself, so emptying it is safe,
  // and the selected class is carried across.
  const paintMarker = (g, p) => {
    const r = OBJ_SIZE[p.ob.type] || 14;
    const owner = String(p.ob.owner || 'neutral').toLowerCase();
    const tierInfo = objectiveTier(p.meta, p.ob);
    const tier = tierInfo ? tierInfo.tier : 0;
    const selected = g.classList.contains('is-selected') ? ' is-selected' : '';
    g.setAttribute('class', `wvw-marker own-${owner} tier-${tier}${selected}`);
    while (g.firstChild) g.removeChild(g.firstChild);

    // A generous invisible disc under every marker, so the whole badge
    // is a target rather than just the glyph.
    g.appendChild(svgEl('circle', { class: 'hit', r: Math.max(r * 1.5, 30) }));
    // The tier ring, under the icon so the icon stays crisp over it,
    // and a dark casing under that so the colour reads on any team
    // disc. Both invisible at tier 0 - an unupgraded objective should
    // look plain.
    g.appendChild(svgEl('circle', { class: 'halo-case', r: r * 1.02 }));
    g.appendChild(svgEl('circle', { class: 'halo', r: r * 1.02 }));
    // The icon already carries the team colour, so nothing is drawn
    // under it - a disc behind would only show as a second ring.
    const markerSrc = markerIcon(p.ob.type, p.ob.owner);
    if (markerSrc) {
      const icon = svgEl('image', {
        class: 'pip', href: markerSrc,
        x: -r, y: -r, width: r * 2, height: r * 2,
      });
      icon.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', markerSrc);
      g.appendChild(icon);
    }
    if (p.ob.claimed_by) g.appendChild(claimBadge(r, p.ob.claimed_by, whiteFilter));
    g.appendChild(svgEl('circle', { class: 'ring', r: r * 1.04 }));
    // Last, so the shields sit over the claim ring instead of being
    // crossed by it.
    if (tier) g.appendChild(tierShields(r, tier));
    const tip = svgEl('title', {});
    tip.textContent = `${p.meta.name || p.ob.id} · ${p.ob.owner}`
      + (tierInfo ? ` · T${tierInfo.tier}` : '');
    g.appendChild(tip);
  };

  for (const p of pts) {
    const g = svgEl('g', {
      transform: `translate(${p.x} ${p.y})`,
      tabindex: '0',
      role: 'button',
    });
    paintMarker(g, p);

    const pick = (e) => {
      e.stopPropagation();
      for (const n of nodes) n.classList.remove('is-selected');
      g.classList.add('is-selected');
      onSelect(p, match);
    };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); }
    });
    markers.appendChild(g);
    nodes.push(g);
  }
  svg.appendChild(markers);
  wrap.appendChild(svg);

  // ---- zoom and pan -------------------------------------------------
  // The viewBox is the camera. Markers are pinned to the ground but
  // damped - see MARKER_FOLLOW - so zooming in grows them along with the
  // terrain instead of leaving them floating above it at a fixed size.
  const view = { x: minX, y: minY, w: fullW, h: fullH };

  const apply = () => {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const k = Math.pow(view.w / fullW, MARKER_FOLLOW);
    for (let i = 0; i < nodes.length; i++) {
      const p = pts[i];
      nodes[i].setAttribute('transform', `translate(${p.x} ${p.y}) scale(${k})`);
    }
  };

  const clamp = () => {
    view.w = Math.min(fullW, Math.max(fullW / MAX_ZOOM, view.w));
    view.h = view.w * (fullH / fullW);
    view.x = Math.min(minX + fullW - view.w, Math.max(minX, view.x));
    view.y = Math.min(minY + fullH - view.h, Math.max(minY, view.y));
  };

  const zoomBy = (factor, cx, cy) => {
    const before = view.w;
    view.w = before * factor;
    clamp();
    // Keep the point under the cursor where it was.
    const scale = view.w / before;
    view.x = cx - (cx - view.x) * scale;
    view.y = cy - (cy - view.y) * scale;
    clamp();
    apply();
  };

  const atEvent = (e) => {
    const r = svg.getBoundingClientRect();
    return {
      x: view.x + ((e.clientX - r.left) / r.width) * view.w,
      y: view.y + ((e.clientY - r.top) / r.height) * view.h,
    };
  };

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const at = atEvent(e);
    zoomBy(e.deltaY > 0 ? 1.18 : 1 / 1.18, at.x, at.y);
  }, { passive: false });

  let dragging = null;
  wrap.addEventListener('pointerdown', (e) => {
    // The zoom controls live inside the map, and starting a drag here
    // calls setPointerCapture on the wrapper - which retargets the
    // click to the wrapper and means the button's own click listener
    // never runs. That is why the buttons did nothing.
    if (e.target.closest('.wvw-marker, .wvw-zoom')) return;
    dragging = { at: atEvent(e), x: view.x, y: view.y };
    wrap.classList.add('is-panning');
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width) * view.w;
    const dy = ((e.clientY - r.top) / r.height) * view.h;
    // Keep the point grabbed at pointerdown under the cursor. This read
    // the live view.x, which it had just moved itself, so every frame
    // after the first was measured against the wrong origin and the map
    // crept away from the pointer.
    view.x = dragging.at.x - dx;
    view.y = dragging.at.y - dy;
    clamp();
    apply();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = null;
    wrap.classList.remove('is-panning');
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  const zoomBox = document.createElement('div');
  zoomBox.className = 'wvw-zoom';
  for (const [label, factor] of [['+', 1 / 1.35], ['\u2212', 1.35]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', factor < 1 ? 'Zoom in' : 'Zoom out');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      zoomBy(factor, view.x + view.w / 2, view.y + view.h / 2);
    });
    zoomBox.appendChild(b);
  }
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = '\u2302';
  reset.setAttribute('aria-label', 'Reset the view');
  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    view.x = minX; view.y = minY; view.w = fullW; view.h = fullH;
    apply();
  });
  zoomBox.appendChild(reset);
  wrap.appendChild(zoomBox);

  // Says which half is missing. The map is drawn and readable either
  // way, so this is not an error state - it is the colours being late.
  const waiting = document.createElement('p');
  waiting.className = 'wvw-waiting';
  waiting.textContent = "Reset - ArenaNet hasn't published this map yet";
  waiting.hidden = owners.size > 0;
  wrap.appendChild(waiting);

  // Repaint from fresher objective data without rebuilding anything.
  // Nothing about the drawing moves - same nodes, same viewBox - so the
  // zoom you set and the objective you had selected both survive, which
  // is the whole point of doing it this way instead of re-rendering.
  wrap.applyLive = (freshMapData, isLive) => {
    owners = ownersOf(freshMapData, isLive);
    for (let i = 0; i < pts.length; i++) {
      // Back to Neutral when an owner goes away, rather than keeping the
      // last one seen: the API has handed back a blank list mid-relink,
      // and holding on to what was there would leave a map claiming an
      // ownership nobody is asserting any more.
      pts[i].ob = owners.get(pts[i].meta.id) || blank(pts[i].meta);
      paintMarker(nodes[i], pts[i]);
    }
    waiting.hidden = owners.size > 0;
    const ownerNow = new Map();
    for (const p of pts) {
      if (p.meta.sector_id) ownerNow.set(p.meta.sector_id, p.ob.owner);
    }
    for (const t of tinted) {
      const owner = String(ownerNow.get(t.id) || 'neutral').toLowerCase();
      t.fill.setAttribute('class', `wvw-sector own-${owner}`);
      t.edge.setAttribute('class', `own-${owner}`);
    }
    apply();   // markers were repainted, so their zoom scale is gone
  };

  return wrap;
}

// ---- the detail panel ------------------------------------------------
function row(dl, label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'wvw-row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (value instanceof Node) dd.appendChild(value); else dd.textContent = value;
  wrap.appendChild(dt);
  wrap.appendChild(dd);
  dl.appendChild(wrap);
}

function renderObjectiveDetail(panel, p, match) {
  panel.textContent = '';
  const { ob, meta } = p;

  const name = document.createElement('div');
  name.className = 'wvw-detail-name';
  // The same shields the map draws, in the same tier colour, rather than
  // a number in a bronze lozenge that matched nothing. Whatever you
  // learned to read on the map reads here too.
  const tierInfo = objectiveTier(meta, ob);
  if (tierInfo && tierInfo.tier > 0) {
    const chip = document.createElement('span');
    chip.className = `wvw-tierchip tierchip-${tierInfo.tier}`;
    chip.title = `Upgrade tier ${tierInfo.tier} of ${tierInfo.tiers.length}`;
    for (let i = 0; i < tierInfo.tier; i++) chip.appendChild(document.createElement('i'));
    name.appendChild(chip);
  }
  name.appendChild(document.createTextNode(meta.name || ob.id));
  panel.appendChild(name);

  const type = document.createElement('div');
  type.className = 'wvw-detail-type';
  type.textContent = ob.type;
  panel.appendChild(type);

  const dl = document.createElement('dl');
  const ownerColor = String(ob.owner || '').toLowerCase();
  const teamId = COLORS.includes(ownerColor)
    ? matchTeamId(match, ownerColor) : null;
  row(dl, 'Owned by', teamId ? getTeamName(teamId) : (ob.owner || 'Nobody'));
  const ago = flippedAgo(ob.last_flipped);
  if (ago) row(dl, 'Last flipped', ago);
  if (tierInfo) row(dl, 'Tier', String(tierInfo.tier));
  row(dl, 'Points per tick', String(ob.points_tick ?? 0));
  row(dl, 'Points for capture', String(ob.points_capture ?? 0));
  row(dl, 'Yaks delivered', String(ob.yaks_delivered ?? 0));

  const claimCell = document.createElement('span');
  if (ob.claimed_by) {
    claimCell.className = 'wvw-claimed';
    claimCell.textContent = 'loading…';
    // Straight through the same cache the guild checker uses, so a guild
    // that holds three objectives is still only looked up once.
    guildEmblem(ob.claimed_by).then(({ info, src }) => {
      claimCell.textContent = '';
      if (src) {
        const img = document.createElement('img');
        img.className = 'wvw-emblem';
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        claimCell.appendChild(img);
      }
      claimCell.appendChild(document.createTextNode(`[${info.tag}] ${info.name}`));
    }).catch(() => { claimCell.textContent = 'a guild'; });
  } else {
    claimCell.textContent = 'unclaimed';
  }
  row(dl, 'Claimed by', claimCell);
  panel.appendChild(dl);

  // Tactics, not the automatic tier upgrades. The tier's walls and
  // guards follow from the yak count and are already summed up by the
  // number above; what is worth listing is what the holding guild chose
  // to install, because that is what an attack has to plan around.
  const tactics = Array.isArray(ob.guild_upgrades) ? ob.guild_upgrades : [];
  if (tactics.length) {
    const heading = document.createElement('div');
    heading.className = 'wvw-upgrade-tier';
    heading.textContent = `Tactics (${tactics.length})`;
    panel.appendChild(heading);
    const ul = document.createElement('ul');
    ul.className = 'wvw-upgrades';
    for (const id of tactics) {
      const t = tacticCatalogue && tacticCatalogue.get(id);
      const li = document.createElement('li');
      const src = tacticIcon(t && t.icon);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        li.appendChild(img);
      }
      li.appendChild(document.createTextNode(t ? t.name : `Upgrade ${id}`));
      if (t && t.description) li.title = t.description;
      ul.appendChild(li);
    }
    panel.appendChild(ul);
  }
}

// ---- the popover -----------------------------------------------------
function renderTierMapsContent(popover, match, regionName, tierNum, catalogue, sectorsByType, triggerEl) {
  popover.textContent = '';

  const header = document.createElement('div');
  header.className = 'info-popover-header';
  const title = document.createElement('span');
  title.textContent = `${regionName} Tier ${tierNum} · objectives`;
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'info-popover-header-actions';
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'info-popover-expand';
  expandBtn.innerHTML = EXPAND_ICON_COLLAPSE;
  expandBtn.setAttribute('aria-label', 'Shrink back to normal size');
  expandBtn.title = expandBtn.getAttribute('aria-label');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverExpanded(popover, triggerEl,
      !popover.classList.contains('info-popover--expanded'));
  });
  actions.appendChild(expandBtn);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-popover-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closePopover);
  actions.appendChild(closeBtn);
  header.appendChild(actions);
  popover.appendChild(header);

  const byType = new Map((match.maps || []).map((m) => [m.type, m]));
  const available = MAP_PANEL_ORDER.filter((t) => byType.has(t) && sectorsByType.has(t));
  if (!available.length) {
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = 'No objective data for this tier right now.';
    popover.appendChild(msg);
    return;
  }

  const tabs = document.createElement('div');
  tabs.className = 'wvw-tabs';
  popover.appendChild(tabs);

  const stage = document.createElement('div');
  stage.className = 'wvw-stage';
  popover.appendChild(stage);

  const detail = document.createElement('div');
  detail.className = 'wvw-detail';

  const emptyDetail = () => {
    detail.textContent = '';
    const p = document.createElement('p');
    p.className = 'wvw-detail-empty';
    p.textContent = 'Pick an objective on the map to see who holds it, how long they have, and what it has been upgraded with.';
    detail.appendChild(p);
  };

  let current = null;
  let plotWrap = null;
  const show = (type) => {
    if (current === type) return;
    current = type;
    for (const b of tabs.children) b.classList.toggle('is-active', b.dataset.type === type);
    stage.textContent = '';
    const plot = buildMapStage(match, byType.get(type), sectorsByType.get(type),
      catalogue, (p, m) => renderObjectiveDetail(detail, p, m));
    plotWrap = plot;
    if (plot) stage.appendChild(plot);
    stage.appendChild(detail);
    emptyDetail();
  };

  // The maps keep themselves current while they are open. The standings
  // refresh cannot do it for them: it rebuilds the whole board, and the
  // button this popover is anchored to goes with it - which is why that
  // refresh used to just close the popover out from under you. So this
  // asks for one match, not all nine, and repaints in place.
  clearInterval(mapPollTimer);
  mapPollTimer = setInterval(async () => {
    if (activeTrigger !== triggerEl) { clearInterval(mapPollTimer); return; }
    // Same rule as the animations: no work for a window nobody is
    // looking at. It catches up on the next tick after you come back.
    if (document.visibilityState === 'hidden' || !document.hasFocus()) return;
    let fresh;
    try {
      fresh = await fetchJson(`${API_BASE}/wvw/matches?id=${encodeURIComponent(match.id)}`);
    } catch { return; }
    if (activeTrigger !== triggerEl || !fresh || !Array.isArray(fresh.maps)) return;
    for (const m of fresh.maps) if (byType.has(m.type)) byType.set(m.type, m);
    const now = byType.get(current);
    // Asked of the answer that just arrived, not of the match this
    // popover opened with: a tier turns over while the maps are open,
    // and it has also been seen turning back.
    if (plotWrap && plotWrap.applyLive && now) plotWrap.applyLive(now, matchIsLive(fresh));
  }, MAP_REFRESH_MS);

  for (const type of available) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wvw-tab';
    b.dataset.type = type;
    b.textContent = MAP_TAB_NAME[type] || type;
    b.title = MAP_PANEL_NAME[type] || type;
    b.addEventListener('click', (e) => { e.stopPropagation(); show(type); });
    tabs.appendChild(b);
  }
  show(available[0]);
}

async function toggleTierMaps(match, regionName, tierNum, triggerEl) {
  const popover = openPopover(triggerEl, `${regionName} Tier ${tierNum} maps`, (el) => {
    const loading = document.createElement('p');
    loading.className = 'hint';
    loading.style.margin = '0';
    loading.innerHTML = '<span class="spinner"></span>Loading maps…';
    el.appendChild(loading);
  }, 'info-popover--maps');
  if (!popover) return; // it was already open; openPopover just closed it

  // Four maps and a detail panel do not fit in an anchored popover, so
  // this one opens the way the guild list looks once expanded.
  setPopoverExpanded(popover, triggerEl, true);

  let catalogue, sectorsByType;
  try {
    // All of it at once. These ran one after another - objectives, upgrades,
    // tactics, then four map outlines - which is four round trips on an API
    // where the trip costs about a second and the payload barely matters.
    // Only upgrades ever needed another's answer, and that is gone.
    const wanted = (match.maps || []).filter((m) => MAP_PANEL_ORDER.includes(m.type));
    const tacticIds = [];
    for (const m of match.maps || []) {
      for (const ob of m.objectives || []) {
        if (Array.isArray(ob.guild_upgrades)) tacticIds.push(...ob.guild_upgrades);
      }
    }
    const [cat, sets] = await Promise.all([
      getObjectiveCatalogue(),
      Promise.all(wanted.map((m) => getSectors(m.id).catch(() => []))),
      getUpgradeCatalogue(),
      tacticIds.length ? getTacticCatalogue(tacticIds) : null,
      // Not needed to draw the map, but every claimed objective wants it
      // a moment later, so it rides along rather than costing its own
      // wait once the markers are already on screen.
      getEmblemForegrounds(),
    ]);
    catalogue = cat;
    sectorsByType = new Map();
    wanted.forEach((m, i) => { if (sets[i].length) sectorsByType.set(m.type, sets[i]); });
  } catch {
    if (activeTrigger !== triggerEl) return;
    popover.textContent = '';
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = "Couldn't load the map data right now.";
    popover.appendChild(msg);
    return;
  }

  if (activeTrigger !== triggerEl) return; // closed while loading
  renderTierMapsContent(popover, match, regionName, tierNum, catalogue, sectorsByType, triggerEl);
}

function buildTierMapButton(match, regionName, tierNum) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn tier-map-btn';
  btn.setAttribute('aria-label', `Show the objective maps for ${regionName} Tier ${tierNum}`);
  btn.title = `Objective maps · ${regionName} Tier ${tierNum}`;
  markPopoverTrigger(btn);
  // The folded map. A miniature of the territory was tried and came out
  // worse - four coloured patches at this size read as a badge, not a map.
  // The dot does the same job as the zigzag: the zigzag says the sheet is
  // folded, the dot says something is drawn on it. Both are silhouette,
  // which is all that survives at 17px.
  //
  // Word first, glyph after, matching the "Skirmish 1.2k [chart]" line in
  // the server cards.
  btn.innerHTML = '<span class="tier-map-label">Maps</span>' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6.5 9 3l6 3.5 6-3.5v14.5l-6 3.5-6-3.5-6 3.5Z"/>' +
    '<path d="M9 3v14.5M15 6.5V21"/>' +
    '</g>' +
    '<circle cx="12" cy="9.2" r="1.6" fill="currentColor"/>' +
    '</svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTierMaps(match, regionName, tierNum, btn);
  });
  return btn;
}
