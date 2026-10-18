// "What happened" over a tier's map: the rules straight on missedMatchOffered, then
// the block a visitor sees after a gap.
//
// Rules: bodies made from a kept match, no clicks, no clock, nothing that can be
// late. A summary only for a real gap (the score still past 6 min, the page
// reading through it, something changed) or a return to the tab; never for the
// same body, one behind, a new week, a laptop asleep, a short stop, or a gap the
// page did not read through; Ruins and Spawn never chips; kills never below 0;
// gone after 10 min; a fault in the hook never costs keepNewestMatch its body.
//
// Block: a match answered with the same body for over 6 min while the page kept
// asking, then a body with two objectives taken (one on the open map, one on
// another) and a known number of kills more.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { phone, load, firstTier, openMap, later, keptMatch, iso } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

// ---- The rules ------------------------------------------------------------

// Runs in the page, one group of checks per test; every group puts back what it
// touched. Returns what failed, each as a line.
function rulesInPage(group) {
  const out = [];
  const check = (name, cond, info) => { if (!cond) out.push(name + (info ? ' (' + info + ')' : '')); };
  const id = [...newestMatches.keys()].find(k => matchIsLive(newestMatches.get(k).match));
  if (!id) return ['no live match kept'];
  const keptWas = newestMatches.get(id);
  const M0 = JSON.parse(JSON.stringify(keptWas.match));
  const clone = () => JSON.parse(JSON.stringify(M0));
  const reset = () => { missedNotes.clear(); missedLastOffer.clear(); missedRings.clear(); missedReturn = null; };
  const now = Date.now(), MIN = 60000;
  const flipTo = o => ({ Red: 'Blue', Blue: 'Green', Green: 'Red' }[o] || 'Red');
  const after = base => {
    const m = base ? JSON.parse(JSON.stringify(base)) : clone(); const taken = [];
    for (const map of m.maps) {
      const o = map.objectives.find(x => ['Camp', 'Tower', 'Keep'].includes(x.type));
      if (o && taken.length < 2) { o.owner = flipTo(o.owner); o.last_flipped = new Date(now).toISOString(); taken.push(o.id); }
    }
    m.maps[0].kills.red += 30; m.maps[0].kills.blue += 20; m.scores.red += 10;
    return { m, taken };
  };
  const offer = (body, keptAt, lastOfferAgo) => {
    reset();
    if (lastOfferAgo != null) missedLastOffer.set(id, now - lastOfferAgo);
    missedMatchOffered(body, { match: clone(), at: now - keptAt });
    return missedNotes.get(id) || null;
  };
  const sample = (at, body) => ({ at, n: fightTotals(body) });
  const sheetWas = killSheet;
  const logWas = localStorage.getItem(FIGHT_KEY);
  localStorage.removeItem(FIGHT_KEY);
  let n;
  try {
    if (group === 'when') {
      const a = after();
      n = offer(a.m, 7 * MIN, 30000);
      check('a real gap raised no summary', !!n && n.kind === 'pause');
      check('a real gap listed other changes', !!n && n.changes.length === 2 && a.taken.every(x => n.changes.some(c => c.id === x)), n && n.changes.map(c => c.id).join(','));
      check('a real gap counted kills other than after minus before', !!n && n.kills === 50, n && n.kills);
      check('the same body again raised a summary', !offer(clone(), 7 * MIN, 30000));
      const behind = clone(); behind.scores.red -= 50; behind.maps[0].kills.red += 5;
      check('a body behind raised a summary', !offer(behind, 7 * MIN, 30000));
      const week = after().m; week.start_time = new Date(Date.parse(M0.start_time) + 7 * 86400000).toISOString();
      check('a new week raised a summary', !offer(week, 7 * MIN, 30000));
      check('a laptop asleep raised a summary', !offer(after().m, 20 * MIN, 5 * MIN));
      check('a 3-minute stop raised a summary', !offer(after().m, 3 * MIN, 30000));
      check('a gap with no read in it raised a summary', !offer(after().m, 7 * MIN, 8 * MIN));
    }
    if (group === 'return') {
      reset();
      missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
      const r = after(); missedMatchOffered(r.m, { match: r.m, at: now });
      n = missedNotes.get(id);
      check('a return with changes raised no "return" summary', !!n && n.kind === 'return' && n.kills === 50, n && n.kind);
      // A newer body while the summary is up: it follows the newest data.
      n.open = true; n.wideOpen = false;
      const newer = JSON.parse(JSON.stringify(r.m)); newer.maps[0].kills.red += 9; newer.scores.red += 20;
      missedMatchOffered(newer, { match: r.m, at: now });
      n = missedNotes.get(id);
      check('a newer body did not update the summary', !!n && n.kills === 59 && n.perMap.reduce((t, m) => t + m.n, 0) === 59, n && n.kills);
      check('a newer body reset what the reader had opened', !!n && n.open === true && n.wideOpen === false);
      reset();
      missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
      missedMatchOffered(clone(), { match: clone(), at: now });
      check('a return with nothing changed raised a summary', !missedNotes.get(id));
    }
    if (group === 'period') {
      // The period is the data's, not the page's clock: the history says when
      // the total of the body before first appeared.
      const stalled = clone(); stalled.maps[0].kills.red += 200;
      const longer = after(stalled);
      longer.m.maps[1].kills.green += 7;
      // Its flips happened 3 min ago, before the history's row of the new total.
      for (const map of longer.m.maps) for (const o of map.objectives) if (longer.taken.includes(o.id)) o.last_flipped = new Date(now - 3 * MIN).toISOString();
      killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 36 * MIN, stalled)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('a body stopped 36 min did not start the period at the stop', !!n && n.since === now - 36 * MIN && n.sure === true, n && (n.since - now) / MIN);
      check('the period ended before the page read the new body', !!n && n.end >= n.since && n.end <= Date.now() + 1000);
      const diff = missedKillTotal(longer.m) - missedKillTotal(stalled);
      check('the kills per map did not add up to the difference of the bodies', !!n && n.kills === diff
        && n.perMap.reduce((t, m) => t + m.n, 0) === diff, n && JSON.stringify(n.perMap));
      check('only the maps that moved were listed', !!n && n.perMap.length === 2
        && n.perMap.some(m => m.type === stalled.maps[0].type && m.n === 50)
        && n.perMap.some(m => m.type === stalled.maps[1].type && m.n === 7), n && JSON.stringify(n.perMap));
      // The new body already in the history: the period ends where it first showed.
      killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 36 * MIN, stalled), sample(now - 2 * MIN, longer.m)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('the period did not end where the new total first showed', !!n && n.sure && n.end === now - 2 * MIN, n && (n.end - now) / MIN);
      // A return: the body before is older than the tab's hiding.
      killSheet = new Map([[id, [sample(now - 50 * MIN, M0), sample(now - 30 * MIN, stalled)]]]);
      reset();
      missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, JSON.parse(JSON.stringify(stalled))]]) };
      missedMatchOffered(longer.m, { match: longer.m, at: now });
      n = missedNotes.get(id);
      check('a return started at the hiding, not where the body before began', !!n && n.kind === 'return' && n.since === now - 30 * MIN && n.sure === true, n && (n.since - now) / MIN);
      // A normal return: a row a minute, none with the total of the body before
      // (the page read another copy 30 s after the row under it).
      const lower = clone(); lower.maps[0].kills.red += 190;
      const upper = clone(); upper.maps[0].kills.red += 210;
      killSheet = new Map([[id, [sample(now - 9 * MIN, lower), sample(now - 8 * MIN, lower), sample(now - 7 * MIN + 30000, upper), sample(now - 6 * MIN, upper)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('a normal return between rows was not sure', !!n && n.sure === true && n.since === now - 7 * MIN, n && (n.since - now) / MIN + ' ' + n.sure);
      // The oldest reading there is only bounds the start: not sure, never later.
      killSheet = new Map([[id, [sample(now - 36 * MIN, stalled)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('an oldest reading was taken as the exact start', !!n && n.sure === false && n.since === now - 36 * MIN, n && (n.since - now) / MIN + ' ' + n.sure);
      // No reading of that total at all: the page's own time, not sure.
      killSheet = new Map();
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('no history claimed a sure start', !!n && n.sure === false && n.since <= now - 7 * MIN, n && n.sure);
    }
    if (group === 'flips') {
      // A listed flip older than the period the history proves: the period
      // starts at that flip (its last_flipped is exact), a future one is skipped.
      const old = after();
      const flips = k => [].concat(...old.m.maps.map(x => x.objectives)).find(x => x.id === old.taken[k]);
      flips(0).last_flipped = new Date(now - 120 * MIN).toISOString();
      flips(1).last_flipped = new Date(now + 60 * MIN).toISOString();
      killSheet = new Map();
      reset();
      missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
      missedMatchOffered(old.m, { match: old.m, at: now });
      n = missedNotes.get(id);
      check('a return with a flip 2 h old started later than the flip', !!n && n.kind === 'return' && n.since === now - 120 * MIN && n.sure === true, n && (n.since - now) / MIN + ' ' + n.sure);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(old.m, { match: clone(), at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('a pause with a flip 2 h old started later than the flip', !!n && n.kind === 'pause' && n.since === now - 120 * MIN && n.sure === true, n && (n.since - now) / MIN + ' ' + n.sure);
      // The history showed the new total 5 min ago, a listed flip came 1 min ago:
      // the period must reach the flip.
      flips(0).last_flipped = new Date(now - MIN).toISOString();
      killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 5 * MIN, old.m)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(old.m, { match: clone(), at: now - 7 * MIN });
      n = missedNotes.get(id);
      check('the period ended before a flip it lists', !!n && n.end >= now - MIN, n && (n.end - now) / MIN);
    }
    if (group === 'chips') {
      const ruins = clone();
      for (const map of ruins.maps) for (const o of map.objectives) if (o.type === 'Ruins' || o.type === 'Spawn') o.owner = flipTo(o.owner);
      ruins.maps[0].kills.red += 5;
      n = offer(ruins, 7 * MIN, 30000);
      check('Ruins or Spawn became chips', !!n && n.changes.length === 0, n && n.changes.map(c => c.type).join(','));
      const fewer = after().m; fewer.maps[0].kills.red -= 500;
      n = offer(fewer, 7 * MIN, 30000);
      check('kills went below 0', !n || n.kills >= 0, n && n.kills);
      n = offer(after().m, 7 * MIN, 30000);
      if (n) n.until = Date.now() - 1;
      check('a summary outlived its 10 minutes', missedNoteFor(id) === null);
    }
    if (group === 'hook') {
      reset();
      const real = missedMatchOffered;
      missedMatchOffered = () => { throw new Error('on purpose'); };
      const up = clone(); up.scores.red += 100;
      let got, threw = false;
      try { got = keepNewestMatch(up); } catch { threw = true; }
      missedMatchOffered = real;
      check('a fault in the hook cost keepNewestMatch its body', !threw && got === up && newestMatches.get(id).match === up);
    }
  } catch (e) {
    out.push('threw: ' + e.message);
  } finally {
    newestMatches.set(id, keptWas);
    killSheet = sheetWas;
    if (logWas === null) localStorage.removeItem(FIGHT_KEY); else localStorage.setItem(FIGHT_KEY, logWas);
    reset();
  }
  return out;
}

test.describe('what happened rules', () => {
  const groups = {
    when: 'a summary only for a real gap; never for the same body, one behind, a new week, a laptop asleep, a short stop, a gap with no read',
    return: 'a return to the tab raises one when something changed, follows a newer body, none when nothing changed',
    period: "the period is the data's: the history says when the total before first appeared",
    flips: 'a listed flip older than the period starts it, a future one is skipped, a recent one is reached',
    chips: 'Ruins and Spawn never chips; kills never below 0; gone after 10 min',
    hook: 'a fault in the hook never costs keepNewestMatch its body',
  };
  for (const [group, name] of Object.entries(groups)) {
    test(name, async ({ page, wvw }) => {
      await load(page, wvw);
      const failed = await page.evaluate(rulesInPage, group);
      expect(failed, failed.join('; ')).toEqual([]);
    });
  }
});

// ---- The block ------------------------------------------------------------

const TABS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const NAMES = { Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL' };
const OWNERS = ['Red', 'Blue', 'Green'];
const BLOCK = '.info-popover .wvw-missed:not(.is-leaving)';
const LIT = ".info-popover .wvw-marker.is-lit";

// The map opened on the first tier, the same body served for 400 s (the block
// must not show), then the body with an objective taken here and one on another
// map, and kills on both, served and pulled 31 s on.
async function gap(page, wvw) {
  await load(page, wvw);
  const tier = await firstTier(page);
  const before = await keptMatch(page, tier.id);
  const same = await answer(page, tier.url, before);
  await openMap(page, wvw, tier.button);
  for (let i = 0; i < 4; i++) await later(page, wvw, 100000);
  const here = await page.locator('.info-popover .wvw-tab.is-active').getAttribute('data-type');
  const other = before.maps.map(m => m.type).find(type => type !== here);
  const takeable = m => (m?.objectives || []).filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && OWNERS.includes(o.owner) && /^\d+-\d+$/.test(o.id));
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-marker')].map(g => g.dataset.obj));
  const a = takeable(before.maps.find(m => m.type === here)).find(o => drawn.includes(o.id));
  const b = takeable(before.maps.find(m => m.type === other))[0];
  expect(a && b, `a camp, tower or keep held on ${here} and ${other} to take`).toBeTruthy();
  const after = JSON.parse(JSON.stringify(before));
  const KILLS = { [here]: ['red', 37], [other]: ['blue', 15] };
  const taken = new Date(Date.parse(before.start_time) + 60000).toISOString().replace('.000Z', 'Z');
  for (const m of after.maps) {
    for (const o of m.objectives) if (o.id === a.id || o.id === b.id) { o.owner = OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3]; o.last_flipped = taken; }
    const k = KILLS[m.type];
    if (k) { m.kills[k[0]] += k[1]; after.kills[k[0]] += k[1]; }
  }
  after.scores.red += 1;
  const serve = async body => { same.off(); return answer(page, tier.url, body); };
  return { tier, before, after, same, here, other, a, b, KILLS, serve, afterTheGap: () => serve(after).then(() => later(page, wvw, 31000)) };
}

test.describe('what happened', () => {
  test('the same body for 400 s shows no block', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const same = await answer(page, tier.url, await keptMatch(page, tier.id));
    await openMap(page, wvw, tier.button);
    for (let i = 0; i < 4; i++) await later(page, wvw, 100000);
    expect(same.reads, 'pulls of the map over 400 s').toBeGreaterThanOrEqual(4);
    await expect(page.locator(BLOCK), 'the block showed while the body stood still').toHaveCount(0);
  });

  test('after the gap: both chips, the open map first, exactly those kills; markers, dots, chips', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const seen = await page.evaluate(sel => { const b = document.querySelector(sel);
      return { title: b.querySelector('.wvw-missed-title').textContent, open: b.classList.contains('is-open'),
        top: b === b.parentElement.firstElementChild && b.parentElement.classList.contains('wvw-side'),
        chips: [...b.querySelectorAll('.wvw-chip[data-obj]')].map(c => c.dataset.obj + ' ' + c.dataset.map),
        kills: [...b.querySelectorAll('.wvw-missed-row')].map(r => r.querySelector('.wvw-missed-mapname').textContent + ' ' + (r.querySelector('.wvw-missed-kills')?.textContent || '')),
        rings: [...document.querySelectorAll('.info-popover .wvw-marker')].filter(g => g.querySelector('.wvw-ring')).map(g => g.dataset.obj),
        dots: [...document.querySelectorAll('.info-popover .wvw-tab')].filter(t => t.querySelector('.wvw-tab-dot')).map(t => t.dataset.type) }; }, BLOCK);
    const want = {
      chips: [[g.a.id, g.here], [g.b.id, g.other]].sort((x, y) => TABS.indexOf(x[1]) - TABS.indexOf(y[1])).map(([id, ty]) => `${id} ${ty}`),
      kills: TABS.filter(ty => g.KILLS[ty]).map(ty => `${NAMES[ty]} ${g.KILLS[ty][1]} kills`), rings: [g.a.id], dots: [],
    };
    expect(seen.title, 'the block title').toMatch(/^What happened · \S/);
    expect(seen.open && seen.top, `the block reads "${seen.title}", open ${seen.open}, at the top of the column ${seen.top}`).toBe(true);
    for (const k of Object.keys(want)) expect(seen[k], k).toEqual(want[k]);
  });

  test('over the tabs, and the board standing still beside it', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const read = () => page.evaluate(sel => { const p = document.querySelector('.info-popover');
      return Math.round(p.querySelector('.wvw-board').getBoundingClientRect().height) + '/' + Math.round(p.getBoundingClientRect().height)
        + '/' + (document.querySelector(sel).getBoundingClientRect().bottom <= p.querySelector('.wvw-subtabs').getBoundingClientRect().top); }, BLOCK);
    const one = await read();
    await page.waitForTimeout(2500);
    const two = await read();
    expect(one.endsWith('/true'), `the board/popover/block-over-tabs read ${one}`).toBe(true);
    expect(two, 'the board stood still').toBe(one);
  });

  test('a chip of this map lights its objective alone; one of another opens that map with it selected', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const lit = () => page.evaluate(sel => [...document.querySelectorAll(sel)].map(m => m.dataset.obj).join(), LIT);
    await page.locator(`.info-popover .wvw-chip[data-obj="${g.a.id}"]`).hover();
    await expect.poll(lit, { message: `${g.a.id} alone lit while its chip is pointed at` }).toBe(g.a.id);
    await page.mouse.move(1, 1);
    await expect.poll(lit, { message: 'nothing lit once the chip is left' }).toBe('');
    await page.locator(`.info-popover .wvw-chip[data-obj="${g.b.id}"]`).click();
    await expect(page.locator(`.info-popover .wvw-tab[data-type="${g.other}"].is-active`)).toBeAttached();
    await expect(page.locator(`.info-popover .wvw-marker.is-selected[data-obj="${g.b.id}"]`)).toBeAttached();
    await expect(page.locator('.info-popover .wvw-subtab.is-active')).toHaveAttribute('data-pane', 'objective');
    await expect(page.locator('.info-popover .wvw-tab-dot'), "the other map's dot goes").toHaveCount(0);
    await expect.poll(lit, { message: `${g.b.id} lit a moment after its chip is pressed` }).toBe(g.b.id);
  });

  test('on a phone it starts folded, the title alone, and opens on a tap', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    await phone(page, 360);
    const block = page.locator(BLOCK);
    await expect(block).not.toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip')).toHaveCount(0);
    expect(await block.textContent(), 'folded, with the kills total in its title').not.toMatch(/\bkills\b/);
    await block.locator('.wvw-missed-head').click();
    await expect(block).toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip[data-obj]')).toHaveCount(2);
  });

  test('ten minutes on it is gone, and a body with only the score up raises none', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
    await expect(page.locator(BLOCK), 'the block ten minutes after the data came back').toHaveCount(0);
    const scoreOnly = JSON.parse(JSON.stringify(g.after));
    scoreOnly.scores.red += 1;
    await g.serve(scoreOnly);
    await later(page, wvw, 31000);
    await page.waitForTimeout(1500); // the popover's one-second repaint
    expect(await page.evaluate(([sel, id]) => !!document.querySelector(sel) || missedNotes.has(id), [BLOCK, g.tier.id]),
      'a body with only the score up raised the block').toBe(false);
  });
});

// ---- The block, other shapes ------------------------------------------------
// The same gap as above, made of what the test says: `flips` objectives taken
// on the open map (the first one from nobody when `fromNeutral`), `kills` more
// kills on it. The flips are stamped 60 s after the match began, or 31 s from now with
// `stampNow` (the page then sees them as just made); `noHistory` clears the kept readings
// of the old total before the new body is served.
async function scene(page, wvw, { flips = 1, kills = 0, fromNeutral = false, stampNow = false, noHistory = false }) {
  await load(page, wvw);
  const tier = await firstTier(page);
  const before = await keptMatch(page, tier.id);
  await openMap(page, wvw, tier.button);
  const here = await page.locator('.info-popover .wvw-tab.is-active').getAttribute('data-type');
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-marker')].map(g => g.dataset.obj));
  const held = (before.maps.find(m => m.type === here).objectives)
    .filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && OWNERS.includes(o.owner) && /^\d+-\d+$/.test(o.id) && drawn.includes(o.id));
  expect(held.length, `objectives held and drawn on ${here}`).toBeGreaterThanOrEqual(flips);
  const taken = held.slice(0, flips).map(o => o.id);
  if (fromNeutral) for (const o of before.maps.find(m => m.type === here).objectives) if (o.id === taken[0]) o.owner = 'Neutral';
  const same = await answer(page, tier.url, before);
  for (let i = 0; i < 4; i++) await later(page, wvw, 100000);
  const after = JSON.parse(JSON.stringify(before));
  const at = stampNow ? iso(await wvw.now() + 31000) : iso(Date.parse(before.start_time) + 60000);
  const map = after.maps.find(m => m.type === here);
  for (const o of map.objectives) if (taken.includes(o.id)) {
    o.owner = fromNeutral && o.id === taken[0] ? 'Red' : OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3];
    o.last_flipped = at;
  }
  if (kills) { map.kills.red += kills; after.kills.red += kills; }
  after.scores.red += 1;
  same.off();
  // No reading of the old total kept: the period's start can only be bounded.
  if (noHistory) await page.evaluate(() => { localStorage.removeItem(FIGHT_KEY); killSheet = null; });
  await answer(page, tier.url, after);
  await later(page, wvw, 31000);
  await expect(page.locator(BLOCK)).toBeAttached();
  return { here, taken, tier };
}

test.describe('what happened, other shapes', () => {
  const kills = page => page.locator(`${BLOCK} .wvw-missed-kills`);

  test('objectives taken and no kills: the block shows the chip and no kills line', async ({ page, wvw }) => {
    const s = await scene(page, wvw, { flips: 1 });
    await expect(page.locator(`${BLOCK} .wvw-chip[data-obj="${s.taken[0]}"]`)).toBeAttached();
    await expect(kills(page)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count`)).toHaveText('1');
    await expect(page.locator(`${BLOCK} .wvw-missed-count`)).toHaveAttribute('aria-label', '1 objective changed hands');
  });

  test('one kill and nothing taken: the block says "1 kill", singular', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 0, kills: 1 });
    await expect(kills(page)).toHaveCount(1);
    await expect(kills(page)).toHaveText('1 kill');
    await expect(kills(page)).toHaveAttribute('aria-label', /^1 kill on /);
    await expect(page.locator(`${BLOCK} .wvw-chip`)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count`)).toHaveCount(0);
  });

  test('two kills: "2 kills", plural', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 2 });
    await expect(kills(page)).toHaveText('2 kills');
    await expect(kills(page)).toHaveAttribute('aria-label', /^2 kills on /);
  });

  for (const [flips, shown, more] of [[4, 4, 0], [5, 4, 1], [6, 4, 2]]) {
    test(`${flips} objectives taken on one map: ${shown} chips${more ? `, a +${more} button` : ', no button'}`, async ({ page, wvw }) => {
      await scene(page, wvw, { flips });
      await expect(page.locator(`${BLOCK} .wvw-chip[data-obj]`)).toHaveCount(shown);
      const button = page.locator(`${BLOCK} .wvw-chip-more`);
      if (!more) { await expect(button).toHaveCount(0); return; }
      await expect(button).toHaveText(`+${more}`);
      await expect(button).toHaveAttribute('aria-label', new RegExp(`^Show ${more} more on `));
      await button.click();
      await expect(page.locator(`${BLOCK} .wvw-chip[data-obj]`)).toHaveCount(flips);
      await expect(button).toHaveCount(0);
    });
  }

  test('taken from nobody: the chip names Neutral as who held it', async ({ page, wvw }) => {
    const s = await scene(page, wvw, { flips: 2, fromNeutral: true });
    const chip = page.locator(`${BLOCK} .wvw-chip[data-obj="${s.taken[0]}"]`);
    await expect(chip).toHaveAttribute('title', /: taken by .+ from Neutral$/);
    await expect(chip).toHaveAttribute('aria-label', /from Neutral$/);
    await expect(page.locator(`${BLOCK} .wvw-chip[data-obj="${s.taken[1]}"]`)).not.toHaveAttribute('title', /from Neutral$/);
  });

  test('flips only just made, no reading of the old total kept: "since before HH:MM"', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 5, stampNow: true, noHistory: true });
    await expect(page.locator(`${BLOCK} .wvw-missed-time`)).toHaveText(/^since before \d{1,2}:\d{2}/);
  });

  test('flips from before the gap: the period is a range, never "since before"', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 5 });
    const time = await page.locator(`${BLOCK} .wvw-missed-time`).textContent();
    expect(time, 'the period').toMatch(/^\d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/);
  });
});
