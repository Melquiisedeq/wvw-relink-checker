// Time: one state per row, each from a new page, against the same invariants.
//
//   state                                  how
//   API frozen 40 min, then back           frozen(40), the map opened four times
//   two server groups alternating          twoPools(10, 30)
//   reload, one group behind               copyBehindAll(10, 30) and twoPools(10, 30), reload()
//   tab hidden 2 h, then back              missed(120, 6), hidden() / visible()
//   map open while the API is down         apiDown(12), the map never closed
//   the visitor's group down, copy current visitorDown(20), the map open, then closed
//   our copy ahead of the visitor's, old   copyAheadOld(20) and (2), the map open
//   kills in steps, the score rising       killSteps(7, 12, 42), the map open
//   a fight under 75 a 10 min stops        fightStops(7, 18, 20), the map open
//   copy unread, its summary read          freeze(3), the map open
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
import { fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { recording } from './support/recordings.mjs';
import { FOCUS, HOUR, MIN, apiDown, at, copyAheadOld, copyBehindAll, fightStops, frozen, hidden, killSteps, missed, playing, twoPools, visible, visitorDown, wake } from './support/scenarios.mjs';

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
    count: Number(box.querySelector('.wvw-missed-count.is-objectives')?.textContent) || 0,
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
    // A period over 2 h comes folded: opened to read its chips and kills.
    await r.open();
    const head = page.locator('.info-popover .wvw-missed:not(.is-leaving) .wvw-missed-head');
    if (await head.getAttribute('aria-expanded') === 'false') await head.click();
    const seen = await r.check('back, map opened');
    await r.close();
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

// "What you missed" and the captures list name the day when it began on the one
// before (the visitor's calendar, here UTC), and the summary is not made over 24 h.
test.describe('"What you missed" and the day', () => {
  // The tab hidden `hours`, the fight going on, then back: the summary, or null.
  const away = async (page, wvw, hours) => {
    const r = rower(page, wvw);
    await r.load();
    await hidden(page, wvw, hours * HOUR + MIN);
    await visible(page);
    await r.check('back');
    await r.open();
    return (await r.check('back, map opened')).missed;
  };
  const SUNDAY = '2026-12-06T15:00:00Z';
  const fight = hours => at(SUNDAY).advance(hours * 60, { flips: 40, kills: { Center: 3 } });

  test.describe('21 h across midnight', () => {
    test.use({ timeline: fight(21) });
    test('the start says "yesterday"', async ({ page, wvw }) => {
      const m = await away(page, wvw, 21);
      expect(m, 'the summary').not.toBeNull();
      expect(m.time).toMatch(/^(since before 0[23]:\d\d PM yesterday|0[23]:\d\d PM yesterday\u2013\d\d:\d\d (AM|PM))$/);
    });
  });
  test.describe('1 h the same day', () => {
    test.use({ timeline: fight(1) });
    test('the hours alone, as ever', async ({ page, wvw }) => {
      const m = await away(page, wvw, 1);
      expect(m, 'the summary').not.toBeNull();
      expect(m.time).toBe('02:59\u201303:59 PM');
    });
  });
  test.describe('25 h', () => {
    test.use({ timeline: fight(25) });
    test('no summary', async ({ page, wvw }) => {
      expect(await away(page, wvw, 25), 'the summary').toBeNull();
    });
  });

  // Flips from 23:51 to 00:03: the rows before midnight say "yesterday".
  test.describe('captures over midnight', () => {
    const open = Date.parse('2026-12-07T00:03:00Z');
    test.use({ timeline: gw2.match(FOCUS).freeze(Math.floor((open - recording().recordedAt) / MIN) - 12).advance(12, { flips: 8 }).pageOpens() });
    test('a capture of the day before is dated by it', async ({ page, wvw }) => {
      await page.goto(wvw.url);
      await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .standing-side`)).toHaveCount(3);
      await page.locator(`.tier-map-btn[aria-label*="${TIER}"]`).click();
      await page.locator('.info-popover .wvw-subtab[data-pane="captures"]').click();
      const rows = await page.locator('.info-popover .wvw-cap').evaluateAll(els => els.map(e => ({
        text: e.querySelector('.wvw-cap-time').textContent, at: Date.parse(e.querySelector('.wvw-cap-time').dateTime), label: e.getAttribute('aria-label') })));
      const midnight = Date.parse('2026-12-07T00:00:00Z');
      expect(rows.some(x => x.at < midnight), 'a capture before midnight').toBe(true);
      expect(rows.some(x => x.at >= midnight), 'a capture after it').toBe(true);
      for (const x of rows) {
        expect(x.text, `the row at ${new Date(x.at).toISOString()}`).toMatch(x.at < midnight ? /^\d\d:\d\d (AM|PM) yesterday$/ : /^\d\d:\d\d (AM|PM)$/);
        expect(x.label, 'its words').toContain(` at ${x.text}`);
      }
    });
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
    // The balloon dates the score to our copy and says since when the game has not answered.
    const btn = page.locator('.info-popover .wvw-hud-r .wvw-hud-btn');
    const note = page.locator('.info-popover .wvw-hud-note');
    const said = async () => { await wvw.settle(); await page.clock.fastForward(1000); return note.textContent(); };
    // The corner's time and the balloon read in one go: a newer copy can land between the
    // step and the click, and both then move together.
    const shown = () => page.evaluate(() => {
      const at = new Date(document.querySelector('.info-popover .wvw-hud-ago').dateTime);
      return {
        tip: document.querySelector('.info-popover .wvw-hud-note').textContent,
        want: at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        at: at.getTime(),
      };
    });
    await btn.click();
    await said();
    let { tip, want, at } = await shown();
    expect(at, 'the corner is not older than the copy first seen').toBeGreaterThanOrEqual(seen.map.at);
    expect(tip, 'the balloon on the copy').toMatch(/^Score last changed at .*, read by our server\. The game last answered this page \d+ min ago\.$/);
    expect(Number(/answered this page (\d+) min/.exec(tip)[1]), 'the game silent since the visitor went down').toBeGreaterThanOrEqual(9);
    expect(tip).toContain(`Score last changed at ${want}, read by our server.`);
    // The wording follows the body on show, not the game's last answer: an answer just now
    // changes nothing while the copy's body stands, and the game's own body gets the plain line.
    const body = (mode) => page.evaluate(([id, how]) => {
      if (how === 'answered') gameAnsweredAt.set(id, Date.now());
      else { const k = newestMatches.get(id); k.match = { ...k.match }; }
    }, [FOCUS, mode]);
    await body('answered');
    tip = await said();
    expect(tip, 'the game answered just now, the copy\'s body on show').toMatch(/read by our server\. The game last answered this page \d+ s ago\.$/);
    await body('game');
    tip = await said();
    expect(tip, 'the game\'s own body on show').toMatch(/^Score last changed at [^.]*\. This page checks the game every 30 s; last answer \d+ s ago\. The game's data runs about 40 s behind play\.$/);
    await btn.click();
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

// With the copy not read (a 503) the summary still holds: a body of the game with the
// summary's score is dated by the summary's `at`, not by the moment the page read it.
test.describe('no copy, the game\'s body as far along as the summary', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).freeze(3).pageOpens() });
  test('the corner gives the summary\'s time', async ({ page, wvw }) => {
    await fail(page, wvw, /\/api\/latest$/, 503);
    const r = rower(page, wvw);
    await r.load();
    await r.open();
    const served = Math.floor(wvw.timeline.changedAt(FOCUS, 12 * MIN) / 1000) * 1000;
    await r.pass(1, 1, 'map open', READ_OPEN_MS);
    let seen = r.looks[r.looks.length - 1];
    expect(seen.map.at, '"data from": the summary\'s time at the first look after the summary').toBe(served);
    await r.pass(2, 0.5, 'map open', READ_OPEN_MS);
    seen = r.looks[r.looks.length - 1];
    expect(seen.map.at, '"data from": the summary\'s time, not the page\'s reading').toBe(served);
  });
});

// A busy match whose kills the API publishes in steps of 7 min while the score
// rises every minute: a silence that long is the API's rhythm, not a quiet map
// nor the API behind. Up to the step the corner may say only how far the kill
// data goes; kills that truly stop still read as a quiet map, then as late.
const killCorner = page => page.evaluate(id => {
  const q = s => document.querySelector('.info-popover .wvw-plot-wrap ' + s);
  const s2 = q('.wvw-hud-small2');
  const kept = newestMatches.get(id);
  const view = kept ? killView(kept.match, null) : null;
  return { line2: s2 && !s2.hidden ? s2.textContent.replace(/\s+/g, ' ') : '', dim: !!q('.wvw-hud-l.is-dim'),
    silence: view ? view.silence : 0, ebg: view && view.rates ? Math.round(view.rates.per.get('Center')) : 0 };
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

  // The swords stay lit through a step's silence and go out with the 10 min window, or 7 min under 75 kills per 10.
  // `last`: minutes from the opening to the last kills. The smaller fight kills 7 a minute: the page dates the
  // last kills when it learns of them, up to 2 min late, so its window reads 52 to 70.
  const swordCases = [
    { timeline: killSteps(7, 12, 21).advance(20, { kills: {} }), last: 15, size: [75, Infinity], lit: [8.7, 9.3], out: [10.2, Infinity],
      name: 'a step, then the kills stop: the swords, 75 or more per 10 min, on at 9 min of silence, out past 10' },
    { timeline: fightStops(7, 18, 20), last: 18,
      size: [50, 74], lit: [5.7, 6.3], out: [7.7, 8.3], name: 'a fight under 75 per 10 min stops: the swords on at 6 min of silence, out at 8' },
  ];
  for (const c of swordCases) {
    test.describe(c.name, () => {
      test.use({ timeline: c.timeline });
      test('stay on the busiest map, then go out', async ({ page, wvw }) => {
        const r = rower(page, wvw);
        await r.load();
        await r.open();
        let lit = 0;
        let out = 0;
        // The 30 s steps keep the page's timers firing. Each waits for the page's requests: the fake server answers at the page's clock, and the page stamps a kills sample with the time it asked.
        for (let i = 1; i <= 60; i++) {
          await page.clock.fastForward(30 * 1000);
          await wvw.settle();
          // Before the last kills, a silence is a gap between steps, not the stop.
          if (i / 2 <= c.last + 2) continue;
          const silence = (await killCorner(page)).silence;
          const inLit = silence > c.lit[0] * MIN && silence < c.lit[1] * MIN && !lit;
          const inOut = silence > c.out[0] * MIN && silence < c.out[1] * MIN && !out;
          if (!inLit && !inOut) continue;
          await r.check(`swords, +${i / 2} min`, READ_OPEN_MS);
          const k = await killCorner(page);
          const hot = await page.locator('.info-popover .wvw-tab.is-hot').evaluateAll(t => t.map(b => b.dataset.type));
          const at = `the kills silent ${Math.round(k.silence / 1000)} s, EBG at ${k.ebg} per 10 min, swords on [${hot}]`;
          expect(k.ebg, `the state: ${at}`).toBeGreaterThanOrEqual(c.size[0]);
          expect(k.ebg, `the state: ${at}`).toBeLessThanOrEqual(c.size[1]);
          if (inLit) {
            expect(hot, `${at}: they should stay on EBG`).toEqual(['Center']);
            lit++;
          } else {
            expect(hot, `${at}: they should be out`).toEqual([]);
            out++;
          }
        }
        expect(lit, `the state: looks between ${c.lit[0]} and ${c.lit[1]} min of silence`).toBeGreaterThan(0);
        expect(out, `the state: looks past ${c.out[0]} min of silence`).toBeGreaterThan(0);
      });
    });
  }

  test.describe('then the kills stop, the score still rising', () => {
    test.use({ timeline: killSteps(7, 12, 21).advance(20, { kills: {} }) });
    test('the corner says a quiet map past 9 min, then warns', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.open();
      let quiet = 0;
      let warned = 0;
      // The 30 s steps keep the page's timers firing; each waits for the network, as in the loop above.
      for (let i = 1; i <= 60; i++) {
        await page.clock.fastForward(30 * 1000);
        await wvw.settle();
        const silence = (await killCorner(page)).silence;
        const inQuiet = silence > 9.2 * MIN && silence < 9.8 * MIN && !quiet;
        // 9 min plus 15 kills at the window's pace, 12 to 17 a minute.
        const inWarned = silence > 10.5 * MIN && silence < 15 * MIN && !warned;
        if (!inQuiet && !inWarned) continue;
        await r.check(`stopped, +${i / 2} min`, READ_OPEN_MS);
        const c = await killCorner(page);
        const at = `the kills silent ${Math.round(c.silence / 1000)} s: "${c.line2}"`;
        if (inQuiet) {
          expect(/^no new kills since \S+( \S+)?$/.test(c.line2) && !c.dim, `${at}, not a quiet map`).toBe(true);
          quiet++;
        } else {
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

// The 5 min guard of schedulePeriodicRefresh (js/api.js) on two clocks: the
// device asleep stops performance.now() on some devices (page.clock.setSystemTime moves only Date), and
// a device clock set back must not bar a run. Called on its own function, so the
// page's other reads on the tab's return (the peek, the push) do not count.
test.describe('the periodic refresh guard, two clocks', () => {
  const STEP = 5 * MIN;
  const arm = async (page, wvw) => {
    await page.goto(wvw.url);
    await page.waitForFunction(() => typeof schedulePeriodicRefresh === 'function');
    // Paused before the seed: no real time slips between the looks into the margins below.
    await page.clock.pauseAt(await wvw.now() + 1000);
    await page.evaluate(step => {
      globalThis.__reads = 0;
      globalThis.__answer = undefined;
      globalThis.__run = schedulePeriodicRefresh(() => { globalThis.__reads++; return globalThis.__answer; }, step);
    }, STEP);
  };
  const reads = page => page.evaluate(() => globalThis.__reads);
  const back = async page => { await page.evaluate(() => globalThis.__run()); return reads(page); };

  test('the device asleep: the date jumps, performance.now() stands still, the return reads', async ({ page, wvw }) => {
    await arm(page, wvw);
    await hidden(page, wvw, 2 * HOUR);
    await visible(page);
    await expect.poll(() => reads(page), { message: 'a read on the return after a 2 h sleep' }).toBe(1);
  });

  test('the slack: 1 s short of the interval is enough, 1.5 s short is not', async ({ page, wvw }) => {
    await arm(page, wvw);
    await wvw.skew(STEP - 1500);
    expect(await back(page), 'the date 298.5 s on, none on performance.now()').toBe(0);
    await wvw.skew(1000);
    expect(await back(page), 'the date 299.5 s on').toBe(1);
  });

  test('performance.now() alone is enough with the date set back', async ({ page, wvw }) => {
    await arm(page, wvw);
    await page.clock.fastForward(STEP - 1500);
    await wvw.skew(-2 * HOUR);
    expect(await back(page), 'performance.now() 298.5 s on, the date 2 h behind').toBe(0);
    await page.clock.fastForward(1000);
    expect(await back(page), 'performance.now() 299.5 s on, the date 2 h behind').toBe(1);
  });

  test('a date set back alone never reads', async ({ page, wvw }) => {
    await arm(page, wvw);
    await hidden(page, wvw, -2 * HOUR);
    await visible(page);
    expect(await reads(page), 'a negative elapsed on the date, none on performance.now()').toBe(0);
  });

  test('a skipped run hands back both clocks', async ({ page, wvw }) => {
    await arm(page, wvw);
    await wvw.skew(2 * HOUR);
    await page.evaluate(() => { globalThis.__answer = false; });
    expect(await back(page), 'the sleep return, the work skipped').toBe(1);
    expect(await back(page), 'tried again at once: the date stamp went back').toBe(2);
    await page.evaluate(() => { globalThis.__answer = undefined; });
    expect(await back(page), 'the work done this time').toBe(3);
    expect(await back(page), 'and counted: nothing more at once').toBe(3);
  });

  test('a skipped run on performance.now() alone hands back its clock', async ({ page, wvw }) => {
    await arm(page, wvw);
    await page.clock.fastForward(STEP - 500);
    await wvw.skew(-2 * HOUR);
    await page.evaluate(() => { globalThis.__answer = false; });
    expect(await back(page), 'performance.now() past the interval, the work skipped').toBe(1);
    expect(await back(page), 'tried again at once: the performance.now() stamp went back').toBe(2);
  });
});
