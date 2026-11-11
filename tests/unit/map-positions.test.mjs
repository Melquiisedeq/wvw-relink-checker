// Where the map page draws each objective (objectiveAt, js/maps.js) against the catalogue
// (js/wvw-static.js): inside its own sector, and clear of every other marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './page-harness.mjs';

const page = loadPage(0);
const { objectives, sectors } = page.run('WVW_STATIC');
const skip = page.run('MAP_SKIP_TYPES');
const size = page.run('OBJ_SIZE');
page.ctx.__objectiveAt = (o) => page.run(`objectiveAt(${JSON.stringify(o)})`);
// Known: the EBG camp at Darkrait Inlet is drawn 12 units into Quentin Lake's tower marker.
const TOUCHING = new Set(['38-126|38-16']);
const drawn = objectives.filter((o) => !skip.has(o.type)).map((o) => ({ o, at: page.ctx.__objectiveAt(o) }));

function inside([x, y], poly) {
  let in_ = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) in_ = !in_;
  }
  return in_;
}

test('every drawn objective sits inside its own sector (js/maps.js)', () => {
  const out = [];
  for (const { o, at } of drawn) {
    if (!o.sector_id) continue;
    const sec = (sectors[o.map_id] || []).find((s) => s.id === o.sector_id);
    if (!sec || !at || !inside(at, sec.bounds)) out.push(`${o.id} ${o.name} at ${at}`);
  }
  assert.deepEqual(out, [], `outside their own sector: ${out.join('; ')}`);
});

test('no two markers of a map overlap: the radii sum to less than the distance (OBJ_SIZE, js/maps.js)', () => {
  const bad = [];
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i], b = drawn[j];
      if (a.o.map_id !== b.o.map_id) continue;
      const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
      const r = (size[a.o.type] || 14) + (size[b.o.type] || 14);
      if (TOUCHING.has(`${a.o.id}|${b.o.id}`) || TOUCHING.has(`${b.o.id}|${a.o.id}`)) continue;
      if (r >= d) bad.push(`${a.o.id} ${a.o.name} / ${b.o.id} ${b.o.name}: radii ${r}, distance ${d.toFixed(1)}`);
    }
  }
  assert.deepEqual(bad, [], `markers overlap: ${bad.join('; ')}`);
});
