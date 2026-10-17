// The two corners over a tier's map, and the skirmish trend, on states of time
// and of the data's clock the page is put in. The clock is the fixture's shim, jumped with
// wvw.skew; the page's kept bodies, the kill history and the score time are
// planted in the page, and the match is served back so nothing replaces them.
//
// Each test opens a new page and asks of the game only what the recording
// holds: the tier's match (?id=), the lists, and the guild tactics, which the
// recording answers one by one in any order (support/recordings.mjs). A read it
// cannot answer fails the test, naming the address.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { phone, recordedJson, load, firstTier, openMap, later } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

const GAME = 'https://api.guildwars2.com/v2/wvw/matches?id=';
const hud = sel => `.info-popover .wvw-plot-wrap ${sel}`;

const touchAction = page => page.evaluate(() => getComputedStyle(document.querySelector('.info-popover .wvw-plot-wrap')).touchAction);

test.describe('map corners', () => {
  test('opens as "data from", not amber nor spoken; the kills match the hot tab', async ({ page, wvw }) => {
    await load(page, wvw);
    const badged = page.locator('.tier-map-btn:has(.tier-map-badge)').first();
    await expect(badged, 'a tier button carrying the swords badge').toBeAttached();
    const busiest = /busiest: (.+)$/.exec(await badged.getAttribute('aria-label'))?.[1] || '';
    // The standings' score time made old before the map opens: the corner must
    // not show it. An observer notes any amber or spoken turn from the start.
    await page.evaluate(() => {
      __skewClock(100000); window.__amber = false;
      new MutationObserver(() => {
        if (document.querySelector('.wvw-hud-ago.is-stale') || document.querySelector('.wvw-hud-live')?.textContent) window.__amber = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await openMap(page, wvw, badged);
    await expect(page.locator(hud('.wvw-hud-r'))).toBeVisible();
    await expect(page.locator(hud('.wvw-hud-ago')), 'the corner starts with "data from"').toHaveText(/^data from \d/);
    await wvw.settle();
    expect(await page.evaluate(() => window.__amber), 'the corner went amber, or spoke, on opening').toBe(false);
    await expect(page.locator(hud('.wvw-hud-live'))).toHaveText('');
    await expect(page.locator(hud('.wvw-hud-ago.is-stale')), 'amber after the opening read').toHaveCount(0);

    const hot = page.locator('.info-popover .wvw-tab.is-hot');
    await expect(hot, `the button says busiest "${busiest}"`).toHaveText(busiest);
    const hotTab = { type: await hot.getAttribute('data-type'), title: await hot.getAttribute('title') };
    await page.locator(`.info-popover .wvw-tab[data-type="${hotTab.type}"]`).click();
    await expect(page.locator(hud('.wvw-hud-l'))).toBeVisible();
    const kills = await page.locator(hud('.wvw-hud-big')).textContent();
    expect(hotTab.title, `the corner says ${kills} kills`).toContain(` ${kills} kills `);
    await expect(page.locator(hud('.wvw-hud-l.is-cold')), 'swords neutral on the hot tab').toHaveCount(0);

    const cold = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-tab')].find(t => !t.classList.contains('is-hot'))?.dataset.type);
    expect(cold, 'a tab without swords').toBeTruthy();
    await page.locator(`.info-popover .wvw-tab[data-type="${cold}"]`).click();
    await expect(page.locator(hud('.wvw-hud-l.is-cold')), 'the kills corner, neutral, on a tab without swords').toBeVisible();
    // With a hot tab there are rates, so a number. Never a bare 0 from no measurement.
    const big = await page.locator(hud('.wvw-hud-big')).textContent();
    expect(big).toMatch(/^\d+$/);
    // A number always carries the minutes it was counted over.
    const small = await page.locator(hud('.wvw-hud-small')).first().innerText();
    expect(small, `"${big}" with "${small}", a count with no window`).toMatch(/^kills (· \d+ min|in \d+ min)$/);
  });

  test('the same body for 400 s turns it amber; a higher score brings it back', async ({ page, wvw }) => {
    await load(page, wvw);
    const badged = await firstTier(page, page.locator('.tier-map-btn:has(.tier-map-badge)').first());
    const url = GAME + badged.id;
    const one = recordedJson(url);
    await openMap(page, wvw, badged.button);
    await expect(page.locator(hud('.wvw-hud-r'))).toBeVisible();
    // A frozen API: the recorded body answered again on every pull for 400 s
    // more. Each answer arrives; none is new data.
    const same = await answer(page, url, one);
    for (let i = 0; i < 4; i++) await later(page, wvw, 100000);
    expect(same.reads, 'pulls of the map over 400 s').toBeGreaterThanOrEqual(4);
    await expect(page.locator(hud('.wvw-hud-ago.is-stale')), 'amber after 6 min of the same body').toHaveText(/^⚠ data from \d/);
    await expect(page.locator(hud('.wvw-hud-live'))).toContainText('No new map data for');
    // Stale data claims no fight: no swords on a tab, and the kills corner is
    // neutral - a dash with only "kills", or the last count dimmed over
    // "⚠ data up to HH:MM" (never a bare 0 from no window).
    await expect(page.locator('.info-popover .wvw-tab.is-hot'), 'swords on stale data').toHaveCount(0);
    const frozen = await page.evaluate(() => {
      const q = s => document.querySelector('.info-popover .wvw-plot-wrap ' + s);
      const l = q('.wvw-hud-l'), s2 = q('.wvw-hud-small2');
      return { shown: !!l && !!l.offsetParent, cold: !!q('.wvw-hud-l.is-cold'), dim: !!q('.wvw-hud-l.is-dim'),
        big: q('.wvw-hud-big').textContent, small: q('.wvw-hud-small').innerText,
        line2: s2?.hidden === false ? s2.textContent : '', when: q('.wvw-hud-small2 time')?.dateTime || '' };
    });
    const dash = frozen.big === '–' && frozen.small === 'kills' && !frozen.dim;
    const dimmed = /^\d+$/.test(frozen.big) && /^kills in \d+ min$/.test(frozen.small) && /^⚠\sdata up to \S+( \S+)?$/.test(frozen.line2)
      && frozen.dim && Number.isFinite(Date.parse(frozen.when));
    expect(frozen.shown && frozen.cold && (dash || dimmed), `the kills corner reads ${JSON.stringify(frozen)}`).toBe(true);
    same.off();
    // The score one point up: new data, the corner back to a plain "data from".
    await answer(page, url, { ...one, scores: { ...one.scores, red: (Number(one.scores?.red) || 0) + 1 } });
    await later(page, wvw, 31000);
    await expect(page.locator(hud('.wvw-hud-ago')), '"data from" unmarked again on a higher score').toHaveText(/^data from \d/);
    await expect(page.locator(hud('.wvw-hud-ago.is-stale'))).toHaveCount(0);
    await expect(page.locator(hud('.wvw-hud-live'))).toContainText('New map data again');
  });

  test('zoom hides the corners and "home" shows them; a swipe scrolls the page, a drag moves the map', async ({ page, wvw }) => {
    await load(page, wvw);
    await openMap(page, wvw, page.locator('.tier-map-btn').first());
    await expect(page.locator(hud('.wvw-hud-r'))).toBeVisible();
    expect(await touchAction(page), 'the whole map: a swipe must scroll the page').toBe('pan-y');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.info-popover')).overscrollBehaviorY)).toBe('contain');
    await page.locator('.info-popover .wvw-zoom button').first().click();
    await expect(page.locator(hud('.wvw-hud-r')), 'corners hidden while zoomed').toBeHidden();
    expect(await touchAction(page), 'the zoomed map: the drag moves the map').toBe('none');
    await page.locator('.info-popover .wvw-zoom button:last-child').click();
    await expect(page.locator(hud('.wvw-hud-r')), 'corners back after "home"').toBeVisible();
    expect(await touchAction(page)).toBe('pan-y');
  });
});

// The kill history says a match stopped before this page ever saw it move:
// the corner opens amber with a dash. With every line old the history is not
// trusted and nothing turns amber. A score up clears it. Only /api/kills is
// swapped; the kept matches are put as a first sight with no rise.
test.describe('history ages first sight', () => {
  const reset = async (page, wvw, id, ageOfTarget, ageOfOthers) => {
    const rows = await page.evaluate(([target, a, b]) => [...newestMatches.keys()].map(k => [Date.now() - (k === target ? a : b), k, 5, 5, 5, 5]), [id, ageOfTarget, ageOfOthers]);
    await answer(page, wvw.url + 'api/kills', { rows });
    await page.evaluate(async () => {
      for (const k of newestMatches.values()) { k.rose = false; k.at = Date.now(); }
      killSheetAt = 0;
      await getKillSheet();
    });
  };
  const kept = (page, id) => page.evaluate(k => Date.now() - newestMatches.get(k).at, id);

  test('a newest line 7 min old opens amber with a dash; a score up clears it', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    await reset(page, wvw, tier.id, 7 * 60000, 60000);
    expect(await kept(page, tier.id), 'the match backdated by a live history').toBeGreaterThanOrEqual(6 * 60000);
    await openMap(page, wvw, tier.button);
    await expect(page.locator(hud('.wvw-hud-ago')), 'the corner opens amber').toHaveText(/^⚠ data from /);
    await expect(page.locator(hud('.wvw-hud-ago.is-stale'))).toBeAttached();
    await expect(page.locator(hud('.wvw-hud-big')), 'the kills corner is a dash on opening').toHaveText('–');
    // The score up, on the kept body: back to a plain "data from".
    const bumped = await page.evaluate(id => { const m = JSON.parse(JSON.stringify(newestMatches.get(id).match));
      m.scores.red = (Number(m.scores.red) || 0) + 1; return m; }, tier.id);
    await answer(page, GAME + tier.id, bumped);
    await later(page, wvw, 31000);
    await expect(page.locator(hud('.wvw-hud-ago'))).toHaveText(/^data from \d/);
    await expect(page.locator(hud('.wvw-hud-ago.is-stale'))).toHaveCount(0);
  });

  test('a history of lines all 30 min old is not trusted: nothing turns amber', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    await reset(page, wvw, tier.id, 30 * 60000, 30 * 60000);
    expect(await kept(page, tier.id), "a history with every line old moved the match's time").toBeLessThanOrEqual(60000);
    await openMap(page, wvw, tier.button);
    await expect(page.locator(hud('.wvw-hud-ago'))).toHaveText(/^data from /);
    await expect(page.locator(hud('.wvw-hud-ago.is-stale'))).toHaveCount(0);
  });
});

// The map's two corners by the data's clock: the kills window is the reading
// nearest to 10 min before the kills' own clock, 8 to 15 min back or a dash;
// old kills take two lines ("data up to" when the API is behind, "no new
// kills since" on a quiet map); a jump after the kills stood still lights no
// swords and says so; the right corner says "data from HH:MM" in the viewer's
// time zone. Times are in ms before now. `top`: when the kills reached their
// newest total (+`add` on Center), `base`: how far before that the other
// reading is, `still`: a reading between the two with the older total, `rose`:
// how long ago the score last rose, `startAgo`: the week's start.
test.describe('corners by the data clock', () => {
  test.use({ timezoneId: 'America/Sao_Paulo' });
  const scenarios = {
    nine: { top: 20e3, base: 9 * 60e3, add: 70, rose: 0 },
    twenty: { top: 20e3, base: 20 * 60e3, add: 200, rose: 0 },
    gap: { top: 20e3, base: 65 * 60e3, add: 700, rose: 0 },
    gapLate: { top: 40 * 60e3, base: 65 * 60e3, add: 700, rose: 40 * 60e3 },
    gapQuiet: { top: 8 * 60e3, base: 65 * 60e3, add: 30, rose: 0 },
    late: { top: 40 * 60e3, base: 10 * 60e3, add: 70, rose: 40 * 60e3 },
    quiet: { top: 8 * 60e3, base: 10 * 60e3, add: 30, rose: 0 },
    jumpOn: { top: 20e3, base: 15 * 60e3, add: 155, rose: 0, still: 5 * 60e3 },
    jumpLong: { top: 20e3, base: 25 * 60e3, add: 155, rose: 0, still: 5 * 60e3 },
    jumpSmall: { top: 20e3, base: 12 * 60e3, add: 30, rose: 0, still: 5 * 60e3 },
    reset: { none: true, startAgo: 12 * 60e3 },
    nodata: { none: true },
  };

  // The history and the score time planted in the page, the kept body served back.
  const plant = async (page, id, sc) => {
    const body = await page.evaluate(([id, sc]) => {
      localStorage.removeItem('wvw-fight-v1');
      const now = Date.now();
      const k = newestMatches.get(id);
      const T = fightTotals(k.match);
      const row = (age, bonus) => ({ at: now - age, n: Object.fromEntries(KILLS_MAP_ORDER.map(ty => [ty, (T[ty] || 0) + (ty === 'Center' ? bonus : 0)])) });
      const list = [];
      if (!sc.none) {
        list.push(row(sc.top + sc.base, 0));
        if (sc.still) list.push(row(sc.top + sc.still, 0));
        list.push(row(sc.top, sc.add));
      }
      killSheet = new Map([[id, list]]);
      killSheetAt = now;
      k.rose = true;
      k.at = now - (sc.rose || 0);
      k.match.start_time = new Date(now - (sc.startAgo || 4 * 86400e3)).toISOString();
      return k.match;
    }, [id, sc]);
    return body;
  };
  const corner = page => page.evaluate(() => {
    const q = s => document.querySelector('.info-popover .wvw-plot-wrap ' + s);
    const s2 = q('.wvw-hud-small2');
    return { big: q('.wvw-hud-big')?.textContent || '', small: q('.wvw-hud-small').innerText,
      two: !!s2 && !s2.hidden, line2: s2?.hidden === false ? s2.textContent : '',
      dim: !!q('.wvw-hud-l.is-dim'), cold: !!q('.wvw-hud-l.is-cold'),
      swords: !!document.querySelector('.info-popover .wvw-tab.is-hot'), right: q('.wvw-hud-ago')?.textContent || '',
      when: q('.wvw-hud-ago')?.dateTime || '' };
  });
  // The balloon of a corner, opened by a tap and closed again.
  const balloon = async (page, side) => {
    const btn = page.locator(`.info-popover .wvw-hud-${side} .wvw-hud-btn`);
    await btn.click();
    const said = await page.locator('.info-popover .wvw-hud-note').textContent();
    await btn.click();
    return said;
  };

  for (const name of Object.keys(scenarios)) {
    test(name, async ({ page, wvw }) => {
      await load(page, wvw);
      const tier = await firstTier(page);
      await answer(page, GAME + tier.id, await plant(page, tier.id, scenarios[name]));
      await openMap(page, wvw, tier.button);
      await page.locator('.info-popover .wvw-tab[data-type="Center"]').click();
      await expect(page.locator(hud('.wvw-hud-l'))).toBeVisible();
      await expect(page.locator(hud('.wvw-hud-r'))).toBeVisible();
      const c = await corner(page);
      const bad = (ok, what) => expect(ok, `${what}, the corner reads ${JSON.stringify(c)}`).toBe(true);
      const num = /^\d+$/.test(c.big);
      if (name === 'nine') {
        // A reading 9 min back is a window: the minutes are the real ones, one line.
        bad(num && c.small === 'kills · 9 min' && !c.two && !c.cold && c.swords, 'a base 9 min back should count, on one line, with swords');
        // The right corner: the viewer's own time zone, and the balloon starts with the last check.
        const want = await page.evaluate(w => new Date(w).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), c.when);
        expect(c.right, 'the right corner').toBe(`data from ${want}`);
        bad(await page.evaluate(w => new Date(w).getUTCHours() !== new Date(w).getHours(), c.when), "the time is not in the viewer's zone (the same hour as UTC)");
        const tip = await balloon(page, 'r');
        expect(tip, 'the right balloon').toMatch(/^Checked \d+ (s|min) ago: this page asks the game's API every 30 s\. Data from /);
        expect(tip).toContain(`Data from ${want}:`);
      }
      // No reading 8 to 15 min back: the newest one at least 10 min back, the real span in two lines, no swords.
      if (['twenty', 'gap', 'gapLate', 'gapQuiet'].includes(name)) {
        const mins = name === 'twenty' ? 20 : 65;
        const late = name === 'gapLate';
        const lead = name === 'gapQuiet' ? 'no new kills since' : 'data up to';
        bad(num && c.small === `kills in ${mins} min` && c.two && c.dim === late
          && new RegExp(`^${late ? '\\u26a0\\s' : ''}${lead} \\S+( \\S+)?$`).test(c.line2),
        `a base ${mins} min back should take two lines, "kills in ${mins} min" over "${late ? '⚠ ' : ''}${lead} HH:MM"`);
        bad(!c.swords, 'a window over 15 min should light no swords');
        expect(await balloon(page, 'l'), "the long window's balloon")
          .toMatch(/ The window is longer than 10 minutes because the game's API stopped sending data between \S+( \S+)? and \S+( \S+)?\./);
      }
      if (name === 'late') {
        bad(num && c.small === 'kills in 10 min' && c.two && c.dim && /^⚠\sdata up to \S+( \S+)?$/.test(c.line2), 'stalled data should take two lines, "kills in 10 min" over "⚠ data up to HH:MM", dimmed');
        bad(/^⚠ data from /.test(c.right), 'the right corner should carry the warning sign past 6 min');
        bad(!c.swords, 'a stalled match should light no swords');
      }
      if (name === 'quiet') {
        bad(num && c.small === 'kills in 10 min' && c.two && !c.dim && /^no new kills since \S+( \S+)?$/.test(c.line2), 'a quiet map should take two lines, "kills in 10 min" over "no new kills since HH:MM", not dimmed');
        bad(!/^⚠/.test(c.right), 'a quiet map with a fresh score should not warn on the right');
      }
      // A jump after a stall: the swords light when the stall was at most 20 min and the kills spread over it
      // still make 50 per 10 min; otherwise not, and the balloon says why.
      if (name === 'jumpOn') bad(c.swords && !c.cold && num, '155 kills after a 15 min stall should light the swords');
      if (name === 'jumpLong' || name === 'jumpSmall') {
        bad(!c.swords, name === 'jumpLong' ? 'a jump after a 25 min stall should light no swords' : '30 kills after 12 min should light no swords');
        const mins = name === 'jumpLong' ? 25 : 12;
        expect(await balloon(page, 'l'), 'the balloon says why there are no swords')
          .toMatch(new RegExp(` The last jump came after the game's API sent nothing for ${mins} min, so when those kills happened is unknown; it lights no swords\\.$`));
      }
      if (name === 'reset' || name === 'nodata') {
        bad(c.big === '–' && c.small === 'kills', 'no reading should give a dash');
        const tip = await balloon(page, 'l');
        if (name === 'reset') expect(tip).toMatch(/^Counting starts about 10 minutes after the reset: /);
        else expect(tip).toBe('Not enough kill data to count 10 minutes.');
      }
      // The same states on a phone: nothing past the corners' room either side of the score bar.
      if (['late', 'quiet', 'nine', 'gap'].includes(name)) {
        for (const width of [390, 320]) {
          const cdp = await phone(page, width, { exact: false });
          await wvw.settle();
          const room = await page.evaluate(() => {
            const r = s => { const e = document.querySelector('.info-popover .wvw-plot-wrap ' + s); return e && e.offsetParent ? e.getBoundingClientRect() : null; };
            const l = r('.wvw-hud-l .wvw-hud-btn'), rt = r('.wvw-hud-r .wvw-hud-btn'), bar = r('.wvw-scorebar');
            return { left: l && bar ? Math.round(l.right - bar.left) : null, right: rt && bar ? Math.round(bar.right - rt.left) : null,
              page: document.documentElement.scrollWidth - innerWidth };
          });
          expect(room.left !== null && room.right !== null, `${width} px: a corner or the score bar is missing`).toBe(true);
          expect(room.left <= 0 && room.right <= 0 && room.page <= 0,
            `${width} px: a corner reaches ${room.left}px / ${room.right}px into the score bar, the page spills ${room.page}px`).toBe(true);
          await cdp.send('Emulation.clearDeviceMetricsOverride');
        }
      }
    });
  }
});

// The skirmish trend when the clock is a block ahead of the body. Built from a
// kept match: 63 whole blocks of 1,000 and a 64th of 400, the clock 30 min
// into block 65. Body time before the end of block 64 (the API froze
// mid-block): 400 is not "Last block", the average ignores it and the text
// says the data stopped. Body time after it: 400 is a finished block, as before.
test('skirmish trend stalled: a block cut off midway is not the last block', async ({ page, wvw }) => {
  await load(page, wvw);
  const out = await page.evaluate(() => {
    const id = [...newestMatches.keys()][0];
    const kept = newestMatches.get(id);
    const keptAt = kept.at;
    const H = 3600000;
    const start = Date.now() - (128 * H + 0.5 * H);
    const lastEnd = start + 128 * H;
    const sk = n => ({ scores: { red: n, blue: n, green: n } });
    const match = { id, start_time: new Date(start).toISOString(), end_time: new Date(start + 168 * H).toISOString(),
      skirmishes: [...Array(63).fill(1000), 400].map(sk) };
    const render = at => {
      kept.at = at;
      const el = document.createElement('div');
      renderSkirmishTrendPopoverContent(el, 'X', match, 'red');
      return el.textContent;
    };
    try { return { stalled: render(lastEnd - 40 * 60000), current: render(lastEnd + 5 * 60000) }; } finally { kept.at = keptAt; }
  });
  expect(out.stalled, 'a block cut off midway').not.toMatch(/Last block\s*400/);
  expect(out.stalled).toMatch(/Last block\s*1,000/);
  expect(out.stalled, 'the finished count').toMatch(/63 of 84 finished/);
  expect(out.stalled, 'the text says the data stopped').toMatch(/stopped partway through block 64/);
  expect(out.stalled).not.toMatch(/ArenaNet hasn't published/);
  expect(out.current, 'a body past the end of block 64 shows it finished').toMatch(/Last block\s*400/);
  expect(out.current).toMatch(/64 of 84 finished/);
  expect(out.current).not.toMatch(/stopped partway/);
});
