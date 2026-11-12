// The glows that flash or beat when something happens (the urgent and lockout
// bars, a new score, a guild found) are painted once and only their opacity
// moves, so no frame repaints them. Each state is brought up and every running
// CSS animation, one-shot or looping, is read: none may move a property the
// compositor cannot run alone (the guild strip's clip-path, named in its own test, is the
// one exception). paint.spec.mjs holds the looping ones at rest;
// this one reaches the states it never sees.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { FOCUS, HOUR, MIN } from './support/scenarios.mjs';
import { load, recordedJson, serveList, iso } from './support/steps.mjs';

const GAME = 'https://api.guildwars2.com/v2/';
const DAY = 24 * HOUR;
const S = 45 * 1000;
const COMPOSITABLE = ['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdropFilter'];
const NOT_PROPERTIES = ['offset', 'easing', 'composite', 'computedOffset'];

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });

// One read of everything running: the names, and name -> the properties off the
// compositor that its keyframes move. One read, so none can end between two looks.
const look = page => page.evaluate(([ok, skip]) => {
  const names = new Set(), off = {};
  for (const a of document.getAnimations()) {
    if (!a.animationName || !a.effect) continue;
    names.add(a.animationName);
    const bad = new Set();
    for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!skip.includes(p) && !ok.includes(p)) bad.add(p);
    if (bad.size) off[a.animationName] = [...bad].sort();
  }
  return { names: [...names], off };
}, [COMPOSITABLE, NOT_PROPERTIES]);

// A relink bar inside its window: `lockout` and `na` are milliseconds from the page's opening.
async function bar(page, wvw, { lockout, na }) {
  const at = ms => iso(wvw.opensAt + ms);
  const list = recordedJson(GAME + 'wvw/matches?ids=all').map(m => ({ ...m, start_time: at(-2 * DAY), end_time: at(na) }));
  await serveList(page, list);
  await answer(page, GAME + 'wvw/timers/lockout', { na: at(lockout), eu: at(lockout) });
  await answer(page, GAME + 'wvw/timers/teamAssignment', { na: at(10 * DAY), eu: at(10 * DAY) });
  await page.goto(wvw.url);
  await expect(page.locator('#relinkBanner')).toBeVisible();
  await wvw.settle();
}

test('the urgent bar beats on the compositor', async ({ page, wvw }) => {
  await bar(page, wvw, { lockout: 6 * DAY, na: HOUR + 50 * MIN + S });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-urgent/);
  const { names, off } = await look(page);
  expect(names, 'the beat is running').toContain('urgent-pulse');
  expect(off).toEqual({});
});

test('the lockout bar beats on the compositor', async ({ page, wvw }) => {
  await bar(page, wvw, { lockout: 2 * DAY + 5 * HOUR + S, na: 3 * DAY });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-lockout/);
  const { names, off } = await look(page);
  expect(names, 'the beat is running').toContain('lockout-pulse');
  expect(off).toEqual({});
});

test('a new score and a guild found flash on the compositor', async ({ page, wvw }) => {
  await load(page, wvw);
  const list = await page.evaluate(() => [...matchDataCache.values()].map(m => JSON.parse(JSON.stringify(m))));
  const focus = list.find(m => m.id === FOCUS);
  for (const c of ['red', 'blue', 'green']) focus.victory_points[c] = Number(focus.victory_points[c]) + 1;
  await page.evaluate(id => showGuildFound(matchTeamId(matchDataCache.get(id), 'red'), 'Found Guild'), FOCUS);
  await serveList(page, list);
  await page.evaluate(() => loadStandings());
  const { names, off } = await look(page);
  for (const n of ['value-flash', 'side-pulse', 'guild-found-flash']) expect(names, `${n} is running`).toContain(n);
  expect(off).toEqual({});
});

// The strip's clip-path animations, by exact name, are the one thing off the COMPOSITABLE list:
// they change no layout, and Chrome composites a clip-path animation only when nothing else
// shares it, so each stays apart from its fade.
const offList = samples => {
  const off = {};
  for (const { props } of samples) for (const [name, ...ps] of props) {
    const bad = ps.filter(p => !NOT_PROPERTIES.includes(p) && !COMPOSITABLE.includes(p));
    if (bad.length) off[name] = bad;
  }
  return off;
};

// The strip takes its room at once and is uncovered by clip-path: its height is
// the final one from the first frame and the cards below jump, they do not slide.
test('the guild strip opens and closes without moving its height', async ({ page, wvw }) => {
  await load(page, wvw);
  await page.evaluate(id => {
    window.__h = [];
    const tick = () => {
      const s = document.querySelector('.guild-found-strip');
      if (s) window.__h.push({ h: s.getBoundingClientRect().height, leaving: s.classList.contains('is-leaving'), anim: s.getAnimations().map(a => a.animationName),
        props: s.getAnimations().map(a => [a.animationName, ...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k)))]) });
      window.__raf = requestAnimationFrame(tick);
    };
    tick();
    showGuildFound(matchTeamId(matchDataCache.get(id), 'red'), 'Found Guild');
  }, FOCUS);
  await expect(page.locator('.guild-found-strip')).toBeVisible();
  await page.waitForTimeout(3000);
  const open = await page.evaluate(() => window.__h.filter(x => !x.leaving));
  expect(open.length, 'sampled while open').toBeGreaterThan(20);
  expect(open.some(x => x.anim.includes('guild-found-in-clip')), 'the entrance ran').toBe(true);
  expect(new Set(open.map(x => x.h)).size, `one height: ${[...new Set(open.map(x => x.h))]}`).toBe(1);
  expect(open[0].h).toBeGreaterThan(15);
  expect(offList(open), 'the entrance: only the clip animation is off the list').toEqual({ 'guild-found-in-clip': ['clipPath'] });
  // The exit: the room stays until the strip is removed.
  await page.evaluate(() => { window.__h = []; document.querySelector('.guild-found-strip').classList.add('is-leaving'); });
  await page.waitForTimeout(250);
  const leaving = await page.evaluate(() => window.__h);
  expect(leaving.some(x => x.anim.includes('guild-found-out-clip')), 'the exit ran').toBe(true);
  expect(new Set(leaving.map(x => x.h)).size, 'the exit keeps its height').toBe(1);
  expect(leaving[0].h).toBe(open[0].h);
  expect(offList(leaving), 'the exit: only the clip animation is off the list').toEqual({ 'guild-found-out-clip': ['clipPath'] });
});
