// /api/latest, the second read of the matches: bodies of the live matches as JSON with
// only the running skirmish, the finished ones at /api/history, read once per version.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { historyOf, liveOf } from './support/gw2.mjs';
import { load, recordedJson } from './support/steps.mjs';
import { recording } from './support/recordings.mjs';
import { keptBody, lastResets, loadNow, readCopy, scoreOf } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

const LATEST = /\/api\/latest(\/summary)?$/;
const HISTORY = /\/api\/history\/([12])\?v=(\d+)$/;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + m.scores[c], 0);
// The score of `id` once the page has painted what /api/latest gave. The page
// holds its paint LATEST_WAIT_MS (1.2 s, js/api.js) for the read; an answer that
// comes later is kept for the next paint (a machine under load got there: 1 run
// in 20). The rule under test is "the newest body wins", not the 1.2 s (the hung
// test times that), so a missed window asks the page for its next paint.
async function settledScore(page, id, want) {
  let score;
  for (let i = 0; i < 4; i++) {
    score = await scoreOf(page, id);
    if (score === want) break;
    await loadNow(page);
    await page.waitForTimeout(1500);
  }
  return score;
}

// Answers /api/latest (and its summary, which is the same list without the bodies) with `body`.
async function serve(page, body) {
  const state = { reads: 0 };
  await page.route(LATEST, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const summary = route.request().url().endsWith('/summary');
    if (!summary) state.reads++;
    const out = summary
      ? Object.fromEntries(body.matches.filter(m => typeof m.id === 'string').map(m => [m.id, { start: m.start, score: m.score, at: m.at, by: m.by }]))
      : body;
    await route.fulfill({ status: 200, body: JSON.stringify(out), headers: JSON_HEADERS });
  });
  return state;
}

// Answers /api/history with `answer(region, v)`: a value, a text as it is, or null for the Worker's 404.
// Returns the versions asked, as "region?v".
async function serveHistory(page, wvw, answer) {
  const asked = [];
  wvw.allowLog(/\/api\/history\//);
  await page.route(HISTORY, async route => {
    const [, region, v] = HISTORY.exec(route.request().url());
    asked.push(region + '?' + v);
    const out = answer(region, Number(v));
    await route.fulfill(out ? { status: 200, body: typeof out === 'string' ? out : JSON.stringify(out), headers: JSON_HEADERS }
      : { status: 404, body: 'not found', headers: { ...JSON_HEADERS, 'Content-Type': 'text/plain' } });
  });
  return asked;
}

const all = recordedJson('https://api.guildwars2.com/v2/wvw/matches?ids=all');
const [a, b] = all.filter(m => Date.parse(m.end_time) > recording().recordedAt).slice(0, 2);
const bump = (m, n) => ({ ...m, scores: { ...m.scores, red: m.scores.red + n } });
// An entry of /api/latest, with the whole body (every skirmish in it, so no history is asked).
const entry = (id, m, start = Date.parse(m.start_time)) => ({ id, start, score: sum(m), at: 0, by: 'check-page', v: 2, body: m });
// A body padded with whitespace past LATEST_BODY_MAX (256 KiB, js/api.js), still valid JSON.
const PAD = 300 * 1024;

// Format 2 as the readers send it: the live part, its finished skirmishes apart.
test.describe('the history of format 2', () => {
  const live = (m, n = 5000) => entry(m.id, liveOf(bump(m, n)));
  // What the Worker answers for the region at version v: the matches whose history is that long.
  const version = (region, v, ms = [a, b]) => {
    const held = ms.filter(x => x.id[0] === region && historyOf(x).length === v);
    return held.length ? { v, start: Date.parse(held[0].start_time), matches: Object.fromEntries(held.map(x => [x.id, historyOf(x)])) } : null;
  };
  const versionOf = m => m.id[0] + '?' + historyOf(m).length;
  const kept = keptBody;
  const read = readCopy;

  test('is read once per version, not at every read of /api/latest, and joined in front', async ({ page, wvw }) => {
    let matches = [live(a), live(b)];
    await serve(page, { get matches() { return matches; }, at: 0 });
    let world = [a, b];
    const asked = await serveHistory(page, wvw, (region, v) => version(region, v, world));
    await load(page, wvw);
    expect(await settledScore(page, a.id, sum(a) + 5000), `${a.id}, the newer body`).toBe(sum(a) + 5000);
    expect((await kept(page, a.id)).skirmishes, `${a.id}: its history and the running skirmish, as the game gives them`).toEqual(a.skirmishes);
    expect((await kept(page, b.id)).skirmishes, `${b.id}: the same`).toEqual(b.skirmishes);
    const versions = [...new Set([a, b].map(versionOf))].sort();
    expect([...asked].sort(), 'the history, once per version').toEqual(versions);
    for (const n of [6000, 7000, 8000]) {
      matches = [live(a, n), live(b, n)];
      await read(page);
      expect(sum(await kept(page, a.id)), `${a.id} after a read with ${n} more`).toBe(sum(a) + n);
    }
    expect([...asked].sort(), 'the history after three more reads at the same version').toEqual(versions);
    // The next skirmish: the running one finished, a new one begun. A new version, read once.
    const last = a.skirmishes.at(-1);
    const turned = { ...bump(a, 9000), skirmishes: [...a.skirmishes, { ...last, id: last.id + 1 }] };
    world = [turned];
    matches = [entry(a.id, liveOf(turned))];
    await read(page);
    await read(page);
    expect((await kept(page, a.id)).skirmishes, `${a.id}, the next version`).toEqual(turned.skirmishes);
    expect(asked.filter(x => x === versionOf(turned)), 'reads of the next version').toHaveLength(1);
  });

  test('a body whose history is not there is left out, and the version asked again a minute on', async ({ page, wvw }) => {
    await serve(page, { at: 0, matches: [live(a)] });
    let there = false;
    const asked = await serveHistory(page, wvw, (region, v) => (there ? version(region, v, [a]) : null));
    await load(page, wvw);
    expect(asked.length, 'reads of the history').toBeGreaterThan(0);
    expect(await scoreOf(page, a.id), `${a.id}, its history a 404`).toBe(sum(a));
    there = true;
    const before = asked.length;
    await read(page);
    expect(asked.length, 'the version asked again within a minute').toBe(before);
    expect(sum(await kept(page, a.id)), `${a.id}, within the minute`).toBe(sum(a));
    await wvw.skew(61 * 1000);
    await read(page);
    expect(asked.length, 'the version asked again a minute on').toBe(before + 1);
    expect(sum(await kept(page, a.id)), `${a.id}, its history there`).toBe(sum(a) + 5000);
  });

  // A copy of `m` that began at `start`, its end moved with it, the running skirmish still in it.
  const began = (m, start) => {
    const shift = start - Date.parse(m.start_time);
    return { ...liveOf(bump(m, 5000)), start_time: new Date(start).toISOString(), end_time: new Date(Date.parse(m.end_time) + shift).toISOString() };
  };

  test('a body that began before its region\'s last reset asks no history and is left out; one that began at it does', async ({ page, wvw }) => {
    const pick = region => all.find(m => m.id[0] === region && historyOf(m).length > 0);
    const [na, eu] = [pick('1'), pick('2')];
    // A whole body beside them: the one that is left out takes no other with it.
    const whole = all.find(m => ![na.id, eu.id].includes(m.id) && Date.parse(m.end_time) > recording().recordedAt);
    let ids = [];
    let starts = {};
    let rise = 0;
    await serve(page, { at: 0, get matches() { return [...ids.map(id => { const m = id === na.id ? na : eu; return entry(id, began(m, starts[id])); }), entry(whole.id, bump(whole, rise))]; } });
    const asked = await serveHistory(page, wvw, () => null);
    await load(page, wvw);
    const resets = await lastResets(page);
    expect(resets[1], 'the two regions reset at different times').not.toBe(resets[2]);
    await wvw.skew(61 * 1000);
    asked.length = 0;
    for (const [m, before] of [[na, 1], [eu, 1], [na, 0], [eu, 0]]) {
      ids = [m.id];
      rise += 1000;
      starts = { [m.id]: resets[m.id[0]] - before };
      await wvw.skew(61 * 1000);
      await read(page);
      expect(asked, `${m.id}, began ${before} ms before the reset`).toEqual(before ? [] : [m.id[0] + '?' + historyOf(m).length]);
      asked.length = 0;
      expect(await scoreOf(page, m.id), `${m.id}, its history a 404: left out`).toBe(sum(m));
      expect(sum(await kept(page, whole.id)), `${whole.id}, whole and newer at each read, beside ${m.id}`).toBe(sum(whole) + rise);
    }
  });

  test('a history that is not the version asked, or not the match\'s list, is not joined', async ({ page, wvw }) => {
    await serve(page, { at: 0, matches: [live(a)] });
    const n = historyOf(a).length;
    const right = version(a.id[0], n, [a]);
    const list = historyOf(a);
    const wrong = [
      { ...right, v: n + 1 },
      { ...right, start: right.start + 1 },
      { ...right, matches: { [a.id]: list.slice(1) } },
      { ...right, matches: { [a.id]: list.map((s, i) => ({ ...s, id: i })) } },
      { ...right, matches: { [a.id]: [...list.slice(0, -1), { ...list.at(-1), pad: ' '.repeat(PAD) }] } },
      '{not JSON',
    ];
    let i = 0;
    await serveHistory(page, wvw, () => wrong[i]);
    await load(page, wvw);
    for (i = 1; i < wrong.length; i++) {
      await wvw.skew(61 * 1000);
      await read(page);
    }
    expect(sum(await kept(page, a.id)), `${a.id} after ${wrong.length} wrong histories`).toBe(sum(a));
  });
});
