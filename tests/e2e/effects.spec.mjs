// The glows that flash or beat when something happens (the urgent and lockout
// bars, a new score, a guild found) are painted once and only their opacity
// moves, so no frame repaints them. Each state is brought up and every running
// CSS animation, one-shot or looping, is read: none may move a property the
// compositor cannot run alone. paint.spec.mjs holds the looping ones at rest;
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
// The strip's own entrance and exit still move its height.
const NOT_YET = ['guild-found-in', 'guild-found-out'];

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });

// One read of everything running: the names, and name -> the properties off the
// compositor that its keyframes move. One read, so none can end between two looks.
const look = page => page.evaluate(([ok, skip, later]) => {
  const names = new Set(), off = {};
  for (const a of document.getAnimations()) {
    if (!a.animationName || !a.effect) continue;
    names.add(a.animationName);
    if (later.includes(a.animationName)) continue;
    const bad = new Set();
    for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!skip.includes(p) && !ok.includes(p)) bad.add(p);
    if (bad.size) off[a.animationName] = [...bad].sort();
  }
  return { names: [...names], off };
}, [COMPOSITABLE, NOT_PROPERTIES, NOT_YET]);

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
