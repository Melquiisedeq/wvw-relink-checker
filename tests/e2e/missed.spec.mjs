// "What happened" over a tier's map: the rules straight on missedMatchOffered, then
// the block a visitor sees after a gap.
//
// Rules: bodies made from a kept match, no clicks, nothing that can be late; no
// clock but the page's own, held still where an absence is timed to the
// millisecond. A summary only for a real gap (no new body for over 10 min, the page
// reading through it, something changed) or a return to the tab after over
// 10 min; never for the same body, one behind, a new week, a laptop asleep, a
// stop or an absence of 10 min or less, or a gap the page did not read through;
// Ruins and Spawn never chips; kills never below 0; gone after 10 min; a fault
// in the hook never costs keepNewestMatch its body.
//
// Block: a match answered with the same body for over 10 min while the page
// kept asking, then a body with two objectives taken (one on the open map, one
// on another) and a known number of kills more.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { phone, load, firstTier, openMap, later, keptMatch, iso } from './support/steps.mjs';
import { FOCUS, MIN, hidden, missed, missedBehind, missedStopped, visible } from './support/scenarios.mjs';

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
      n = offer(a.m, 12 * MIN, 30000);
      check('a real gap raised no summary', !!n && n.kind === 'pause');
      check('a real gap listed other changes', !!n && n.changes.length === 2 && a.taken.every(x => n.changes.some(c => c.id === x)), n && n.changes.map(c => c.id).join(','));
      check('a real gap counted kills other than after minus before', !!n && n.kills === 50, n && n.kills);
      check('the same body again raised a summary', !offer(clone(), 12 * MIN, 30000));
      const behind = clone(); behind.scores.red -= 50; behind.maps[0].kills.red += 5;
      check('a body behind raised a summary', !offer(behind, 12 * MIN, 30000));
      const week = after().m; week.start_time = new Date(Date.parse(M0.start_time) + 7 * 86400000).toISOString();
      check('a new week raised a summary', !offer(week, 12 * MIN, 30000));
      check('a laptop asleep raised a summary', !offer(after().m, 20 * MIN, 5 * MIN));
      check('a 7-minute stop raised a summary', !offer(after().m, 7 * MIN, 30000));
      check('a gap with no read in it raised a summary', !offer(after().m, 12 * MIN, 13 * MIN));
    }
    if (group === 'absence') {
      // The page's clock held still, so 10 min is 10 min to the millisecond.
      const DateWas = Date;
      const hiddenWas = missedHidden;
      globalThis.Date = new Proxy(DateWas, { get: (t, p) => (p === 'now' ? () => now : Reflect.get(t, p, t)) });
      try {
        check('a stop of exactly 10 min raised a summary', !offer(after().m, 10 * MIN, 30000));
        n = offer(after().m, 10 * MIN + 1000, 30000);
        check('a stop of 10 min and 1 s raised none', !!n && n.kind === 'pause');
        const back = ms => {
          reset();
          missedHidden = { at: now - ms, bodies: new Map([[id, clone()]]) };
          document.dispatchEvent(new Event('visibilitychange'));
          return missedReturn;
        };
        check('the page is not visible, the absence cannot be tried', document.visibilityState === 'visible');
        check('a tab hidden exactly 10 min was taken as away', !back(10 * MIN));
        check('a tab hidden 10 min and 1 s was not taken as away', !!back(10 * MIN + 1000));
      } finally {
        globalThis.Date = DateWas;
        missedHidden = hiddenWas;
      }
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
      missedMatchOffered(longer.m, { match: stalled, at: now - 12 * MIN });
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
      missedMatchOffered(longer.m, { match: stalled, at: now - 12 * MIN });
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
      killSheet = new Map([[id, [sample(now - 14 * MIN, lower), sample(now - 13 * MIN, lower), sample(now - 12 * MIN + 30000, upper), sample(now - 11 * MIN, upper)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 12 * MIN });
      n = missedNotes.get(id);
      check('a normal return between rows was not sure', !!n && n.sure === true && n.since === now - 12 * MIN, n && (n.since - now) / MIN + ' ' + n.sure);
      // The oldest reading there is only bounds the start: not sure, never later.
      killSheet = new Map([[id, [sample(now - 36 * MIN, stalled)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 12 * MIN });
      n = missedNotes.get(id);
      check('an oldest reading was taken as the exact start', !!n && n.sure === false && n.since === now - 36 * MIN, n && (n.since - now) / MIN + ' ' + n.sure);
      // No reading of that total at all: the page's own time, not sure.
      killSheet = new Map();
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(longer.m, { match: stalled, at: now - 12 * MIN });
      n = missedNotes.get(id);
      check('no history claimed a sure start', !!n && n.sure === false && n.since <= now - 12 * MIN, n && n.sure);
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
      missedMatchOffered(old.m, { match: clone(), at: now - 12 * MIN });
      n = missedNotes.get(id);
      check('a pause with a flip 2 h old started later than the flip', !!n && n.kind === 'pause' && n.since === now - 120 * MIN && n.sure === true, n && (n.since - now) / MIN + ' ' + n.sure);
      // The history showed the new total 5 min ago, a listed flip came 1 min ago:
      // the period must reach the flip.
      flips(0).last_flipped = new Date(now - MIN).toISOString();
      killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 5 * MIN, old.m)]]]);
      reset();
      missedLastOffer.set(id, now - 30000);
      missedMatchOffered(old.m, { match: clone(), at: now - 12 * MIN });
      n = missedNotes.get(id);
      check('the period ended before a flip it lists', !!n && n.end >= now - MIN, n && (n.end - now) / MIN);
    }
    if (group === 'cut') {
      // Every camp, tower and keep taken, each a minute older than the next in
      // map order: the oldest come first, and only the newest 40 are listed.
      const m = clone(); const order = [];
      for (const map of m.maps) for (const o of map.objectives) if (['Camp', 'Tower', 'Keep'].includes(o.type)) { o.owner = flipTo(o.owner); order.push(o); }
      order.forEach((o, i) => { o.last_flipped = new Date(now - (order.length - i) * MIN).toISOString(); });
      m.maps[0].kills.red += 5;
      check('the state: over 40 objectives to take', order.length > 40, order.length);
      n = offer(m, 12 * MIN, 30000);
      const want = order.slice(-40).map(o => o.id);
      check('the 40 listed were not the newest, in map order', !!n && JSON.stringify(n.changes.map(c => c.id)) === JSON.stringify(want),
        n && n.changes.slice(0, 3).map(c => c.id).join(',') + ' vs ' + want.slice(0, 3).join(','));
    }
    if (group === 'chips') {
      const ruins = clone();
      for (const map of ruins.maps) for (const o of map.objectives) if (o.type === 'Ruins' || o.type === 'Spawn') o.owner = flipTo(o.owner);
      ruins.maps[0].kills.red += 5;
      n = offer(ruins, 12 * MIN, 30000);
      check('Ruins or Spawn became chips', !!n && n.changes.length === 0, n && n.changes.map(c => c.type).join(','));
      const fewer = after().m; fewer.maps[0].kills.red -= 500;
      n = offer(fewer, 12 * MIN, 30000);
      check('kills went below 0', !n || n.kills >= 0, n && n.kills);
      n = offer(after().m, 12 * MIN, 30000);
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
    absence: 'a stop or a hidden tab of 10 min or less raises none, one of over 10 min does',
    return: 'a return to the tab raises one when something changed, follows a newer body, none when nothing changed',
    period: "the period is the data's: the history says when the total before first appeared",
    flips: 'a listed flip older than the period starts it, a future one is skipped, a recent one is reached',
    cut: 'over 40 objectives taken: the newest 40 by their flip are listed',
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
// The block's title as words, without the count badges riding at its end.
const titleText = (page, sel = BLOCK) => page.evaluate(s => {
  const t = document.querySelector(`${s} .wvw-missed-title`);
  return t ? [...t.childNodes].filter(n => !(n.classList && n.classList.contains('wvw-missed-counts'))).map(n => n.textContent).join('').trim() : null;
}, sel);

// The map opened on the first tier, the same body served for 700 s (over the
// 10 min a summary needs; the block must not show), then the body with an
// objective taken here and one on another map 30 min ago, and kills on both,
// served and pulled 31 s on.
async function gap(page, wvw) {
  await load(page, wvw);
  const tier = await firstTier(page);
  const before = await keptMatch(page, tier.id);
  const same = await answer(page, tier.url, before);
  await openMap(page, wvw, tier.button);
  for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
  const here = await page.locator('.info-popover .wvw-tab.is-active').getAttribute('data-type');
  const other = before.maps.map(m => m.type).find(type => type !== here);
  const takeable = m => (m?.objectives || []).filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && OWNERS.includes(o.owner) && /^\d+-\d+$/.test(o.id));
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-marker')].map(g => g.dataset.obj));
  const a = takeable(before.maps.find(m => m.type === here)).find(o => drawn.includes(o.id));
  const b = takeable(before.maps.find(m => m.type === other))[0];
  expect(a && b, `a camp, tower or keep held on ${here} and ${other} to take`).toBeTruthy();
  const after = JSON.parse(JSON.stringify(before));
  const KILLS = { [here]: ['red', 37], [other]: ['blue', 15] };
  const taken = iso(await wvw.now() - 30 * MIN);
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
  test('the same body for 700 s shows no block', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const same = await answer(page, tier.url, await keptMatch(page, tier.id));
    await openMap(page, wvw, tier.button);
    for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
    expect(same.reads, 'pulls of the map over 700 s').toBeGreaterThanOrEqual(7);
    await expect(page.locator(BLOCK), 'the block showed while the body stood still').toHaveCount(0);
  });

  test('after the gap: both chips, the open map first, exactly those kills; markers, chips', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const seen = await page.evaluate(sel => { const b = document.querySelector(sel);
      return { open: b.classList.contains('is-open'),
        top: b === b.parentElement.firstElementChild && b.parentElement.classList.contains('wvw-side'),
        chips: [...b.querySelectorAll('.wvw-chip[data-obj]')].map(c => c.dataset.obj + ' ' + c.dataset.map),
        kills: [...b.querySelectorAll('.wvw-missed-row')].map(r => r.querySelector('.wvw-missed-mapname').textContent + ' ' + (r.querySelector('.wvw-missed-kills')?.textContent || '')),
        rings: [...document.querySelectorAll('.info-popover .wvw-marker')].filter(g => g.querySelector('.wvw-ring')).map(g => g.dataset.obj) }; }, BLOCK);
    const want = {
      chips: [[g.a.id, g.here], [g.b.id, g.other]].sort((x, y) => TABS.indexOf(x[1]) - TABS.indexOf(y[1])).map(([id, ty]) => `${id} ${ty}`),
      kills: TABS.filter(ty => g.KILLS[ty]).map(ty => `${NAMES[ty]} ${g.KILLS[ty][1]} kills`), rings: [g.a.id],
    };
    seen.title = await titleText(page);
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
    await expect.poll(lit, { message: `${g.b.id} lit a moment after its chip is pressed` }).toBe(g.b.id);
  });

  test('two badges after the title: the kills first, then the objectives, each with its icon and words', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const badges = await page.evaluate(sel => [...document.querySelectorAll(`${sel} .wvw-missed-title .wvw-missed-counts > *`)].map(b => ({
      cls: b.className, text: b.textContent, label: b.getAttribute('aria-label'),
      icon: b.querySelector('img') ? b.querySelector('img').getAttribute('src') : b.querySelector('svg') ? 'svg' : null })), BLOCK);
    const kills = g.KILLS[g.here][1] + g.KILLS[g.other][1];
    expect(badges).toEqual([
      { cls: 'wvw-missed-count is-kills', text: String(kills), label: `${kills} kills`, icon: 'assets/icons/Event_Swords.webp' },
      { cls: 'wvw-missed-count is-objectives', text: '2', label: '2 objectives changed hands', icon: 'svg' },
    ]);
    await expect(page.locator(`${BLOCK} .wvw-missed-head`), 'no tooltip on the title').not.toHaveAttribute('title', /./);
  });

  test('a chip leaves the block open; a click on an objective of the map folds it', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    const block = page.locator(BLOCK);
    await expect(block).toHaveClass(/is-open/);
    await page.locator(`.info-popover .wvw-chip[data-obj="${g.b.id}"]`).click();
    await expect(page.locator(`.info-popover .wvw-marker.is-selected[data-obj="${g.b.id}"]`)).toBeAttached();
    await expect(block, 'open after a chip').toHaveClass(/is-open/);
    const other = await page.evaluate(id => [...document.querySelectorAll('.info-popover .wvw-marker')].map(m => m.dataset.obj).find(o => o !== id), g.b.id);
    await page.locator(`.info-popover .wvw-marker[data-obj="${other}"]`).click();
    await expect(page.locator(`.info-popover .wvw-marker.is-selected[data-obj="${other}"]`)).toBeAttached();
    await expect(block, 'folded after a click on the map').not.toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip')).toHaveCount(0);
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
// kills on it. The flips are stamped 30 min ago, before the gap, or 31 s from now with
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
  for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
  const after = JSON.parse(JSON.stringify(before));
  const at = stampNow ? iso(await wvw.now() + 31000) : iso(await wvw.now() - 30 * MIN);
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
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-objectives`)).toHaveText('1');
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-objectives`)).toHaveAttribute('aria-label', '1 objective changed hands');
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-kills`)).toHaveCount(0);
  });

  test('one kill and nothing taken: the block says "1 kill", singular', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 0, kills: 1 });
    await expect(kills(page)).toHaveCount(1);
    await expect(kills(page)).toHaveText('1 kill');
    await expect(kills(page)).toHaveAttribute('aria-label', /^1 kill on /);
    await expect(page.locator(`${BLOCK} .wvw-chip`)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-objectives`)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-kills`)).toHaveAttribute('aria-label', '1 kill');
  });

  test('two kills: "2 kills", plural', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 2 });
    await expect(kills(page)).toHaveText('2 kills');
    await expect(kills(page)).toHaveAttribute('aria-label', /^2 kills on /);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-kills`)).toHaveAttribute('aria-label', '2 kills');
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

// ---- The period's end -------------------------------------------------------
// The tab hidden 90 min, the API stopped for the last 23: the body it comes back
// to is 23 min old, and the title ends where the data does, not where the tab did.

test.describe('what you missed, the API stopped at the end of the absence', () => {
  test.use({ timeline: missedStopped() });
  test('the period ends at the data, not at the return', async ({ page, wvw }) => {
    test.slow();
    await load(page, wvw);
    const openedAt = await wvw.now();
    await hidden(page, wvw, 90 * MIN);
    await visible(page);
    await openMap(page, wvw, page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`));
    await expect(page.locator(BLOCK)).toBeAttached();
    const title = () => titleText(page);
    const hhmm = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    // The kill history dates the body a moment after the block shows; the title
    // settles on the data's end, and the return's time never comes back.
    await expect.poll(title, { message: 'the title names the end of the data', timeout: 60000 }).toContain(`–${hhmm(openedAt + 67 * MIN)}`);
    expect(await title()).not.toContain(hhmm(openedAt + 90 * MIN));
  });
});

// The same absence, the API back with a higher score and nothing else new, and
// the same absence with the map already open when the tab comes back: the title
// reads the data's end as soon as it is painted and keeps it.
test.describe('what you missed, the end once the data is dated', () => {
  const TIER_BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);
  const hhmm = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const titleOf = page => titleText(page);

  test.describe('the score rises after the return', () => {
    test.use({ timeline: missedStopped().advance(5, { kills: {} }) });
    test('the end does not move later', async ({ page, wvw }) => {
    test.slow();
      await load(page, wvw);
      const openedAt = await wvw.now();
      await hidden(page, wvw, 90 * MIN);
      await visible(page);
      await openMap(page, wvw, TIER_BUTTON(page));
      await expect(page.locator(BLOCK)).toBeAttached();
      await expect.poll(() => titleOf(page), { message: 'the title at the return', timeout: 60000 }).toContain(`–${hhmm(openedAt + 67 * MIN)}`);
      await later(page, wvw, 4 * MIN);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => matchScoreRoseAt('1-1')), 'the state: the score rose after the return').toBeGreaterThan(openedAt + 90 * MIN);
      expect(await titleOf(page), 'the title after the score rose').toContain(`–${hhmm(openedAt + 67 * MIN)}`);
    });
  });

  test.describe('the map is open at the return', () => {
    test.use({ timeline: missedStopped() });
    test('the title is the data\'s end the moment the kill history lands', async ({ page, wvw }) => {
    test.slow();
      await load(page, wvw);
      const openedAt = await wvw.now();
      await openMap(page, wvw, TIER_BUTTON(page));
      // Read the title right after the page's own handlers on each kill-history
      // read, whenever the read lands: not a time the test chooses.
      await page.evaluate(() => {
        const read = getKillSheet;
        window.__titles = [];
        getKillSheet = () => {
          const p = read().then(v => v);
          p.then(() => queueMicrotask(() => queueMicrotask(() => {
            const t = document.querySelector('.info-popover .wvw-missed:not(.is-leaving) .wvw-missed-title');
            window.__titles.push(t ? [...t.childNodes].filter(n => !(n.classList && n.classList.contains('wvw-missed-counts'))).map(n => n.textContent).join('').trim() : null);
          })));
          return p;
        };
      });
      await hidden(page, wvw, 90 * MIN);
      await visible(page);
      await later(page, wvw, 0);
      await page.waitForFunction(() => window.__titles.some(t => t), null, { timeout: 20000 });
      const titles = (await page.evaluate(() => window.__titles)).filter(Boolean);
      expect(titles[0], 'the title when the history landed').toContain(`–${hhmm(openedAt + 67 * MIN)}`);
    });
  });
});

// ---- The same end as the map's corner -------------------------------------
// The visitor's group a minute behind (two kills on EBG a minute), the tab
// hidden 12 min: the body it comes back to is two kills behind the shared kill
// history. The summary counts to the corner's end, the newest data, whichever
// body brought it.
test.describe('what you missed, the body behind the kill history', () => {
  test.use({ timeline: missedBehind() });
  test('the summary counts to the corner\'s end, not to the body', async ({ page, wvw }) => {
    await load(page, wvw);
    await later(page, wvw, 2 * MIN);
    await hidden(page, wvw, 12 * MIN);
    await visible(page);
    await openMap(page, wvw, page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`));
    await expect(page.locator(BLOCK)).toBeAttached();
    await later(page, wvw, 0);
    await page.waitForTimeout(1500); // the popover's one-second repaint
    const seen = await page.evaluate(([sel, id]) => {
      const kept = newestMatches.get(id).match;
      const note = missedNotes.get(id);
      const box = document.querySelector(sel);
      const history = Math.max(0, ...fightSamples(kept).map(s => sumKills(s.n)));
      return {
        behind: history - missedKillTotal(kept),
        want: Math.max(history, missedKillTotal(kept)) - missedKillTotal(note.before),
        kills: [...box.querySelectorAll('.wvw-missed-killn')].reduce((n, b) => n + Number(b.textContent), 0),
        title: [...box.querySelector('.wvw-missed-title').childNodes].filter(n => !(n.classList && n.classList.contains('wvw-missed-counts'))).map(n => n.textContent).join(''),
        end: missedHhmm(killView(kept).clock),
      };
    }, [BLOCK, FOCUS]);
    expect(seen.behind, 'the state: the body kept is behind the kill history').toBeGreaterThan(0);
    expect(seen.kills, 'the kills from the body before up to the newest data').toBe(seen.want);
    expect(seen.title, 'the title ends at the corner\'s time').toContain(`–${seen.end}`);
  });
});

// ---- How long an absence -----------------------------------------------------
// Play with objectives changing hands from the opening; the tab away for 9 min
// (the corner's ten minutes already cover it: nothing) or for over 2 h (the
// block comes folded, its two badges in the title, and opens on a tap).
test.describe('what you missed, by how long the tab was away', () => {
  test.use({ timeline: missed(150, 30) });
  const TIER_BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);

  test('away 9 min: no block, though objectives changed hands', async ({ page, wvw }) => {
    await load(page, wvw);
    const from = await wvw.now();
    await hidden(page, wvw, 9 * MIN);
    await visible(page);
    const to = await wvw.now();
    expect(wvw.timeline.flipsBetween(FOCUS, from - wvw.recordedAt, to - wvw.recordedAt).length, 'the state: flips while away').toBeGreaterThan(0);
    await openMap(page, wvw, TIER_BUTTON(page));
    await later(page, wvw, 0);
    await page.waitForTimeout(1500); // the popover's one-second repaint
    expect(await page.evaluate(([sel, id]) => !!document.querySelector(sel) || missedNotes.has(id), [BLOCK, FOCUS]),
      'a summary after 9 min away').toBe(false);
  });

  test('away over 2 h: the block comes folded with both badges, and opens on a tap', async ({ page, wvw }) => {
    test.slow();
    await load(page, wvw);
    await hidden(page, wvw, 2 * 60 * MIN + 10 * MIN);
    await visible(page);
    await openMap(page, wvw, TIER_BUTTON(page));
    const block = page.locator(BLOCK);
    await expect(block).toBeAttached();
    await expect(block).not.toHaveClass(/is-open/);
    await expect(block.locator('.wvw-missed-head')).toHaveAttribute('aria-expanded', 'false');
    await expect(block.locator('.wvw-chip')).toHaveCount(0);
    await expect(block.locator('.wvw-missed-count.is-kills')).toHaveAttribute('aria-label', /^\d+ kills$/);
    await expect(block.locator('.wvw-missed-count.is-objectives')).toHaveAttribute('aria-label', /^\d+ objectives changed hands$/);
    await block.locator('.wvw-missed-head').click();
    await expect(block).toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip[data-obj]').first()).toBeAttached();
  });
});
