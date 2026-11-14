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
// Darkrait Inlet's camp (38-126) overlaps Quentin Lake's tower (38-16) as drawn today; moving it changes
// what is seen, a change of its own.
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

const SEARED_MAPS = [1651, 1652, 1654];
page.ctx.btoa = btoa;

test('every Seared waypoint carries the chat link of its own point of interest id (WAYPOINT_AT, js/maps.js)', () => {
  const at = page.run('WAYPOINT_AT');
  const bad = [];
  for (const key of Object.keys(at).filter((k) => SEARED_MAPS.includes(Number(k.split('-')[0])))) {
    const id = at[key][2];
    const want = `[&${Buffer.from([4, id & 255, (id >> 8) & 255, (id >> 16) & 255, (id >> 24) & 255]).toString('base64')}]`;
    const got = page.run(`waypointChat(${id})`);
    if (got !== want) bad.push(`${key}: ${got} for ${id}, wanted ${want}`);
  }
  assert.deepEqual(bad, []);
  assert.equal(page.run('WAYPOINT_AT["1652-37"][2]'), 4182);
  assert.equal(page.run('waypointChat(WAYPOINT_AT["1652-37"][2])'), '[&BFYQAAA=]');
});

test('the Seared picture sits the same way round its map on all three (MAP_IMAGE, js/maps.js)', () => {
  const img = page.run('MAP_IMAGE');
  const at = page.run('WAYPOINT_AT');
  const margins = SEARED_MAPS.map((id) => {
    const r = img[id];
    const pts = (sectors[id] || []).flatMap((s) => s.bounds);
    for (const [k, v] of Object.entries(at)) if (k.startsWith(`${id}-`)) pts.push([v[0], v[1]]);
    assert.ok(pts.length > 0, `map ${id} has points`);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - r.x, r.x + r.w - Math.max(...xs), Math.min(...ys) - r.y, r.y + r.h - Math.max(...ys)];
  });
  for (const m of margins) assert.ok(m.every((v) => v >= 0), `the picture covers its map: ${m}`);
  for (let i = 1; i < margins.length; i++) {
    margins[i].forEach((v, k) => assert.ok(Math.abs(v - margins[0][k]) < 1, `map ${SEARED_MAPS[i]} side ${k}: ${v} against ${margins[0][k]}`));
  }
});
