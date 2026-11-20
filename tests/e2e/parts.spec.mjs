// A script of the page that does not download, one at a time. Each one the page needs makes it say to reload,
// where the search's and the standings' statuses go, and Check stays usable; boot.js too, which starts the page.
// Without js/trebuchet.js (effects only), js/wvw-static.js (the maps read the game instead: relink.spec.mjs) or
// js/region.js (the watcher) the page works, without a word.
import { test, expect } from './support/fixtures.mjs';
import { abort } from './support/faults.mjs';

const RELOAD = "Part of the page didn't load. Reload to fix it.";
const NEEDED = ['config', 'dom', 'api', 'relink', 'sheet', 'popover', 'guilds-popover', 'popover-parts',
  'stat-popovers', 'standings', 'maps-early', 'panels', 'summary', 'run', 'boot'];

test('every script index.html loads in order is in this spec', async ({ page, wvw }) => {
  await page.goto(wvw.url);
  const loaded = await page.locator('script[src^="js/"]').evaluateAll(els => els.filter(s => !s.async).map(s => s.getAttribute('src')));
  expect(loaded.sort()).toEqual([...NEEDED, 'region', 'trebuchet', 'wvw-static'].map(f => `js/${f}.js`).sort());
});

for (const file of NEEDED) {
  test(`js/${file}.js missing: the page says to reload, and Check is not left off`, async ({ page, wvw }) => {
    // The files after a missing one read its names as they load, and on leaving: those failures are the missing file's.
    const { problems } = wvw;
    Object.defineProperty(problems, 'push', {
      value: (...lines) => Array.prototype.push.apply(problems, lines.filter(p => !/^exception: ReferenceError: /.test(p))),
    });
    const down = await abort(page, wvw, new RegExp(`/js/${file}\\.js$`));
    await page.goto(wvw.url);
    for (const id of ['#statusMsg', '#standingsStatusNA', '#standingsStatusEU']) {
      await expect(page.locator(id)).toHaveText(RELOAD);
    }
    await expect(page.locator('#statusMsg')).toHaveClass(/\bstatus-err\b/);
    expect(down.reads, 'reads cut off').toBeGreaterThan(0);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await page.locator('#runBtn').click();
    await page.locator('#guildInput').press('Control+Enter');
    await wvw.settle();
    await expect(page.locator('#runBtn')).toBeEnabled();
    await expect(page.locator('#runBtn')).toHaveText('Check');
    for (const id of ['#statusMsg', '#standingsStatusNA', '#standingsStatusEU']) {
      await expect(page.locator(id), 'nothing started writes over it').toHaveText(RELOAD);
    }
    await expect(page.locator('#resultBody tr')).toHaveCount(0);
  });
}

// An image that fails is not a script: assets/treb-frame.webp is in index.html.
for (const [file, pattern] of [['', null], ['js/trebuchet.js', /\/js\/trebuchet\.js$/], ['js/wvw-static.js', /\/js\/wvw-static\.js$/],
  ['js/region.js', /\/js\/region\.js$/], ['assets/treb-frame.webp', /\/assets\/treb-frame\.webp$/]]) {
  test(`${file ? `${file} missing` : 'every script in'}: Check runs and shows its result, without a word about it`, async ({ page, wvw }) => {
    const down = pattern ? await abort(page, wvw, pattern) : null;
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
    await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await page.locator('#runBtn').click();
    if (down) expect(down.reads, 'reads cut off').toBeGreaterThan(0);
    await expect(page.locator('#statusMsg')).toContainText('Done, checked 1 guild');
    await expect(page.locator('#runBtn'), 'Check is not left off').toBeEnabled();
    await expect(page.locator('#runBtn')).toHaveText('Check');
    await expect(page.locator('body')).not.toContainText('Reload');
  });
}
