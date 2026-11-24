// The guild search, one name: the answer card (team, tier, region, rivals as the standings
// have them), the last guilds found offered as you type, the field's limit, the arrow that
// brings the tier into view with the spotlight and the guild's strip, and the crest that
// lands on the answer.
import { test, expect } from './support/fixtures.mjs';
import { load, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

const field = page => page.getByRole('combobox', { name: 'Guild name, exactly as in game' });
const card = page => page.locator('#searchAnswer .search-card');

// The tier in the standings that holds `team`, read off the board: its number and the other two teams.
async function tierOf(page, team) {
  const side = page.locator('.standing-side', { has: page.locator('.standing-side-name', { hasText: new RegExp(`^${team}$`) }) });
  const tier = page.locator('.standing-match', { has: side });
  const names = await tier.locator('.standing-side-name').allTextContents();
  return { tier, names };
}

test('a guild found: its team, tier and rivals as the standings have them, asked of the game once', async ({ page, wvw }) => {
  await load(page, wvw);
  const asked = [];
  page.on('request', r => { if (r.url().startsWith('https://api.guildwars2.com/v2/guild/')) asked.push(r.url()); });
  await search(page, wvw.guilds[0]);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.search-who')).toHaveText(new RegExp(`is on$`));
  const team = await card(page).locator('.search-team').textContent();
  const { names } = await tierOf(page, team);
  expect(names, "the team's tier in the standings").toContain(team);
  const rivals = await card(page).locator('.search-rival').allTextContents();
  expect(rivals.sort(), 'the rivals are the other two teams of its tier').toEqual(names.filter(n => n !== team).sort());
  await expect(card(page).locator('.search-tier b')).toHaveText(/^Tier \d$/);
  await expect(card(page).locator('.search-tier span')).toHaveText(/^(NA|EU)$/);
  expect(asked.filter(u => u.includes('/guild/search?')).length, 'one name search').toBe(1);
  await expect(page.getByRole('button', { name: new RegExp(`^Show ${team} in the standings`) })).toBeVisible();
  await wvw.settle();
});

test('the guilds found are offered as you type, kept across a reload; the old pasted list is deleted', async ({ page, wvw }) => {
  await load(page, wvw);
  await page.evaluate(() => localStorage.setItem('wvw-relink-checker:guilds', 'An Old Pasted List'));
  await search(page, wvw.guilds[0]);
  const guild = (await card(page).locator('.search-who').textContent()).replace(/ is on$/, '');
  await expect(page.locator('#recentGuilds option')).toHaveCount(1);
  await expect(page.locator('#recentGuilds option')).toHaveAttribute('value', guild);
  await page.reload();
  await expect(field(page)).toHaveAttribute('list', 'recentGuilds');
  await expect(page.locator('#recentGuilds option')).toHaveAttribute('value', guild);
  expect(await page.evaluate(() => localStorage.getItem('wvw-relink-checker:guilds')), 'the old key, gone').toBeNull();
  await wvw.settle();
});

test('the field takes 64 characters, as long as any guild name', async ({ page, wvw }) => {
  await load(page, wvw);
  await field(page).focus();
  await page.keyboard.type('x'.repeat(70));
  await expect(field(page)).toHaveValue('x'.repeat(64));
  await wvw.settle();
});

test("the arrow: the tier comes into view, the column's other tiers dim, the ring and the guild's strip", async ({ page, wvw }) => {
  await load(page, wvw);
  await search(page, wvw.guilds[0]);
  const team = await card(page).locator('.search-team').textContent();
  const guild = (await card(page).locator('.search-who').textContent()).replace(/ is on$/, '');
  await expect(page.locator('.guild-found-strip'), 'no strip before the arrow').toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(`^Show ${team} in the standings`) }).click();
  const { tier } = await tierOf(page, team);
  await expect(tier).toBeInViewport({ ratio: 0.5 });
  await expect(page.locator('.tier-spot')).toHaveCount(1);
  await expect(tier).not.toHaveClass(/tier-dimmed/);
  const others = await tier.locator('xpath=..').locator('> .standing-match').count();
  await expect(tier.locator('xpath=..').locator('> .standing-match.tier-dimmed')).toHaveCount(others - 1);
  await expect(page.locator('.guild-found-strip')).toHaveText(`${guild} · from your search`);
  await expect(page.locator('.standing-side .found-mark')).toHaveCount(1);
  await expect(page.locator('.tier-spot'), 'the spotlight leaves by itself').toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.tier-dimmed')).toHaveCount(0);
  await wvw.settle();
});

test('the crest lands on the answer card', async ({ page, wvw }) => {
  await load(page, wvw);
  await search(page, wvw.guilds[0]);
  const box = await card(page).boundingBox();
  await expect.poll(async () => {
    const s = await page.locator('.impact-stack').boundingBox();
    if (!s) return Infinity;
    return Math.abs(s.x + s.width / 2 - (box.x + box.width / 2)) + Math.abs(s.y + s.height / 2 - (box.y + box.height / 2));
  }, { message: "the crest's centre on the card's" }).toBeLessThan(40);
  await wvw.settle();
});
