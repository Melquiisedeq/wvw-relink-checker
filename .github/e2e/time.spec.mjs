// Time: one state per row, each from a new page, against the same invariants.
//
//   state                                  how
//   API frozen 40 min, then back           frozen(40), the map opened four times
//   two server groups alternating          twoPools(10, 30)
//   reload, one group behind               firstReadBehind(10, 30) and twoPools(10, 30), reload()
//   tab hidden 2 h, then back              missed(120, 6), hidden() / visible()
//   laptop waking after 30 min             playing(40), wake(): every due timer once
//   map open while the API is down         apiDown(12), the map never closed
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
import { FOCUS, HOUR, MIN, apiDown, firstReadBehind, frozen, hidden, missed, playing, twoPools, visible, wake } from './support/scenarios.mjs';

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
  test.describe('a re-read reaches the newer group', () => {
    test.use({ timeline: firstReadBehind(10, 30) });
    test('nothing goes back', async ({ page, wvw }) => {
      const r = rower(page, wvw);
      await r.load();
      await r.pass(8, 4, 'alternating');
      await r.peek('before 8 min');
      await r.pass(8, 4, 'alternating');
      await r.peek('before 16 min');
      await r.reload();
      const t = await wvw.now() - wvw.recordedAt;
      expect(Math.floor(t / MIN) % 2, 'the state: the older group answering').toBe(1);
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
