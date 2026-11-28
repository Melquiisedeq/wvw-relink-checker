// The guild search with a name from the game's API that is markup. The guild is made
// up here (answered by the test), on a team of the recorded NA tiers.
import { test, expect } from './support/fixtures.mjs';
import { check, load, recordedJson } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const GAME = 'https://api.guildwars2.com/v2/';
const guildId = n => `AAAAAAAA-0000-4000-8000-00000000000${n}`;
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
  await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/[0-9a-f-]{36}$/i, route => {
    const g = guilds.find(x => route.request().url().endsWith(x.id));
    return g ? reply(route, { id: g.id, name: g.name, tag: g.tag, emblem: null }) : reply(route, { text: 'no such guild' }, 404);
  });
  await page.route(GAME + 'wvw/guilds/na', route => reply(route, Object.fromEntries(guilds.filter(g => g.linked).map(g => [g.id, team]))));
  await page.route(GAME + 'wvw/guilds/eu', route => reply(route, {}));
  return asked;
}


// A name from the game is text everywhere it lands: the answer card and the strip.
test('a guild name that is markup: the address encoded, no element born, the text literal', async ({ page, wvw }) => {
  const name = '<img src=x onerror="window.__pwned=1"> & #1 / 😀 ?a=b';
  const typed = 'Typed & #1 / 😀 ?a=b';
  const team = homeTeam();
  const asked = await guildApi(page, [{ id: guildId(3), search: typed, name, tag: '<b>', linked: true }], team);
  await load(page, wvw);
  await check(page, wvw, typed);
  expect(asked, 'the search address').toEqual([`${GAME}guild/search?name=${encodeURIComponent(typed)}`]);
  await page.locator('#searchAnswer .search-go').click();
  await expect(page.locator('.guild-found-strip')).toHaveText(`${name} · from your search`);
  const born = await page.evaluate(() => ({
    imgs: document.querySelectorAll('img[onerror], img[src="x"]').length,
    pwned: window.__pwned,
  }));
  expect(born, 'elements born from the name, and its handler').toEqual({ imgs: 0, pwned: undefined });
  await expect(page.locator('#searchAnswer .search-who')).toHaveText(`${name} is on`);
});
