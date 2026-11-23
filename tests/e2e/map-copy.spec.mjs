// The waypoint's chat link and the summary reach the clipboard exactly,
// or by the old way, or are put on the screen when neither works.
import { test, expect } from './support/fixtures.mjs';
import { boardOpen, search } from './support/steps.mjs';
import { waypointIdOf } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 60 * 1000 });

const POP = '.info-popover';

const selected = page => page.$$eval(`${POP} .is-selected`, gs => gs.map(g => g.dataset.obj));

// The waypoint's chat link: the byte 4 and the point's id, little-endian, in
// base64 between [& and ].
const code = id => `[&${Buffer.from([4, id & 255, (id >> 8) & 255, (id >> 16) & 255, (id >> 24) & 255]).toString('base64')}]`;

const BADGE = `${POP} .wvw-wp.is-copyable`;
async function badge(page, wvw) {
  await boardOpen(page, wvw);
  const tabs = page.locator(`${POP} .wvw-tab`);
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await wvw.settle();
    if (await page.locator(BADGE).count()) break;
  }
  const target = page.locator(BADGE).first();
  await expect(target, 'a map with a waypoint to copy').toBeAttached();
  const obj = await target.evaluate(g => g.closest('[data-obj]').dataset.obj);
  const want = await waypointIdOf(page, obj);
  return { target, want: code(want), obj };
}

// What the page sees of the clipboard: writeText rejecting, absent, or fine;
// execCommand('copy') counted, with the text it was asked to copy.
const rig = (page, { write, exec }) => page.evaluate(({ write, exec }) => {
  window.__copy = { exec: 0, text: null };
  if (write === 'absent') Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  if (write === 'reject') Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('no', 'NotAllowedError')) }, configurable: true });
  document.execCommand = cmd => {
    if (cmd !== 'copy') return false;
    window.__copy.exec++;
    window.__copy.text = document.activeElement?.value ?? null;
    if (exec === 'throw') throw new Error('refused');
    return exec === 'ok';
  };
}, { write, exec });

test.describe('copying the waypoint link', () => {
  test('clipboard allowed: exactly the [&...] code is copied and the badge says so', async ({ page, wvw, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { target, want } = await badge(page, wvw);
    await target.click();
    await expect(page.locator(`${POP} .wvw-wp-note`)).toHaveText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText()), 'what the clipboard holds').toBe(want);
    expect(await selected(page), 'copying does not pick the objective behind').toEqual([]);
  });

  for (const [write, exec, shown] of [
    ['reject', 'ok', 'copied'], ['absent', 'ok', 'copied'],
    ['reject', 'no', 'code'], ['absent', 'no', 'code'], ['reject', 'throw', 'code'], ['absent', 'throw', 'code'],
  ]) {
    const how = write === 'reject' ? 'writeText refused' : 'no clipboard';
    const then = exec === 'ok' ? 'the old way works: "copied"' : exec === 'no' ? 'the old way fails too: the code is shown' : 'the old way throws: the code is shown';
    test(`${how}, ${then}`, async ({ page, wvw }) => {
      const { target, want } = await badge(page, wvw);
      await rig(page, { write, exec });
      await target.click();
      const note = page.locator(`${POP} .wvw-wp-note`);
      await expect(note).toHaveText(shown === 'copied' ? 'copied' : want);
      const tried = await page.evaluate(() => window.__copy);
      expect(tried.exec, "times the old way was tried").toBe(1);
      expect(tried.text, 'the text the old way was asked to copy').toBe(want);
      await expect(note, 'the note leaves by itself').toHaveCount(0, { timeout: 5000 });
    });
  }
});

test.describe('copying the summary', () => {
  const searched = async (page, wvw) => {
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await wvw.settle();
    await search(page, wvw.guilds);
    await expect(page.locator('#copyRow')).toBeVisible();
    await wvw.settle();
  };
  const summary = (page, id) => page.locator(id).evaluate(b => b.dataset.summary);

  test('clipboard allowed: each button copies its own text', async ({ page, wvw, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await searched(page, wvw);
    await rig(page, { write: 'real', exec: 'no' });
    const chat = await summary(page, '#copyChatBtn');
    const discord = await summary(page, '#copyDiscordBtn');
    expect(chat.length && discord.length, 'both summaries are filled').toBeTruthy();
    expect(chat, 'the two summaries differ').not.toBe(discord);
    await page.locator('#copyChatBtn').click();
    await expect(page.locator('#copyFeedback')).toHaveText('Copied to clipboard.');
    expect(await page.evaluate(() => navigator.clipboard.readText()), 'for chat').toBe(chat);
    expect((await page.evaluate(() => window.__copy)).exec, 'times the old way was used with a working clipboard').toBe(0);
    await page.locator('#copyDiscordBtn').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: 'for Discord' }).toBe(discord);
    expect(chat.toLowerCase(), 'the summary names a guild that was searched').toContain(wvw.guilds[0].toLowerCase());
  });

  for (const write of ['reject', 'absent']) {
    for (const exec of ['ok', 'no', 'throw']) {
      test(`${write === 'reject' ? 'writeText refused' : 'no clipboard'}, old way ${exec}: ${exec === 'ok' ? 'copied' : 'told to select it by hand'}`, async ({ page, wvw }) => {
        await searched(page, wvw);
        await rig(page, { write, exec });
        const chat = await summary(page, '#copyChatBtn');
        await page.locator('#copyChatBtn').click();
        await expect(page.locator('#copyFeedback')).toHaveText(exec === 'ok' ? 'Copied to clipboard.' : "Couldn't copy automatically, select the text manually.");
        const tried = await page.evaluate(() => window.__copy);
        expect(tried.exec, 'times the old way was tried').toBe(1);
        expect(tried.text, 'the text the old way was asked to copy').toBe(chat);
      });
    }
  }
});
