// The guild search in the shapes a visitor's list can take: a second Check that
// fails after a good one, a name from the game's API that is markup, and a list
// where some guilds failed. Guilds are made up here (GUIDs pasted, answered by
// the test), on a team of the recorded NA tiers.
import { test, expect } from './support/fixtures.mjs';
import { fail, hold } from './support/faults.mjs';
import { check, load, recordedJson } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const GAME = 'https://api.guildwars2.com/v2/';
const guildId = n => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const CORS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const reply = (route, body, status = 200) => route.fulfill({ status, body: JSON.stringify(body), headers: CORS });

// A red-side team of the first recorded NA tier.
function homeTeam() {
  const m = recordedJson(GAME + 'wvw/matches?ids=all').find(x => x.id.startsWith('1-'));
  return Number(m.all_worlds.red.find(n => n >= 10000));
}

// The game's guild reads, as `guilds` says: { id, name, tag, linked, search }. The NA table puts every linked one on `team`.
// `asked` collects the search addresses as the browser sent them.
async function guildApi(page, guilds, team) {
  const asked = [];
  await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, route => {
    asked.push(route.request().url());
    const want = decodeURIComponent(route.request().url().split('name=')[1]);
    const g = guilds.find(x => x.search === want);
    return reply(route, g ? [g.id] : []);
  });
  await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/[0-9a-f-]{36}$/, route => {
    const g = guilds.find(x => route.request().url().endsWith(x.id));
    return g ? reply(route, { id: g.id, name: g.name, tag: g.tag, emblem: null }) : reply(route, { text: 'no such guild' }, 404);
  });
  await page.route(GAME + 'wvw/guilds/na', route => reply(route, Object.fromEntries(guilds.filter(g => g.linked).map(g => [g.id, team]))));
  await page.route(GAME + 'wvw/guilds/eu', route => reply(route, {}));
  return asked;
}

const summaries = page => page.evaluate(() => [document.getElementById('copyChatBtn').dataset.summary, document.getElementById('copyDiscordBtn').dataset.summary]);

// A good Check, a second good one, an empty box, and a failing one: what the copy row and the results do at each.
test('a Check after a good one: the copy is the new one, an empty box keeps everything, a failing Check hides the copy', async ({ page, wvw }) => {
  const team = homeTeam();
  await guildApi(page, [
    { id: guildId(1), name: 'First Guild', tag: 'ONE', linked: true },
    { id: guildId(2), name: 'Second Guild', tag: 'TWO', linked: true },
  ], team);
  await load(page, wvw);
  const copyRow = page.locator('#copyRow'), status = page.locator('#statusMsg');

  await check(page, wvw, [guildId(1)]);
  await expect(copyRow, 'the copy buttons after a good Check').toBeVisible();
  const [first] = await summaries(page);
  expect(first).toContain('First Guild landed on');

  // The second Check, held on its lookup: the first one's rows and copy are gone already.
  const release = await hold(page, new RegExp(`/v2/guild/${guildId(2)}$`));
  await page.locator('#guildInput').fill(guildId(2));
  await page.locator('#runBtn').click();
  await expect.poll(() => release.reads, { message: 'the second lookup held' }).toBeGreaterThan(0);
  await expect(copyRow, 'the copy buttons while the next Check runs').toBeHidden();
  await expect(page.locator('#resultBody tr'), 'the old rows while the next Check runs').toHaveCount(0);
  release();
  await expect(status).toHaveText(/^Done/, { timeout: 15000 });
  await wvw.settle();
  const [chat, discord] = await summaries(page);
  expect(chat, 'the chat copy of the second Check').toContain('Second Guild landed on');
  expect(chat).not.toContain('First Guild');
  expect(discord, 'the Discord copy of the second Check').toContain('Second Guild landed on');
  expect(discord).not.toContain('First Guild');
  await expect(copyRow).toBeVisible();

  // An empty box: a word, and nothing else changes.
  await page.locator('#guildInput').fill('  \n ');
  await page.locator('#runBtn').click();
  await expect(status).toHaveText('Paste at least one guild name first.');
  await expect(status, 'the old Done is not an error').not.toHaveClass(/status-err/);
  await expect(page.locator('#resultBody tr')).toHaveCount(1);
  await expect(page.locator('#resultBody tr').first()).toContainText(guildId(2));
  await expect(page.locator('#matchPanelsContainer > *').first()).toBeAttached();
  await expect(copyRow, 'the copy buttons after an empty Check').toBeVisible();
  expect((await summaries(page))[0]).toBe(chat);
  await expect(page.locator('#runBtn')).toBeEnabled();

  // A Check that finds nothing: its rows only, no copy, and the status still says Done.
  await check(page, wvw, ['Nobody Has This Name']);
  await expect(page.locator('#resultBody tr .status-err')).toHaveText('Guild not found (name must match exactly)');
  await expect(page.locator('#resultBody tr')).toHaveCount(1);
  await expect(copyRow, 'the copy buttons after a Check that found nothing').toBeHidden();
  await expect(status).toHaveText('Done, checked 1 guild(s).');
});

// A name from the game is text everywhere it lands: the tag cell, the panel's guild list, the strip, the copy.
test('a guild name that is markup: the address encoded, no element born, the text literal in the copy', async ({ page, wvw }) => {
  const name = '<img src=x onerror="window.__pwned=1"> & #1 / 😀 ?a=b';
  const typed = 'Typed & #1 / 😀 ?a=b';
  const team = homeTeam();
  const asked = await guildApi(page, [{ id: guildId(3), search: typed, name, tag: '<b>', linked: true }], team);
  await load(page, wvw);
  await check(page, wvw, [typed]);
  expect(asked, 'the search address').toEqual([`${GAME}guild/search?name=${encodeURIComponent(typed)}`]);
  const born = await page.evaluate(() => ({
    imgs: document.querySelectorAll('img[onerror], img[src="x"]').length,
    bold: document.querySelectorAll('#resultBody b, #matchPanelsContainer b').length,
    pwned: window.__pwned,
  }));
  expect(born, 'elements born from the name, and its handler').toEqual({ imgs: 0, bold: 0, pwned: undefined });
  await expect(page.locator('#resultBody tr .tag')).toHaveText('[<b>]');
  await expect(page.locator('#matchPanelsContainer')).toContainText(name);
  const [chat, discord] = await summaries(page);
  expect(chat, 'the chat copy').toContain(`${name} landed on`);
  expect(discord, 'the Discord copy').toContain(`${name} landed on`);
});

// Three of four fail in three ways; the copy names only the guild that landed, and the buttons are there to press.
test('a list where some guilds failed: the copy cites only the found, the buttons copy it', async ({ page, wvw, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const team = homeTeam();
  await guildApi(page, [
    { id: guildId(4), name: 'Found Guild', tag: 'FND', linked: true, search: 'Found Guild' },
    { id: guildId(5), name: 'Unlinked Guild', tag: 'LNK', linked: false, search: 'Unlinked Guild' },
    { id: guildId(6), name: 'Vanished Guild', tag: 'GON', linked: true, search: 'Vanished Guild' },
  ], team);
  await fail(page, wvw, new RegExp(`/v2/guild/${guildId(6)}$`), 404);
  await load(page, wvw);
  await check(page, wvw, ['Unlinked Guild', 'Nobody Has This Name', 'Vanished Guild', 'Found Guild']);
  await expect(page.locator('#statusMsg')).toHaveText('Done, checked 4 guild(s).');
  expect(await page.locator('#resultBody tr .status-err').allTextContents(), 'the three failures, in order').toEqual([
    'No WvW link registered yet', 'Guild not found (name must match exactly)', 'Guild not found (name must match exactly)']);
  const [chat, discord] = await summaries(page);
  for (const [which, text] of [['chat', chat], ['Discord', discord]]) {
    expect(text, `the ${which} copy`).toContain('Found Guild landed on');
    for (const bad of ['Unlinked', 'Nobody Has', 'Vanished']) expect(text, `the ${which} copy cites ${bad}`).not.toContain(bad);
  }
  await expect(page.locator('#copyRow')).toBeVisible();
  for (const [button, text] of [['#copyChatBtn', chat], ['#copyDiscordBtn', discord]]) {
    await page.locator(button).click();
    await expect(page.locator('#copyFeedback')).toHaveText('Copied to clipboard.');
    expect(await page.evaluate(() => navigator.clipboard.readText()), `what ${button} copied`).toBe(text);
    await page.evaluate(() => { document.getElementById('copyFeedback').textContent = ''; });
  }
});
