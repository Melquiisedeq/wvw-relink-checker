// The map and the page by hand: a marker and the board answer Tab, Enter and
// Space; the waypoint's chat link and the summary reach the clipboard exactly,
// or by the old way, or are put on the screen when neither works; Ctrl+Enter
// runs the search; the saved list comes back whole.
import { test, expect } from './support/fixtures.mjs';
import { boardOpen, tabTo, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 60 * 1000 });

const POP = '.info-popover';
const MARKER = `${POP} .wvw-plot g[role='button']`;
const ROW = `${POP} .wvw-board-row[data-focus-color]`;

// Whether the page took each Enter and Space for itself (kept them from also
// scrolling or clicking): the keys it called preventDefault() on, in order.
const watchKeys = page => page.evaluate(() => {
  window.__taken = [];
  const real = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (this.type === 'keydown' && (this.key === 'Enter' || this.key === ' ')) window.__taken.push(this.key);
    return real.call(this);
  };
});
const taken = page => page.evaluate(() => window.__taken);
const selected = page => page.$$eval(`${POP} .is-selected`, gs => gs.map(g => g.dataset.obj));
const heading = page => page.locator(`${POP} .wvw-detail`).textContent();

test.describe('keyboard on the map', () => {
  test('a marker: Tab reaches it, Enter and Space pick it, other keys do not', async ({ page, wvw }) => {
    await boardOpen(page, wvw);
    await page.locator(POP).focus();
    await tabTo(page, MARKER.replace(`${POP} `, ''), 'a marker');
    expect(await selected(page), 'nothing picked before a key').toEqual([]);
    await page.keyboard.press('a');
    await page.keyboard.press('Shift');
    expect(await selected(page), 'a letter picks nothing').toEqual([]);

    const first = await page.evaluate(() => document.activeElement.dataset.obj);
    await watchKeys(page);
    await page.keyboard.press('Enter');
    expect(await selected(page), 'Enter picks the focused marker').toEqual([first]);
    const named = await heading(page);
    expect(named.trim().length, 'the objective panel filled in').toBeGreaterThan(0);

    await page.keyboard.press('Tab');
    const second = await page.evaluate(() => document.activeElement.dataset.obj);
    expect(second, 'Tab moved on to another marker').toBeTruthy();
    expect(second).not.toBe(first);
    const scrolled = await page.evaluate(() => scrollY);
    await page.keyboard.press(' ');
    expect(await selected(page), 'Space picks the focused marker, and only it').toEqual([second]);
    expect(await heading(page), 'the panel follows the new pick').not.toBe(named);
    expect(await page.evaluate(() => scrollY), 'Space does not scroll the page').toBe(scrolled);
    expect(await taken(page), 'Enter and Space on a marker are the page\'s, not the browser\'s').toEqual(['Enter', ' ']);
  });

  for (const key of ['Enter', ' ']) {
    test(`the board: ${key === ' ' ? 'Space' : key} on a team's name picks it, again lets go`, async ({ page, wvw }) => {
      await boardOpen(page, wvw);
      const row = page.locator(ROW).first();
      await page.locator(POP).focus();
      await tabTo(page, '.wvw-board-row[data-focus-color] .wvw-board-team', 'a team name on the board');
      await page.keyboard.press('x');
      await expect(row, 'a letter picks nothing').not.toHaveClass(/is-picked/);
      await watchKeys(page);
      await page.keyboard.press(key);
      expect(await taken(page), 'the key is the page\'s, not the browser\'s').toEqual([key]);
      await expect(row).toHaveClass(/is-picked/);
      await expect(page.locator(`${POP} .wvw-plot`)).toHaveClass(/is-focused/);
      await page.keyboard.press(key);
      await expect(row).not.toHaveClass(/is-picked/);
      await expect(page.locator(`${POP} .wvw-plot`)).not.toHaveClass(/is-focused/);
    });
  }
});

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
  const want = await page.evaluate(o => WAYPOINT_AT[o][2], obj);
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

test.describe('Ctrl+Enter and the saved list', () => {
  test('Ctrl+Enter runs the search; plain Enter only adds a line; a second press during a run is ignored', async ({ page, wvw }) => {
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await wvw.settle();
    const searches = [];
    page.on('request', r => { if (/\/v2\/guild\/search\?/.test(r.url())) searches.push(r.url()); });
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText(wvw.guilds.join('\n'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(page.locator('#statusMsg'), 'Enter alone does not run').not.toHaveText(/Talking|Done/);
    expect(await page.locator('#guildInput').inputValue()).toBe(wvw.guilds.join('\n') + '\n');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#runBtn')).toBeDisabled();
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
    await expect(page.locator('#resultBody tr').first()).toBeVisible();
    expect(await page.locator('#resultBody tr').count(), 'one row per name, from one run').toBe(wvw.guilds.length);
    expect(searches.length, 'searches asked, one run').toBeLessThanOrEqual(wvw.guilds.length);
    await wvw.settle();
  });

  const typed = ['First Guild', 'Second Guild [ABC]', 'Third Guild', 'Fourth Guild'];
  const saved = page => page.evaluate(() => localStorage.getItem('wvw-relink-checker:guilds'));

  test('the list comes back whole after a reload, and an emptied box stays empty', async ({ page, wvw }) => {
    await page.goto(wvw.url);
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText(typed.join('\n'));
    await expect.poll(() => saved(page), { message: 'the list being saved' }).toBe(typed.join('\n'));
    await page.reload();
    await expect(page.locator('#guildInput')).toHaveValue(typed.join('\n'));
    await page.locator('#guildInput').fill('');
    await expect.poll(() => saved(page), { message: 'the emptied list being saved' }).toBe('');
    await page.reload();
    await expect(page.locator('#guildInput')).toHaveValue('');
    await wvw.settle();
  });

  test('storage that refuses: the box stays empty, what is typed stays typed, no error', async ({ page, wvw }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    });
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText('Some Guild');
    await page.waitForTimeout(600);
    await expect(page.locator('#guildInput')).toHaveValue('Some Guild');
    await wvw.settle();
  });
});
