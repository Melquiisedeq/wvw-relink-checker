// Time: one state per row, each from a new page, against the same invariants.
//
//   state                                  how
//   API frozen 40 min, then back           frozen(40), the map opened four times
//   two server groups alternating          twoPools(10, 30)
//   reload, one group behind               copyBehindAll(10, 30) and twoPools(10, 30), reload()
//   tab hidden 2 h, then back              missed(120, 6), hidden() / visible()
//   laptop waking after 30 min             playing(40), wake(): every due timer once
//   map open while the API is down         apiDown(12), the map never closed
//   the visitor's group down, copy current visitorDown(20), the map open, then closed
//   our copy ahead of the visitor's, old   copyAheadOld(20) and (2), the map open
//   kills in steps, the score rising       killSteps(7, 12, 42), the map open
//
// Invariants, at every look:
//   stale    nothing says the data is current - the map's "data from" without
//            its warning, the kills on one line, swords on a tab - when what
//            the API gave is more than 6 min old (js/maps-early.js HUD_STALE_MS), plus
//            the time the page takes to read it again.
//   same     the map's corner and the tab with the swords give the same count.
//   forward  nothing goes back: VP, Activity and the skirmish score on the
//            standings card, the "data from" time.
// And on the row that hides the tab, "What you missed": it shows, its period
// holds every flip, its count is the flips', its kills are the timeline's.
import { test, expect } from './support/fixtures.mjs';
import { gw2 } from './support/gw2.mjs';
import { FOCUS, HOUR, MIN, apiDown, copyAheadOld, copyBehindAll, frozen, hidden, killSteps, missed, playing, twoPools, visible, visitorDown, wake } from './support/scenarios.mjs';

const STALE_MS = 6 * MIN;
// How long the page may take to read the API again: the open map asks every
// 30 s; closed, the standings every 5 min (js/maps-early.js MAP_REFRESH_MS,
// js/config.js STANDINGS_REFRESH_MS).
const READ_OPEN_MS = 1 * MIN;
const READ_CLOSED_MS = 5 * MIN;
const TIER = `NA Tier ${FOCUS.split('-')[1]}`;

// A row walks up to 2 h of page time in seconds: 2-9 s each alone, 4-16 s
// three side by side.
test.describe.configure({ timeout: 60 * 1000 });
test.use({ clock: 'playwright', timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } });

// What the page shows of the focus match, read in one go.
const look = page => page.evaluate(id => {
  const num = el => {
    if (!el) return null;
    const t = ((el.firstChild && el.firstChild.nodeValue) || el.textContent || '').trim();
    const m = /^([\d.,]+)(k?)$/.exec(t);
    return m ? Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1) : null;
  };
  const card = document.querySelector(`.standing-match[data-match-id="${id}"]`);
  const sides = card ? [...card.querySelectorAll('.standing-side')].map(s => {
    const v = s.querySelectorAll('.standing-side-stats .stat-value');
    return { color: ['red', 'blue', 'green'].find(c => s.classList.contains('side-' + c)),
      vp: num(s.querySelector('.standing-vp .stat-value')),
      skirmish: v.length === 3 ? num(v[0]) : null, activity: num(v[v.length - 2]) };
  }) : [];
  const q = sel => document.querySelector('.info-popover .wvw-plot-wrap ' + sel);
  const right = q('.wvw-hud-r');
  const map = right ? {
    shown: !right.hidden,
    stale: q('.wvw-hud-ago').classList.contains('is-stale'),
    ago: q('.wvw-hud-ago').textContent,
    at: Date.parse(q('.wvw-hud-ago').dateTime) || null,
    big: q('.wvw-hud-big').textContent,
    two: q('.wvw-hud-l').classList.contains('is-two'),
    small: q('.wvw-hud-small').textContent,
    tabs: [...document.querySelectorAll('.info-popover .wvw-tab')].map(b => ({ type: b.dataset.type,
      active: b.classList.contains('is-active'), hot: b.classList.contains('is-hot'), title: b.title })),
  } : null;
  const box = document.querySelector('.info-popover .wvw-missed:not(.is-leaving)');
  const missed = box ? {
    title: box.querySelector('.wvw-missed-title')?.textContent || '',
    time: box.querySelector('.wvw-missed-time')?.textContent || '',
    count: Number(box.querySelector('.wvw-missed-count')?.textContent) || 0,
    chips: [...box.querySelectorAll('.wvw-chip[data-obj]')].map(c => c.dataset.obj),
    kills: [...box.querySelectorAll('.wvw-missed-killn')].reduce((n, b) => n + Number(b.textContent), 0),
  } : null;
  return { now: Date.now(), sides, map, missed };
}, FOCUS);

// The checks of one look against the timeline, and against the look before.
// `read`: how long the page may take to read again.
function invariants(seen, before, tl, recordedAt, read) {
  const out = [];
  const t = seen.now - recordedAt;
  const age = seen.now - tl.changedAt(FOCUS, tl.lastUp(t));
  const m = seen.map;
  if (m && m.shown) {
    if (age > STALE_MS + read) {
      if (!m.stale || !m.ago.startsWith('⚠')) out.push(`stale: the corner says "${m.ago}" on data ${Math.round(age / 1000)} s old`);
      if (!m.two && m.big !== '–') out.push(`stale: the kills read as current ("${m.big} ${m.small}") on data ${Math.round(age / 1000)} s old`);
      if (m.tabs.some(b => b.hot)) out.push(`stale: swords on a tab on data ${Math.round(age / 1000)} s old`);
    }
    if (m.at > seen.now) out.push(`forward: "data from" ${new Date(m.at).toISOString()} is after the page's now`);
    const hot = m.tabs.find(b => b.hot && b.active);
    if (hot) {
      const tab = /— (\d+) kills in (\d+) min/.exec(hot.title);
      const mins = /(\d+)/.exec(m.small);
      if (!tab || tab[1] !== m.big || !mins || tab[2] !== mins[1]) out.push(`same: the tab says "${hot.title}", the corner "${m.big} ${m.small}"`);
    }
  }
  if (before) {
    const sameSkirmish = tl.skirmishAt(FOCUS, before.now - recordedAt) === tl.skirmishAt(FOCUS, t);
    for (const s of seen.sides) {
      const p = before.sides.find(x => x.color === s.color);
      if (!p) continue;
      for (const k of ['vp', 'activity', ...(sameSkirmish ? ['skirmish'] : [])]) {
        if (s[k] !== null && p[k] !== null && s[k] < p[k]) out.push(`forward: ${s.color} ${k} went from ${p[k]} to ${s[k]}`);
      }
    }
    if (m && m.at && before.map && before.map.at && m.at < before.map.at) {
      out.push(`forward: "data from" went back from ${new Date(before.map.at).toISOString()} to ${new Date(m.at).toISOString()}`);
    }
  }
  return out;
}

// One row's moves: the page, its fixture, and the checks kept between looks.
function rower(page, wvw) {
  const tl = wvw.timeline;
  let before = null;
  const r = {
    looks: [],
    async check(what, read = READ_CLOSED_MS) {
      // The map's one-second repaint, after whatever the last move started.
      await wvw.settle();
      await page.clock.fastForward(1000);
      const seen = await look(page);
      const broken = invariants(seen, before, tl, wvw.recordedAt, read);
      expect(broken, `${what} (${Math.round((seen.now - wvw.opensAt) / 60000)} min after opening): ${broken.join(' | ')}`).toEqual([]);
      before = { ...seen, map: seen.map || before?.map };
      r.looks.push(seen);
      return seen;
    },
    // How old the data the API gave is, now.
    async age() {
      const now = await wvw.now();
      return now - tl.changedAt(FOCUS, tl.lastUp(now - wvw.recordedAt));
    },
    async open() {
      await page.locator(`.tier-map-btn[aria-label*="${TIER}"]`).click();
      await expect(page.locator(".info-popover .wvw-plot g[role='button']").first()).toBeVisible();
      await expect(page.locator('.info-popover .wvw-plot-wrap .wvw-hud-r')).toBeVisible();
    },
    async close() {
      await page.keyboard.press('Escape');
      await expect(page.locator('.info-popover')).toHaveCount(0);
    },
    // The map opened, looked at, closed.
    async peek(what, read) {
      await r.open();
      const seen = await r.check(what, read);
      await r.close();
      return seen;
    },
    // `min` minutes, `step` at a time, every timer due firing once at the end
    // of each step (runFor fires every one, rAF included: 28 s for 2 min); a
    // look after each.
    async pass(min, step, what, read) {
      for (let done = 0; done < min; done += step) {
        await page.clock.fastForward(step * MIN);
        await r.check(`${what}, +${done + step} min`, read);
      }
    },
    async load() {
      await page.goto(wvw.url);
      await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .standing-side`)).toHaveCount(3);
      await r.check('opened');
    },
    // F5 a few seconds into the next odd minute, where the older server group
    // answers (support/gw2.mjs, olderPool); the jump fires no timer, so the
    // first match read of that minute is the reloaded page's. `check`: false
    // when the test reads the page itself.
    async reload(check = true) {
      const t = await wvw.now() - wvw.recordedAt;
      const odd = (Math.floor(t / MIN) | 1) + (Math.floor(t / MIN) % 2 ? 2 : 0);
      await wvw.skew(odd * MIN + 3000 - t);
      await page.reload();
      await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .standing-side`)).toHaveCount(3);
      if (check) await r.check('reloaded');
      else await wvw.settle();
    },
  };
  return r;
}

test.describe('API frozen 40 min, then back', () => {
  test.use({ timeline: frozen(40) });
  test('the page says the data is old, then current again', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    await r.peek('before');
    await r.pass(4, 2, 'playing');
    await r.pass(20, 5, 'frozen');
    expect(await r.age(), 'the state: data over 11 min old').toBeGreaterThan(STALE_MS + READ_CLOSED_MS);
    await r.peek('frozen 20 min');
    await r.pass(20, 5, 'frozen');
    await r.peek('frozen 40 min');
    await r.pass(12, 4, 'back');
    const seen = await r.peek('back 12 min');
    expect(seen.map.tabs.some(b => b.hot && b.active), 'the state: swords on the open tab').toBe(true);
  });
});

test.describe('two server groups alternating', () => {
  test.use({ timeline: twoPools(10, 30) });
  test('nothing goes back', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    await r.pass(30, 5, 'alternating');
    const seen = await r.peek('alternating 30 min');
    expect(seen.map.tabs.some(b => b.hot && b.active), 'the state: swords on the open tab').toBe(true);
  });
});

// A reload forgets the bodies the page held; this browser's fight log does
// not. The first read after it lands on the older group, 10 min behind.
test.describe('reload while one server group is behind', () => {
  test.describe('the whole group is behind and our copy is ahead', () => {
    test.use({ timeline: copyBehindAll(10, 30) });
    test('nothing goes back', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      const copyReads = [];
      page.on('request', q => { if (/\/api\/latest$/.test(q.url())) copyReads.push(q.url()); });
      await r.load();
      await r.pass(8, 4, 'alternating');
      await r.peek('before 8 min');
      await r.pass(8, 4, 'alternating');
      await r.peek('before 16 min');
      const copyBefore = copyReads.length;
      await r.reload();
      expect(copyReads.length - copyBefore, 'the state: after the reload the copy was asked, the only way to a newer body').toBeGreaterThanOrEqual(1);
      await r.peek('reloaded, map opened');
    });
  });

  test.describe('every read reaches the older group', () => {
    test.use({ timeline: twoPools(10, 30) });
    test('the corner gives the older time, with its warning', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.pass(8, 4, 'alternating');
      await r.peek('before 8 min');
      await r.pass(8, 4, 'alternating');
      const before = await r.peek('before 16 min');
      await r.reload(false);
      await r.open();
      await wvw.settle();
      await page.clock.fastForward(1000);
      const seen = await look(page);
      const t = seen.now - wvw.recordedAt;
      expect(Math.floor(t / MIN) % 2, 'the state: the older group answering').toBe(1);
      const served = wvw.timeline.changedAt(FOCUS, t - 10 * MIN);
      expect(seen.map.ago, 'the corner after the reload').toMatch(/^⚠/);
      expect(seen.map.stale, 'the corner marked old').toBe(true);
      expect(seen.map.at, '"data from" before the time it had before the reload').toBeLessThan(before.map.at);
      expect(seen.map.at, '"data from" over 6 min back').toBeLessThanOrEqual(seen.now - STALE_MS);
      expect(seen.map.at, '"data from" not before the body').toBeGreaterThanOrEqual(served);
    });
  });
});

test.describe('tab hidden 2 h, then back', () => {
  test.use({ timeline: missed(120, 6) });
  test('"What you missed" holds every flip and the kills', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    const hiddenAt = await wvw.now();
    await hidden(page, wvw, 2 * HOUR + MIN);
    await visible(page);
    const backAt = await wvw.now();
    await r.check('back');
    const seen = await r.peek('back, map opened');
    const tl = wvw.timeline;
    const from = hiddenAt - wvw.recordedAt, to = backAt - wvw.recordedAt;
    const flips = tl.flipsBetween(FOCUS, from, to);
    expect(flips.length, 'the state: flips while away').toBe(6);
    expect(seen.missed, 'the "What you missed" block').not.toBeNull();
    expect(seen.missed.title).toMatch(/^What you missed/);
    expect(seen.missed.count, 'objectives that changed hands').toBe(flips.length);
    for (const id of seen.missed.chips) expect(flips.map(f => f.id), `chip ${id}`).toContain(id);
    // "04:27–06:28 PM", "04:27 PM–06:28 PM" or "since before 04:27 PM", in minutes of the day.
    const minute = (h, mm, ap) => ((Number(h) % 12) + (ap === 'PM' ? 12 : 0)) * 60 + Number(mm);
    const times = [...seen.missed.time.matchAll(/(\d{2}):(\d{2})(?:\s?(AM|PM))?/g)];
    const ap = /(AM|PM)/.exec(seen.missed.time)?.[1];
    const span = times.map(x => minute(x[1], x[2], x[3] || ap));
    const sure = !/since before/.test(seen.missed.time);
    const end = sure ? span[1] : null;
    for (const f of flips) {
      const d = new Date(f.at);
      const at = d.getUTCHours() * 60 + d.getUTCMinutes();
      if (sure) expect(at >= span[0] && at <= end, `flip of ${f.id} at ${d.toISOString()} inside "${seen.missed.time}"`).toBe(true);
      else expect(at >= span[0], `flip of ${f.id} at ${d.toISOString()} after "${seen.missed.time}"`).toBe(true);
    }
    const kills = k => Object.values(k).reduce((a, b) => a + b, 0);
    expect(seen.missed.kills, 'the kills while away').toBe(kills(tl.killsByMap(FOCUS, to)) - kills(tl.killsByMap(FOCUS, from)));
  });
});

test.describe('laptop waking after 30 min', () => {
  test.use({ timeline: playing(40) });
  test('the map reads again and says so', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    await r.open();
    await r.check('map open', READ_OPEN_MS);
    await wake(page, 30 * MIN);
    await r.check('awake', READ_OPEN_MS);
    await r.pass(4, 2, 'awake', READ_OPEN_MS);
  });
});

test.describe('map open while the API is down', () => {
  test.use({ timeline: apiDown(12) });
  test('the corner turns old, then current, without closing', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    await r.open();
    await r.pass(4, 2, 'playing', READ_OPEN_MS);
    await r.pass(10, 2, 'API down', READ_OPEN_MS);
    expect(await r.age(), 'the state: data over 7 min old').toBeGreaterThan(STALE_MS + READ_OPEN_MS);
    await r.pass(14, 2, 'back', READ_OPEN_MS);
    const seen = r.looks[r.looks.length - 1];
    expect(seen.map.stale, 'the state: current again').toBe(false);
    expect(seen.map.tabs.some(b => b.hot && b.active), 'the state: swords on the open tab').toBe(true);
  });
});

// Every read of the visitor's refused while our readers go on: our copy stands
// in for the game, on the open map and then on the list, dated by its own time.
test.describe("the visitor's server group down, our copy current", () => {
  test.use({ timeline: visitorDown(20) });
  test('the map and the list show the copy, without a warning', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    const activity = s => s.sides.reduce((n, x) => n + (x.activity || 0), 0);
    // As r.pass, but settled before each jump as well: a copy read that the check's
    // last second started would be cut by the jump (OWN_API_TIMEOUT_MS).
    const walk = async (min, what, read) => {
      for (let done = 0; done < min; done += 2) {
        await wvw.settle();
        await page.clock.fastForward(2 * MIN);
        await r.check(`${what}, +${done + 2} min`, read);
      }
    };
    await r.load();
    await r.open();
    await walk(4, 'playing', READ_OPEN_MS);
    await walk(10, 'visitor down', READ_OPEN_MS);
    let seen = r.looks[r.looks.length - 1];
    expect(wvw.timeline.statusAt(seen.now - wvw.recordedAt), 'the state: the visitor\'s reads refused').not.toBeNull();
    expect(seen.map.stale, `the corner "${seen.map.ago}" on our copy, current`).toBe(false);
    // A 2 min step, and the read after it.
    expect(seen.now - seen.map.at, '"data from": the copy\'s time, within 3 min').toBeLessThan(2 * MIN + READ_OPEN_MS);
    const drawn = activity(seen);
    await r.close();
    await walk(6, 'visitor down, map closed');
    await wvw.settle();
    seen = await look(page);
    expect(wvw.timeline.statusAt(seen.now - wvw.recordedAt), 'the state: still refused').not.toBeNull();
    expect(activity(seen), 'the list drew the copy\'s body').toBeGreaterThan(drawn);
    await expect(page.locator('.standings-alert .retry-btn'), 'no "Trying again" while the copy draws the list').toHaveCount(0);
    // A 5 min load right after one drawn from the copy, before the copy moves.
    await page.evaluate(async () => { await loadStandings(); await loadStandings(); });
    await wvw.settle();
    await expect(page.locator('.standings-alert .retry-btn'), 'no "Trying again" on a copy that has not moved since the last load').toHaveCount(0);
  });
});

// The same with our readers stopped as the visitor's group went down: the copy
// draws the list once, with the body it holds, and then the failure stands;
// the corner warns on the old data.
test.describe("the visitor's server group down, our copy stopped", () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().advance(4).latestHeld(true).status(503, { visitor: true }).advance(20) });
  test('the list says it is trying again', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    await r.open();
    for (let i = 0; i < 6; i++) {
      await wvw.settle();
      await page.clock.fastForward(2 * MIN);
    }
    const seen = await r.check('copy stopped', READ_OPEN_MS);
    expect(seen.map.stale, `the corner "${seen.map.ago}" on data 8 min old`).toBe(true);
    await r.close();
    // The read owed at the close, then the next 5 min tick.
    for (let i = 0; i < 6; i++) {
      await wvw.settle();
      await page.clock.fastForward(2 * MIN);
    }
    await wvw.settle();
    await expect(page.locator('.standings-alert .retry-btn').first(), 'the list\'s "Trying again"').toBeAttached();
  });
});

// /api/latest wins over every read of the visitor's, with a body our readers
// saw rise `age` minutes ago: the corner gives that time, never the moment it
// won, and claims a quiet map only on a rise seen within 3 min.
test.describe("our copy ahead of the visitor's server group, and old", () => {
  const HELD = 40 * MIN;   // copyAheadOld: when our readers stopped
  for (const age of [20, 2]) {
    test.describe(`its data ${age} min old`, () => {
      test.use({ timeline: copyAheadOld(age) });
      test('the corner gives the copy\'s time, with its warning past 6 min', async ({ page, wvw }) => {
        const r = rower(page, wvw);
        await r.load();
        await r.open();
        const served = Math.floor(wvw.timeline.changedAt(FOCUS, HELD) / 1000) * 1000;
        const quiet = s => s.map.small.startsWith('no new kills since');
        let seen = await r.check('map open', READ_OPEN_MS);
        expect(seen.map.at, '"data from": the copy\'s time').toBe(served);
        expect(seen.map.stale, `the corner marked old on data ${age} min old`).toBe(age > 6);
        if (age > 6) expect(quiet(seen), `"${seen.map.small}": a quiet map on a rise ${age} min old`).toBe(false);
        await r.pass(8, 2, 'map open', READ_OPEN_MS);
        seen = r.looks[r.looks.length - 1];
        expect(seen.map.at, '"data from": still the copy\'s time').toBe(served);
        expect(seen.map.ago, 'the corner past 6 min').toMatch(/^⚠/);
        expect(quiet(seen), `"${seen.map.small}": a quiet map on a rise over 6 min old`).toBe(false);
      });
    });
  }
});

// A busy match whose kills the API publishes in steps of 7 min while the score
// rises every minute: a silence that long is the API's rhythm, not a quiet map
// nor the API behind. Up to the step the corner may say only how far the kill
// data goes; kills that truly stop still read as a quiet map, then as late.
const killCorner = page => page.evaluate(id => {
  const q = s => document.querySelector('.info-popover .wvw-plot-wrap ' + s);
  const s2 = q('.wvw-hud-small2');
  const kept = newestMatches.get(id);
  return { line2: s2 && !s2.hidden ? s2.textContent.replace(/\s+/g, ' ') : '', dim: !!q('.wvw-hud-l.is-dim'),
    silence: kept ? killView(kept.match, null).silence : 0 };
}, FOCUS);

test.describe('kills in steps, the score rising', () => {
  for (const lag of [0, 10]) {
    const how = lag ? 'every step through our copy, the visitor\'s group 10 min behind' : 'read from the game';
    test.describe(how, () => {
      test.use({ timeline: killSteps(7, 12, 42, lag) });
      test('the corner never says "no new kills" nor warns', async ({ page, wvw }) => {
        const r = rower(page, wvw);
        await r.load();
        await r.open();
        let longest = 0;
        let upTo = 0;
        for (let i = 1; i <= 80; i++) {
          await page.clock.fastForward(30 * 1000);
          await r.check(`steps, +${i / 2} min`, READ_OPEN_MS);
          const c = await killCorner(page);
          const at = `${i / 2} min after opening, the kills silent ${Math.round(c.silence / 1000)} s`;
          expect(c.line2.startsWith('no new kills'), `${at}: "${c.line2}", a quiet map`).toBe(false);
          expect(c.line2.includes('\u26a0') || c.dim, `${at}: "${c.line2}", warned or dimmed`).toBe(false);
          longest = Math.max(longest, c.silence);
          if (c.line2.startsWith('data up to')) upTo++;
        }
        // The state: silences past the 5.5 min where the corner turns to two lines.
        expect(longest, 'the state: the longest silence the page saw').toBeGreaterThan(6 * MIN);
        expect(longest, 'the page learns of a step within 2 min of its 7').toBeLessThanOrEqual(9 * MIN);
        expect(upTo, 'the state: "data up to" on the long silences').toBeGreaterThan(0);
      });
    });
  }

  // The swords stay lit through a step's silence, and go out with the 10 min window.
  test.describe('a step, then the kills stop: the swords', () => {
    test.use({ timeline: killSteps(7, 12, 21).advance(20, { kills: {} }) });
    test('stay on the busiest map at 8 min of silence, out past 10', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.open();
      let lit = 0;
      let out = 0;
      for (let i = 1; i <= 60; i++) {
        await page.clock.fastForward(30 * 1000);
        await r.check(`swords, +${i / 2} min`, READ_OPEN_MS);
        const c = await killCorner(page);
        const hot = await page.locator('.info-popover .wvw-tab.is-hot').evaluateAll(t => t.map(b => b.dataset.type));
        const at = `the kills silent ${Math.round(c.silence / 1000)} s, swords on [${hot}]`;
        if (c.silence > 7.5 * MIN && c.silence < 8.5 * MIN) {
          expect(hot, `${at}: they should stay on EBG`).toEqual(['Center']);
          lit++;
        }
        if (c.silence > 10.2 * MIN) {
          expect(hot, `${at}: they should be out`).toEqual([]);
          out++;
        }
      }
      expect(lit, 'the state: looks between 7.5 and 8.5 min of silence').toBeGreaterThan(0);
      expect(out, 'the state: looks past 10.2 min of silence').toBeGreaterThan(0);
    });
  });

  test.describe('then the kills stop, the score still rising', () => {
    test.use({ timeline: killSteps(7, 12, 21).advance(20, { kills: {} }) });
    test('the corner says a quiet map past 9 min, then warns', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.open();
      let quiet = 0;
      let warned = 0;
      for (let i = 1; i <= 60; i++) {
        await page.clock.fastForward(30 * 1000);
        await r.check(`stopped, +${i / 2} min`, READ_OPEN_MS);
        const c = await killCorner(page);
        const at = `the kills silent ${Math.round(c.silence / 1000)} s: "${c.line2}"`;
        if (c.silence > 9.2 * MIN && c.silence < 9.8 * MIN) {
          expect(/^no new kills since \S+( \S+)?$/.test(c.line2) && !c.dim, `${at}, not a quiet map`).toBe(true);
          quiet++;
        }
        // 9 min plus 15 kills at the window's pace, 12 to 17 a minute.
        if (c.silence > 10.5 * MIN && c.silence < 15 * MIN) {
          expect(/^\u26a0 data up to \S+( \S+)?$/.test(c.line2) && c.dim, `${at}, no warning`).toBe(true);
          warned++;
        }
      }
      expect(quiet, 'the state: looks between 9.2 and 9.8 min of silence').toBeGreaterThan(0);
      expect(warned, 'the state: looks past 10.5 min of silence').toBeGreaterThan(0);
    });
  });
});

// Every read of the visitor's behind, our copy current: after a sleep with the
// map open, the copy wins in the burst of the wake, and the rise is still one
// inside the gap, so the map reads the kill history again.
test.describe("laptop waking after 30 min, our copy ahead of the visitor's server group", () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().olderPool(10, { every: true }).advance(50) });
  test('the map reads the kill history again', async ({ page, wvw }) => {
    const r = rower(page, wvw);
    await r.load();
    await r.open();
    await r.check('map open', READ_OPEN_MS);
    const history = page.waitForResponse(q => new URL(q.url()).pathname === '/api/kills', { timeout: 15000 })
      .catch(() => { throw new Error('the page never read /api/kills after waking'); });
    await wake(page, 30 * MIN);
    await history;
    await r.check('awake', READ_OPEN_MS);
  });
});

// The API stopped answering anew 20 min before the page comes back: what the
// corner says is the time of the data, not of the first read after the gap.
const stoppedBeforeBack = gw2.match(FOCUS).advance(12).pageOpens().advance(10).freeze(20);

// The rise after the gap is dated by the history, which the map asks for only
// after the match and /api/latest answer (js/maps.js pullFresh, up to
// LATEST_WAIT_MS later): until it lands the corner says the time of the read.
// settle() alone can find the network quiet before it is asked, on a busy
// machine now and then.
const historyRead = page => page.waitForResponse(q => new URL(q.url()).pathname === '/api/kills', { timeout: 15000 })
  .catch(() => { throw new Error('the page never read /api/kills after waking'); });

// With or without a rise watched before the gap: a page open for a while has
// seen the score go up, and must date the next rise from the history all the same.
for (const before of [0, 4]) {
  const seen = before ? 'after 4 min watched' : 'nothing watched';
  test.describe(`laptop waking after 30 min, the API stopped for the last 20, ${seen}`, () => {
    test.use({ timeline: stoppedBeforeBack });
    test('the corner does not say the data is from now', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.open();
      await r.check('map open', READ_OPEN_MS);
      if (before) await r.pass(before, 2, 'watching', READ_OPEN_MS);
      const history = historyRead(page);
      await wake(page, 30 * MIN);
      await history;
      await r.check('awake', READ_OPEN_MS);
      expect(await r.age(), 'the state: data over 11 min old').toBeGreaterThan(STALE_MS + READ_OPEN_MS);
      await r.pass(2, 1, 'awake', READ_OPEN_MS);
    });
  });

  test.describe(`tab hidden 2 h, the API stopped for the last 20 min, ${seen}`, () => {
    test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().advance(100).freeze(20) });
    test('the corner does not say the data is from now', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.open();
      await r.check('map open', READ_OPEN_MS);
      if (before) await r.pass(before, 2, 'watching', READ_OPEN_MS);
      await hidden(page, wvw, 2 * HOUR);
      const history = historyRead(page);
      await visible(page);
      await history;
      await r.check('back', READ_OPEN_MS);
      expect(await r.age(), 'the state: data over 11 min old').toBeGreaterThan(STALE_MS + READ_OPEN_MS);
      await r.pass(2, 1, 'back', READ_OPEN_MS);
    });
  });
}

test.describe('map open over normal polls', () => {
  test.use({ timeline: playing(40) });
  test('the history is not read again', async ({ page, wvw }) => {
    const kills = [];
    page.on('request', q => { if (q.url().includes('/api/kills')) kills.push(q.url()); });
    const r = rower(page, wvw);
    await r.load();
    await r.open();
    await r.check('map open', READ_OPEN_MS);
    const opened = kills.length;
    expect(opened, '/api/kills requests when the map opens').toBeGreaterThan(0);
    await r.pass(8, 1, 'polling', READ_OPEN_MS);
    expect(kills.length, '/api/kills requests while the map polls').toBe(opened);
  });
});
