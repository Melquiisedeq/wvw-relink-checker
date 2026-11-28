// The highlights panel above the search (js/highlights.js): its three tiles on the recording, the NA | EU
// switch, the focus kept through a repaint, and the states the factory names: the API stuck in the middle of a
// fight, a week's first minutes, a victory point table the site does not know, and hours with the tab visible.
import { test, expect } from './support/fixtures.mjs';
import { board, load, phone, search } from './support/steps.mjs';
import { boardBodies, loadNow, loadSettled } from './support/page.mjs';
import { MIN, copyTaken, frozenMidFight, longTeams, noTeams, playing, redOnly, vpTableChanged, weekAtZero } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

const panel = page => page.getByRole('region', { name: /^Highlights, / });
const hot = page => panel(page).getByRole('button', { name: /^Hottest fight/ });
const busy = page => panel(page).getByRole('button', { name: /^Busiest map/ });
const closest = page => panel(page).getByRole('button', { name: /^Closest match/ });
const regionBtn = (page, r) => panel(page).getByRole('group', { name: 'Highlights region' }).getByRole('button', { name: r });

// Time moves on and the standings are read again: the panel is painted from that answer.
async function readAgain(page, wvw, ms) {
  await wvw.skew(ms);
  await loadNow(page);
  await loadSettled(page);
  await wvw.settle();
}

test('the three tiles of the first region, above the search; a tile opens its map', async ({ page, wvw }) => {
  await load(page, wvw);
  await expect(panel(page)).toHaveAttribute('aria-label', 'Highlights, NA');
  const top = async l => (await l.boundingBox()).y;
  expect(await top(panel(page)), 'the panel above the search').toBeLessThan(await top(page.getByRole('region', { name: 'Find your guild’s team' })));
  await expect(hot(page)).toHaveAccessibleName(/^Hottest fight, NA · T\d: [\d,]+ kills per 10 minutes on .+, now\. Open the live map on it$/);
  await expect(busy(page)).toHaveAccessibleName(/^Busiest map, NA · T\d: \d+ objectives taken in the last 2 hours on .+, held now by .+\. Open the live map on it$/);
  await expect(closest(page)).toHaveAccessibleName(/^Closest match, NA · T\d: (Red|Blue|Green), .+ apart this week\. If this skirmish ended now, /);
  await expect(closest(page)).toContainText(/\+\d+ VP\s*\+\d+ VP/);
  await expect(closest(page)).toContainText(/ set to (win|pass|stay ahead) · /);
  const map = (await hot(page).getAttribute('aria-label')).match(/ on (.+), now\./)[1];
  await hot(page).click();
  const tab = { 'Eternal Battlegrounds': 'EBG', 'Red Borderlands': 'Red BL', 'Blue Borderlands': 'Blue BL', 'Green Borderlands': 'Green BL' }[map];
  await expect(page.locator('.info-popover .wvw-tab[aria-current="true"]')).toContainText(tab);
});

test('NA | EU: a pick of its own, not kept, dropped by the columns\' swap; the focus stays on its control', async ({ page, wvw }) => {
  await load(page, wvw);
  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  await regionBtn(page, 'EU').click();
  await expect(panel(page)).toHaveAttribute('aria-label', 'Highlights, EU');
  await expect(regionBtn(page, 'EU')).toHaveAttribute('aria-pressed', 'true');
  await expect(regionBtn(page, 'EU'), 'the focus back on the pressed button after the repaint').toBeFocused();
  await expect(hot(page)).toHaveAccessibleName(/^Hottest fight, EU · /);
  expect(await page.evaluate(() => Object.keys(localStorage).sort()), 'nothing kept').toEqual(keys);
  // Swapping the columns puts EU first: the panel follows it, the pick gone; swapped back, NA.
  await page.getByRole('button', { name: 'Swap the NA and EU columns' }).first().click();
  await expect(panel(page)).toHaveAttribute('aria-label', 'Highlights, EU');
  await page.getByRole('button', { name: 'Swap the NA and EU columns' }).first().click();
  await expect(panel(page)).toHaveAttribute('aria-label', 'Highlights, NA');
  await regionBtn(page, 'EU').click();
  await page.reload();
  await wvw.settle();
  await expect(regionBtn(page, 'NA'), 'a new visit starts on the first column').toHaveAttribute('aria-pressed', 'true');
});

test('at 320 and 390 the panel fits, long names cut with the whole name said', async ({ page, wvw }) => {
  await load(page, wvw);
  for (const w of [390, 320]) {
    await phone(page, w);
    await wvw.settle();
    await expect(closest(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `no sideways scroll at ${w}`).toBeLessThanOrEqual(w);
    const box = await panel(page).boundingBox();
    expect(box.x + box.width, `the panel inside ${w}`).toBeLessThanOrEqual(w);
  }
});

// Our copy's count (taken.maps) is what the Busiest map says, not what the owners' dates would give.
test.describe('our copy with the Worker\'s count', () => {
  test.use({ timeline: playing(40) });

  test('the Busiest map counts the copy\'s takes of the last 2 h', async ({ page, wvw }) => {
    const served = await copyTaken(page, wvw, { extra: 3 });
    await load(page, wvw);
    const most = Math.max(...Object.entries(served).filter(([id, t]) => id[0] === '1' && t).flatMap(([, t]) => Object.values(t.maps)));
    expect(most, 'a take on some map to count').toBeGreaterThan(3);
    await expect(busy(page)).toHaveAccessibleName(new RegExp(`^Busiest map, NA · T\\d: ${most} objectives taken in the last 2 hours on `));
    await expect(busy(page).getByText(String(most), { exact: true })).toBeVisible();
  });

  test('a count with no take on any map of the last 2 h: the Busiest map says none, whatever the owners\' dates', async ({ page, wvw }) => {
    await copyTaken(page, wvw, { count: (e, taken) => ({ ...taken, maps: {} }) });
    await load(page, wvw);
    await expect(busy(page)).toHaveAccessibleName(/^Busiest map, NA · T\d: no objective taken in the last 2 hours; /);
  });

  test('takes only in the count: the N and the map, no owners to split and no "held now by"', async ({ page, wvw }) => {
    await copyTaken(page, wvw, { count: (e, taken) => {
      for (const map of e.body.maps) for (const o of map.objectives) o.last_flipped = e.body.start_time;
      return { ...taken, maps: { [e.body.maps[0].id]: 5 } };
    } });
    await load(page, wvw);
    await expect(busy(page)).toHaveAccessibleName(/^Busiest map, NA · T\d: 5 objectives taken in the last 2 hours on [^,]+\. Open the live map on it$/);
    await expect(busy(page).getByText('5', { exact: true })).toBeVisible();
    await expect(busy(page).locator('.hl-split, .hl-takers')).toHaveCount(0);
  });
});

test('2 h with no objective taken: the Busiest map names the last capture and still opens its map', async ({ page, wvw }) => {
  await load(page, wvw);
  await expect(busy(page)).toHaveAccessibleName(/ objectives taken in the last 2 hours /);
  await readAgain(page, wvw, 150 * MIN);
  await expect(busy(page)).toHaveAccessibleName(/^Busiest map, NA · T\d: no objective taken in the last 2 hours; Last capture \d\d:\d\d( [AP]M)? on .+\. Open the live map on it$/);
  await expect(busy(page)).toContainText(/Last capture \d\d:\d\d/);
  await busy(page).click();
  await expect(page.locator('.info-popover .wvw-tab[aria-current="true"]')).toBeVisible();
});

test.describe('the API stuck in the middle of a fight', () => {
  test.use({ timeline: frozenMidFight(20) });

  test('the Hottest fight says the game data paused, never "quiet now"', async ({ page, wvw }) => {
    await load(page, wvw);
    await expect(hot(page)).toHaveAccessibleName(/, now\. /);
    await readAgain(page, wvw, 4 * MIN);
    await readAgain(page, wvw, 20 * MIN);
    await expect(hot(page)).toHaveAccessibleName(/, game data paused · \d\d:\d\d( [AP]M)?\. Open the live map on it$/);
    await expect(hot(page)).not.toContainText('quiet now');
  });
});

test.describe('a week\'s first minutes', () => {
  test.use({ timeline: weekAtZero(6) });

  test('the Closest match and the Busiest map wait for numbers, the fight counts from the reset', async ({ page, wvw }) => {
    await load(page, wvw);
    await expect(busy(page)).toBeVisible();
    await readAgain(page, wvw, wvw.recordedAt + wvw.timeline.end - await wvw.now());
    await expect(panel(page).getByText('New week · first numbers soon'), 'the Closest match and the Busiest map').toHaveCount(2);
    await expect(closest(page)).toHaveCount(0);
    await expect(panel(page).getByText('Counting starts about 10 min after the reset')).toBeVisible();
    await expect(panel(page).getByText('Reading the kills…')).toHaveCount(0);
    await expect(busy(page), 'the objectives the reset handed out are no take').toHaveCount(0);
    await expect(panel(page).getByText('Busiest map')).toBeVisible();
  });
});

test.describe('a victory point table the site does not know', () => {
  test.use({ timeline: vpTableChanged(10) });

  test('the Closest match shows the week and who is ahead, nothing "if it ended now"', async ({ page, wvw }) => {
    await load(page, wvw);
    await expect(closest(page), 'the recording\'s fewest VP apart is the 2nd × 3rd pair').toHaveAccessibleName(/ is ahead this week\. /);
    await expect(closest(page)).not.toHaveAccessibleName(/If this skirmish ended now/);
    await expect(closest(page)).not.toContainText(/\+\d+ VP/);
    await expect(closest(page)).toContainText(/ ahead this week · /);
  });
});

test.describe('hours with the tab visible and no map open', () => {
  test.use({ timeline: playing(250) });

  test('the Hottest fight still has a pace after 4 h', async ({ page, wvw }) => {
    await load(page, wvw);
    for (let t = 0; t < 240; t += 5) await readAgain(page, wvw, 5 * MIN);
    await expect(hot(page)).toHaveAccessibleName(/ kills per 10 minutes on .+, now\. /);
    await expect(panel(page).getByText('Reading the kills…')).toHaveCount(0);
  });
});

// The recording's NA week has its fewest VP apart between 2nd and 3rd (the `want.place` guard):
// the tile names that pair and the fight, worked out here from the bodies on show and not asked of the page.
test('the Closest match takes the neighbours fewest VP apart, the 2nd and 3rd of a tier too', async ({ page, wvw }) => {
  await load(page, wvw);
  let want = null;
  for (const m of (await boardBodies(page)).filter(x => x.id.startsWith('1-'))) {
    const { byRank } = await board(page, m.id);
    const vp = byRank.map(c => Number(m.victory_points[c]));
    for (const place of [1, 2]) {
      const gap = vp[place - 1] - vp[place];
      if (!want || gap < want.gap || (gap === want.gap && place < want.place)) want = { id: m.id, gap, place, pair: [byRank[place - 1], byRank[place]], vp: [vp[place - 1], vp[place]] };
    }
  }
  expect(want.place, 'the recording is the 2nd × 3rd case').toBe(2);
  const [a, b] = want.pair.map(c => c[0].toUpperCase() + c.slice(1));
  await expect(closest(page)).toHaveAccessibleName(new RegExp(`^Closest match, NA · T${want.id.split('-')[1]}: ${a}, .+, ${want.vp[0].toLocaleString('en-US')} VP; ${b}, .+, ${want.vp[1].toLocaleString('en-US')} VP; ${want.gap} apart this week\\.`));
  await expect(closest(page).locator('.hl-big')).toHaveText(new RegExp(`^${want.gap}\\s*VP apart$`));
  await expect(closest(page).locator('.hl-vprow .hl-vp'), 'the two rows, 2nd above 3rd').toHaveText(want.vp.map(v => new RegExp(`^${v.toLocaleString('en-US')}\\s*VP$`)));
  const foot = closest(page).locator('.hl-sk-line');
  const lastRow = await closest(page).locator('.hl-vprow').last().boundingBox();
  expect((await foot.boundingBox()).y - (lastRow.y + lastRow.height), 'the foot stands clear of the last team row').toBeGreaterThanOrEqual(6);
  await expect(foot, 'the foot\'s phrase is muted').toHaveCSS('color', 'rgb(154, 164, 178)');
  await expect(foot.locator('.hl-team'), 'the team name stands out').not.toHaveCSS('color', 'rgb(154, 164, 178)');
  await expect(closest(page)).not.toContainText(/set to win|leads the week/);
  await expect(closest(page)).toContainText(/set to (stay ahead|pass) · /);
});

// The tap on the Closest match: its tier is the one the label names, in the first column.
async function showsItsTier(page) {
  const no = (await closest(page).getAttribute('aria-label')).match(/NA · T(\d)/)[1];
  await closest(page).click();
  const tier = page.locator(`.standing-match[data-match-id="1-${no}"]`);
  await expect(tier).toBeInViewport({ ratio: 0.5 });
  await expect(page.locator('.tier-spot'), 'the ring on the tier').toHaveCount(1);
  await expect(tier).not.toHaveClass(/tier-dimmed/);
  await expect(tier.locator('.found-mark'), 'the card of the team sheened, in that tier').toHaveCount(1);
  await expect(page.locator('.standing-side .found-mark')).toHaveCount(1);
  await expect(tier.locator('.guild-found-strip'), 'no "from your search" strip without a search').toHaveCount(0);
}

test.describe('team names the table does not hold', () => {
  test.describe('long ones', () => {
    test.use({ timeline: longTeams(10) });

    test('at 320 the Closest match cuts the names inside the box, the whole name is in its label', async ({ page, wvw }) => {
      await load(page, wvw);
      await phone(page, 320);
      await wvw.settle();
      await expect(closest(page)).toBeVisible();
      const names = closest(page).locator('.hl-vprow .hl-cut-nm');
      await expect(names).toHaveCount(2);
      const tile = await closest(page).boundingBox();
      for (const nm of await names.all()) {
        const text = await nm.textContent();
        expect(text, 'a long name').toMatch(/^Unknown team \(ID 99999999\d{2,3}\)$/);
        const fits = await nm.evaluate(n => {
          const css = getComputedStyle(n);
          return { cut: n.scrollWidth > n.clientWidth && css.overflowX === 'hidden' && css.textOverflow === 'ellipsis', right: n.getBoundingClientRect().right };
        });
        expect(fits.cut, `${text} is cut with an ellipsis`).toBe(true);
        expect(fits.right, `${text} ends inside the tile`).toBeLessThanOrEqual(tile.x + tile.width);
        expect(await closest(page).getAttribute('aria-label'), 'the whole name is said').toContain(text);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no sideways scroll').toBeLessThanOrEqual(320);
      const box = await panel(page).boundingBox();
      expect(box.x + box.width, 'the panel inside 320').toBeLessThanOrEqual(320);
    });

    test('the Closest match brings its tier into view and rings it', async ({ page, wvw }) => {
      await load(page, wvw);
      await showsItsTier(page);
    });
  });

  test.describe('no team on a side', () => {
    test.use({ timeline: noTeams(10) });

    test('the tiles name the side by its colour', async ({ page, wvw }) => {
      await load(page, wvw);
      await expect(closest(page)).toHaveAccessibleName(/^Closest match, NA · T\d: (Red|Blue|Green), (Red|Blue|Green), [\d,]+ VP; (Red|Blue|Green), (Red|Blue|Green), [\d,]+ VP;/);
      const rows = await closest(page).locator('.hl-vprow .hl-cut-nm').allTextContents();
      expect(rows, 'the two rows').toHaveLength(2);
      for (const r of rows) expect(r).toMatch(/^(Red|Blue|Green)$/);
      await expect(hot(page)).toBeVisible();
      await expect(busy(page)).toBeVisible();
    });

    test('the Closest match brings its tier into view and rings it', async ({ page, wvw }) => {
      await load(page, wvw);
      await showsItsTier(page);
    });
  });

  test.describe('the red side only', () => {
    test.use({ timeline: redOnly(10) });

    test('the Closest match moves the ring a search left on another tier', async ({ page, wvw }) => {
      await load(page, wvw);
      await search(page, wvw.guilds[1]);
      const team = await page.locator('#searchAnswer .search-team').textContent();
      await page.getByRole('button', { name: new RegExp(`^Show ${team} in the standings`) }).click();
      await expect(page.locator('.tier-spot')).toHaveCount(1);
      const ringed = await page.locator('.standing-match:not(.tier-dimmed)').evaluateAll(l => l.map(t => t.dataset.matchId));
      const searched = await page.locator('.standing-match:has(.found-mark)').getAttribute('data-match-id');
      expect(`1-${(await closest(page).getAttribute('aria-label')).match(/NA · T(\d)/)[1]}`, `the search (${searched}) is on another tier than the Closest match's`).not.toBe(searched);
      await showsItsTier(page);
      const now = await page.locator('.standing-match:not(.tier-dimmed)').evaluateAll(l => l.map(t => t.dataset.matchId));
      expect(now, 'the ring left the search\'s tier').not.toEqual(ringed);
    });
  });
});
