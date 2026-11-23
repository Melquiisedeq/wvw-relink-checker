import { test, expect } from './support/fixtures.mjs';
import { abort, answer } from './support/faults.mjs';
import { firstTier, later, load, openMap } from './support/steps.mjs';
import { emblemLayerCount, forgetEmblems, upgradeLines } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

// The upgrade catalogue failing once does not blank the tier shields for the session: the next opening asks again.
test('a failed upgrade catalogue is asked for again on the next opening', async ({ page, wvw }) => {
  const down = await abort(page, wvw, /\/v2\/wvw\/upgrades/);
  await load(page, wvw);
  const tier = await firstTier(page);
  await openMap(page, wvw, tier.button);
  await expect.poll(() => down.reads, 'the first opening tried the catalogue and its retries').toBe(3);
  await wvw.settle();
  expect(await upgradeLines(page), 'the failed opening has no upgrade lines').toBe(0);
  await page.locator('.info-popover .info-popover-close').click();
  await expect(page.locator('.info-popover')).toHaveCount(0);
  down.off();
  await openMap(page, wvw, tier.button);
  const tiers = () => page.$$eval('.info-popover .wvw-plot g[role="button"] > title', t => t.filter(e => / \u00b7 T\d/.test(e.textContent)).length);
  await expect.poll(tiers, 'tier shields (titles naming "T<n>") on the second opening').toBeGreaterThan(0);
});

// The same, while the popover stays open: its 30 s refresh asks for the catalogue again and the shields appear
// without a reopening.
test('a failed upgrade catalogue is asked for again by the open map\'s refresh', async ({ page, wvw }) => {
  const down = await abort(page, wvw, /\/v2\/wvw\/upgrades/);
  await load(page, wvw);
  const tier = await firstTier(page);
  await openMap(page, wvw, tier.button);
  await expect.poll(() => down.reads, 'the opening tried the catalogue and its retries').toBe(3);
  await wvw.settle();
  const tiers = () => page.$$eval('.info-popover .wvw-plot g[role="button"] > title', t => t.filter(e => / · T\d/.test(e.textContent)).length);
  expect(await tiers(), 'no tier shields while the catalogue is missing').toBe(0);
  expect(down.reads, 'nothing asked between the opening and the refresh').toBe(3);
  down.off();
  await later(page, wvw, 31 * 1000);
  await expect.poll(tiers, 'tier shields from the refresh, popover never closed').toBeGreaterThan(0);
});

// An emblem catalogue that failed is not kept as an empty one against a guild: the same guild asked again after
// the network is back gets its layers.
test('a guild emblem asked while the emblem catalogue was down is drawn on the next ask', async ({ page, wvw }) => {
  await load(page, wvw);
  const id = 'ZZZZ-EMBLEM-GUILD';
  const emblem = { background: { id: 1, colors: [1] }, foreground: { id: 2, colors: [1, 1] }, flags: [] };
  await answer(page, `https://api.guildwars2.com/v2/guild/${id}`, { id, name: 'Emblem Guild', tag: 'EMB', emblem });
  await forgetEmblems(page);
  const down = await abort(page, wvw, /\/v2\/emblem\//);
  const layers = () => emblemLayerCount(page, id);
  expect(await layers(), 'layers while the catalogue is down').toBe(0);
  down.off();
  await answer(page, /\/v2\/emblem\/backgrounds/, [{ id: 1, layers: ['https://render.guildwars2.com/b.png'] }]);
  await answer(page, /\/v2\/emblem\/foregrounds/, [{ id: 2, layers: ['https://render.guildwars2.com/f0.png', 'https://render.guildwars2.com/f1.png'] }]);
  expect(await layers(), 'layers of the same guild once the catalogue is back').toBe(2);
});
