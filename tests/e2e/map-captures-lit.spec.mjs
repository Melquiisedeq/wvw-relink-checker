import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { firstTier, later, load, openMap } from './support/steps.mjs';
import { keptMatch } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// The page's clock stops a moment ahead, and only runFor moves it from there. It runs by
// itself until then, so the instant asked for may already be behind it: asked again, further on.
async function pause(page, wvw) {
  for (let ahead = 100; ; ahead *= 2) {
    try { return await page.clock.pauseAt(await wvw.now() + ahead); }
    catch (e) { if (!/past/.test(String(e)) || ahead > 5000) throw e; }
  }
}

// ---- the map's lit objective ---------------------------------------------------
const POP = '.info-popover';
const LIT = `${POP} .wvw-marker.is-lit`;
const lit = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(m => m.dataset.obj).join(), LIT);

// The first tier's map open on its Captures tab, and the capture rows of the map in view.
async function onCaptures(page, wvw) {
  await load(page, wvw);
  const tier = await firstTier(page);
  await openMap(page, wvw, tier.button);
  await page.locator(`${POP} .wvw-subtab[data-pane="captures"]`).click();
  const home = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
  const row = page.locator(`${POP} .wvw-cap[data-map="${home}"]`).first();
  await expect(row, 'a capture on the map in view').toBeAttached();
  return { tier, row, id: await row.getAttribute('data-obj') };
}

test.describe('a capture pressed', () => {
  test.use({ clock: 'playwright' });

  test('lights its objective for 2.5 s, then the light goes out by itself', async ({ page, wvw }) => {
    const { row, id } = await onCaptures(page, wvw);
    await pause(page, wvw);
    await row.click();
    await expect.poll(() => lit(page), { message: `${id} lit by its capture` }).toBe(id);
    await page.mouse.move(1, 1);
    await page.clock.runFor(2000);
    expect(await lit(page), 'lit 2 s after the press').toBe(id);
    await page.clock.runFor(700);
    expect(await lit(page), 'lit 2.7 s after the press').toBe('');
  });
});

// A row pointed at lights its objective for as long as it is pointed at. When
// the list is rebuilt under the pointer (a capture came in) the old row is gone
// and never says it was left: the light must not stay on for a row that is not
// there. The pointer is the page's own event, from a mouse parked away from the
// popover, so that no real move lights the new rows again.
test('a capture row rebuilt under the pointer takes its light with it', async ({ page, wvw }) => {
  const { tier, row, id } = await onCaptures(page, wvw);
  await page.mouse.move(1, 1);
  const pointed = await row.elementHandle();
  await pointed.evaluate(el => el.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })));
  expect(await lit(page), 'lit while the row is pointed at').toBe(id);
  // A body with one more capture, newer than all: the list is rebuilt.
  const body = await keptMatch(page, tier.id);
  const flip = body.maps.flatMap(m => m.objectives).find(o => /^\d+-\d+$/.test(o.id) && ['Camp', 'Tower', 'Keep'].includes(o.type) && o.id !== id);
  const newest = Math.max(...body.maps.flatMap(m => m.objectives).map(o => Date.parse(o.last_flipped) || 0));
  flip.owner = flip.owner === 'Red' ? 'Blue' : 'Red';
  flip.last_flipped = new Date(newest + 60000).toISOString().replace('.000Z', 'Z');
  body.scores.red += 1;
  await answer(page, tier.url, body);
  await later(page, wvw, 31000);
  await expect(page.locator(`${POP} .wvw-cap[data-obj="${flip.id}"]`), 'the new capture on the list').toBeAttached();
  expect(await pointed.evaluate(el => el.isConnected), 'the pointed row still in the page').toBe(false);
  expect(await lit(page), 'lit after the list was rebuilt').toBe('');
});
