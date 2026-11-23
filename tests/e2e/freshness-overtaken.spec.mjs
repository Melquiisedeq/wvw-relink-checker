import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { firstTier, frame, load, openMap } from './support/steps.mjs';
import { keptBody, keptMatch } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

const POP = '.info-popover';

// ---- an answer that arrives after a newer read was asked -----------------------
// The map asks again every 30 s and when the tab is back. A read held on the
// way (a slow line) is overtaken by the next one; when it lands at last, the
// map keeps what the newer read painted. The held read's body is the further
// along one (a server ahead of the others) and hands Red every camp, tower and
// keep of the map in view, so a map that painted it would show Red's share of
// the bar over the map grow past what the newer read drew.
test('a read overtaken on the way is dropped when it lands', async ({ page, wvw }) => {
  await load(page, wvw);
  const tier = await firstTier(page);
  const body = await keptMatch(page, tier.id);
  await openMap(page, wvw, tier.button);
  const type = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
  const bent = flips => {
    const b = JSON.parse(JSON.stringify(body));
    const objectives = b.maps.find(m => m.type === type).objectives.filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && o.owner !== 'Red');
    for (const o of objectives.slice(0, flips)) o.owner = 'Red';
    b.scores.red += flips;
    b.flipped = objectives.slice(0, flips).map(o => o.id);
    return b;
  };
  const newer = bent(1), further = bent(1000);
  // Taken by the held body alone: the tick rings it as changed hands, though nothing else of that body is painted.
  const ringed = further.flipped.filter(id => !newer.flipped.includes(id)).pop();
  const red = () => page.evaluate(() => parseFloat(document.querySelector('.info-popover .wvw-scorebar-seg.own-red').style.width));
  const before = await red();

  let reads = 0, release;
  const held = new Promise(r => { release = r; });
  const reply = (route, b) => route.fulfill({ status: 200, body: JSON.stringify(b),
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  await page.route(tier.url, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (++reads === 1) { await held; return reply(route, further); }
    return reply(route, newer);
  });
  const catchUp = async () => {
    await wvw.skew(31000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  };
  await catchUp();
  await expect.poll(() => reads, { message: 'the first read, held' }).toBe(1);
  await catchUp();
  await expect.poll(() => red(), { message: 'the bar after the newer read' }).toBeGreaterThan(before);
  const drawn = await red();
  release();
  await expect.poll(() => keptBody(page, tier.id).then(b => b.scores.red),
    { message: 'the held read landed (the page keeps the further body)' }).toBe(further.scores.red);
  await frame(page);
  expect(await red(), 'the red share of the bar after the held read landed').toBe(drawn);
  await expect(page.locator(`${POP} .wvw-marker[data-obj="${ringed}"] .wvw-ring`), 'the ring on an objective only the held body took').toBeAttached();
  expect(await red(), 'the red share of the bar after the ring').toBe(drawn);
  await wvw.settle();
});
