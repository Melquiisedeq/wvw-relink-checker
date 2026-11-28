// The Leaders box of the highlights panel (js/highlights.js): five metrics turning every 5 s on the embers' frames,
// and what holds the turning. The page's clock is the test's (clock: 'playwright'), paused once the panel is up,
// so "5 s" is what runFor says, never what the machine took.
import { test, expect } from './support/fixtures.mjs';
import { load, play } from './support/steps.mjs';
import { loadNow, loadSettled } from './support/page.mjs';
import { MIN, copyTaken, frozen, hidden, playing, visible, wake, weekAtZero, weekFirstKill } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 }, clock: 'playwright', timeline: playing(40) });

// Our copy carries the Worker's count, so the five metrics are there; the cases without it say so.
let served;
test.beforeEach(async ({ page, wvw }) => { served = await copyTaken(page, wvw); });

const leaders = page => page.getByRole('region', { name: 'Leaders this week' });
const shown = (page, name) => leaders(page).getByRole('button', { name, pressed: true });
const pause = page => leaders(page).getByRole('button', { name: /^(Pause|Play) the leaders$/ });
const NAMES = ['Most kills', 'Most VP', 'Objective points', 'Most active', 'Best K/D'];
const which = async page => {
  for (const n of NAMES) if (await shown(page, n).count()) return n;
  return null;
};

// The page up, its clock stopped; then on until the box has just turned, so that what follows is counted from a turn.
async function opened(page, wvw, to = 'Most kills') {
  await load(page, wvw);
  await expect(leaders(page)).toBeVisible();
  await page.clock.pauseAt(await wvw.now() + 1000);
  await turned(page);
  for (let i = 0; i < 5 && (await which(page)) !== to; i++) await turned(page);
  expect(await which(page), `the box on ${to}, just turned`).toBe(to);
}
async function turned(page) {
  const was = await which(page);
  for (let i = 0; i < 40 && (await which(page)) === was; i++) await page.clock.runFor(250);
  expect(await which(page), 'the box turned').not.toBe(was);
}
// Tab until the focus is inside the box.
async function tabIn(page) {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await leaders(page).evaluate(box => box.contains(document.activeElement))) return;
  }
  throw new Error('Tab never reached the Leaders');
}
// Time passes in steps of 3 s, and the box stays where it is.
async function holds(page, ms = 12000) {
  const at = await which(page);
  await play(page, ms);
  expect(await which(page), `the box held for ${ms / 1000} s`).toBe(at);
  return at;
}

test('five metrics, one every 5 s, round to the first again; the screen reader hears the place', async ({ page, wvw }) => {
  await opened(page, wvw);
  await expect(leaders(page).getByText('Most kills, 1 of 5')).toHaveCount(1);
  await page.clock.runFor(2500);
  await page.clock.runFor(2000);
  await expect(shown(page, 'Most kills'), 'a turn is 5 s, not 4.5').toBeVisible();
  await page.clock.runFor(1000);
  await expect(shown(page, 'Most VP')).toBeVisible();
  const place = leaders(page).getByText('Most VP, 2 of 5');
  await expect(place).toHaveCount(1);
  await expect(place.locator('xpath=ancestor-or-self::*[@aria-hidden="true"]'), '"2 of 5" outside what the reader skips').toHaveCount(0);
  for (const name of ['Objective points', 'Most active', 'Best K/D', 'Most kills', 'Most VP']) {
    await play(page, 5200);
    await expect(shown(page, name)).toBeVisible();
  }
});

test('a number counts up on a turn, and is whole after', async ({ page, wvw }) => {
  await opened(page, wvw, 'Most VP');
  const said = await leaders(page).getByText(/^Most kills, this week: /).textContent();
  const final = said.match(/Most VP, this week: .+?, ([\d,]+) VP/)[1];
  await expect(leaders(page).getByText(final, { exact: true }), 'counting: not the whole number yet').toHaveCount(0);
  await page.clock.runFor(700);
  await expect(leaders(page).getByText(final, { exact: true })).toBeVisible();
});

test('Objective points: the best team\'s sum over the copy\'s counts, saying what is summed; none without a count', async ({ page, wvw }) => {
  await opened(page, wvw, 'Objective points');
  // The sum made apart, from the counts the copy served: the best colour of the region on show.
  const best = Math.max(...Object.entries(served).filter(([id, t]) => id[0] === '1' && t).flatMap(([, t]) => Object.values(t.points)));
  expect(best, 'objectives taken in the recording').toBeGreaterThan(0);
  const said = await leaders(page).getByText(/^Most kills, this week: /).textContent();
  const mine = said.match(/Objective points, this week: .+?, ([\d,]+) points · the value of each objective when taken, /);
  expect(Number(mine[1].replace(/,/g, ''))).toBe(best);
  await page.clock.runFor(700);
  await expect(leaders(page).getByText(mine[1], { exact: true })).toBeVisible();
  await expect(leaders(page).getByText('points · the value of each objective when taken').first()).toBeVisible();
});

test('a copy with no count: no objective points, the four others turn', async ({ page, wvw }) => {
  await copyTaken(page, wvw, { count: () => undefined });
  await load(page, wvw);
  await expect(leaders(page).getByRole('button', { name: 'Most kills' })).toBeVisible();
  await expect(leaders(page).getByRole('button', { name: 'Objective points' })).toHaveCount(0);
  await expect(leaders(page).getByText('New week · counted from the first objective taken'), 'the week is not new: objectives were taken').toHaveCount(0);
});

test.describe('what holds the turning', () => {
  test('the pause button: first in the box, holds until Play, and the Tab order goes on to the segments', async ({ page, wvw }) => {
    await opened(page, wvw);
    await tabIn(page);
    await expect(pause(page), 'the first stop in the box').toBeFocused();
    await expect(pause(page)).toHaveAccessibleName('Pause the leaders');
    await page.keyboard.press('Tab');
    await expect(leaders(page).getByRole('button', { name: 'Most kills' })).toBeFocused();
  });

  test('a press on Pause holds it, a press on Play turns it again', async ({ page, wvw }) => {
    await opened(page, wvw);
    await pause(page).click();
    await expect(pause(page)).toHaveAccessibleName('Play the leaders');
    await page.mouse.move(0, 0);
    const at = await holds(page);
    await pause(page).click();
    await expect(pause(page)).toHaveAccessibleName('Pause the leaders');
    await page.mouse.move(0, 0);
    await play(page, 5200);
    expect(await which(page)).not.toBe(at);
  });

  test('the pointer over the box holds it until it leaves', async ({ page, wvw }) => {
    await opened(page, wvw);
    await leaders(page).hover();
    const at = await holds(page);
    await page.mouse.move(0, 0);
    await play(page, 5200);
    expect(await which(page)).not.toBe(at);
  });

  test('the keyboard\'s focus in the box holds it until the focus leaves', async ({ page, wvw }) => {
    await opened(page, wvw);
    await tabIn(page);
    const at = await holds(page);
    await page.keyboard.press('Shift+Tab');
    await expect(pause(page)).not.toBeFocused();
    await play(page, 5200);
    expect(await which(page)).not.toBe(at);
  });

  test('a hidden tab holds it; back, it goes on from where it was, one turn at a time', async ({ page, wvw }) => {
    await opened(page, wvw);
    await play(page, 2000);
    const at = await which(page);
    await hidden(page, wvw, 0);
    await holds(page, 15000);
    await visible(page);
    await play(page, 1000);
    expect(await which(page), 'the time away did not count').toBe(at);
    await play(page, 4200);
    expect(await which(page), 'one turn after the 5 s').toBe(NAMES[(NAMES.indexOf(at) + 1) % 5]);
  });

  test('a long gap between two frames moves the fill one frame\'s worth', async ({ page, wvw }) => {
    await opened(page, wvw);
    await play(page, 1000);
    await wake(page, 60000);
    await play(page, 1000);
    expect(await which(page), 'a laptop waking is no 60 s of the box').toBe('Most kills');
  });

  test('a press on a segment goes to that metric and holds it; Play turns it again', async ({ page, wvw }) => {
    await opened(page, wvw);
    await leaders(page).getByRole('button', { name: 'Most active' }).click();
    await expect(shown(page, 'Most active')).toBeVisible();
    await expect(pause(page)).toHaveAccessibleName('Play the leaders');
    await page.mouse.move(0, 0);
    await holds(page);
    await pause(page).click();
    await page.mouse.move(0, 0);
    await play(page, 5200);
    await expect(shown(page, 'Best K/D')).toBeVisible();
  });

  test.describe('a touch', () => {
    test.use({ hasTouch: true });

    test('on the box holds it; on the button it presses once, as the button says', async ({ page, wvw }) => {
      await opened(page, wvw);
      await leaders(page).getByText('Leaders · 1/5 · this week').tap();
      await expect(pause(page)).toHaveAccessibleName('Play the leaders');
      await holds(page);
      await pause(page).tap();
      await expect(pause(page)).toHaveAccessibleName('Pause the leaders');
      await play(page, 5200);
      await pause(page).tap();
      await expect(pause(page), 'a touch on the button is the button\'s alone').toHaveAccessibleName('Play the leaders');
    });
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('starts still on the first metric; Play turns it, Pause holds it again', async ({ page, wvw }) => {
    await load(page, wvw);
    await expect(leaders(page)).toBeVisible();
    await page.clock.pauseAt(await wvw.now() + 1000);
    await expect(pause(page)).toHaveAccessibleName('Play the leaders');
    await expect(shown(page, 'Most kills')).toBeVisible();
    await holds(page, 15000);
    await pause(page).click();
    await expect(pause(page)).toHaveAccessibleName('Pause the leaders');
    await page.mouse.move(0, 0);
    await turned(page);
    await pause(page).click();
    await page.mouse.move(0, 0);
    await holds(page);
  });
});

test.describe('a repaint of the panel', () => {
  test.use({ timeline: playing(30) });

  // The standings are read again a minute on: the panel is painted from that answer, and a new box replaces the old.
  async function repainted(page, wvw) {
    const old = await leaders(page).elementHandle();
    await wvw.skew(MIN);
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    await expect.poll(() => old.evaluate(n => n.isConnected), 'the box painted again').toBe(false);
  }

  test('does not restart the 5 s, nor go back to the first metric', async ({ page, wvw }) => {
    await opened(page, wvw, 'Objective points');
    const at = await which(page);
    expect(at, 'a metric that is not the first').not.toBe(NAMES[0]);
    await play(page, 3000);
    await repainted(page, wvw);
    expect(await which(page), 'the same metric after the repaint').toBe(at);
    await play(page, 2200);
    expect(await which(page), '3 s before and 2.2 s after make a turn').toBe(NAMES[(NAMES.indexOf(at) + 1) % 5]);
  });

  test('the focus goes back to the control it was on, and leaving it lets the turning go on', async ({ page, wvw }) => {
    await opened(page, wvw, 'Objective points');
    await tabIn(page);
    await page.keyboard.press('Tab');
    const seg = leaders(page).getByRole('button', { name: 'Most kills' });
    await expect(seg).toBeFocused();
    await repainted(page, wvw);
    expect(await which(page), 'the repaint with the focus held stays on the metric').toBe('Objective points');
    await expect(leaders(page).getByRole('button', { name: 'Most kills' }), 'the focus on the same segment').toBeFocused();
    const at = await holds(page);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await play(page, 5200);
    expect(await which(page)).not.toBe(at);
  });
});

test.describe('a week\'s first minutes', () => {
  test.use({ timeline: weekAtZero(6) });

  test('no metric at 0 is a leader; a focus lost with its control does not stop the turning', async ({ page, wvw }) => {
    await load(page, wvw);
    await expect(leaders(page)).toBeVisible();
    await page.clock.pauseAt(await wvw.now() + 1000);
    await tabIn(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const vp = leaders(page).getByRole('button', { name: 'Most VP' });
    await expect(vp).toBeFocused();
    await wvw.skew(wvw.recordedAt + wvw.timeline.end - await wvw.now());
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    await expect(vp, 'no leader on 0 VP: the segment is gone with its focus').toHaveCount(0);
    // Nothing taken yet: the metric's slide says the week is new, in the place of a number.
    await expect(leaders(page).getByText('New week · counted from the first objective taken')).toHaveCount(2);
    await expect(leaders(page).getByRole('button', { name: 'Most kills' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Highlights, / }).getByText(/\b0 VP\b/)).toHaveCount(0);
    await play(page, 5200);
    await expect(shown(page, 'Most active'), 'the focus the box lost holds nothing').toBeVisible();
  });
});

test.describe('the week turns over', () => {
  test.use({ timeline: weekFirstKill(2, 4) });

  for (const width of [1280, 320]) {
    test(`at ${width} the box says the new week while every metric is 0, and keeps its height when the first kill comes`, async ({ page, wvw }) => {
      await page.setViewportSize({ width, height: 800 });
      await load(page, wvw);
      await expect(leaders(page)).toBeVisible();
      await wvw.skew(wvw.recordedAt + wvw.timeline.end - 4 * MIN - await wvw.now());
      await loadNow(page);
      await loadSettled(page);
      await wvw.settle();
      await expect(leaders(page).getByText('New week · first numbers soon')).toBeVisible();
      await expect(pause(page)).toHaveCount(0);
      const panel = page.getByRole('region', { name: /^Highlights, / });
      const quiet = await leaders(page).boundingBox();
      const quietPanel = await panel.boundingBox();
      await wvw.skew(4 * MIN);
      await loadNow(page);
      await loadSettled(page);
      await wvw.settle();
      await expect(leaders(page).getByText('New week · first numbers soon')).toHaveCount(0);
      await expect(leaders(page).getByRole('button', { name: 'Most kills' })).toBeVisible();
      const after = await leaders(page).boundingBox();
      expect(quiet.height, 'the box as high as with the numbers').toBeCloseTo(after.height, 0);
      expect((await panel.boundingBox()).height, 'the tiles under it did not move').toBeCloseTo(quietPanel.height, 0);
    });
  }
});

test.describe('the API stuck', () => {
  test.use({ timeline: frozen(40) });

  test('no slide says "now" over a body that stopped, and the week\'s count keeps "this week"', async ({ page, wvw }) => {
    await load(page, wvw);
    await expect(leaders(page)).toBeVisible();
    await wvw.skew(30 * MIN);
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    await expect(leaders(page).getByText(/Objective points, this week/)).toHaveCount(1);
    await expect(leaders(page).getByText(/, now:|· now/)).toHaveCount(0);
    await leaders(page).getByRole('button', { name: 'Objective points' }).click();
    await expect(leaders(page).getByText(/^Objective points$/)).toBeVisible();
    await expect(leaders(page).getByText(/data from|· now/)).toHaveCount(0);
  });
});

test('at 390 the box keeps its height through a whole round; the names under the segments from 360', async ({ page, wvw }) => {
  await opened(page, wvw);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(leaders(page).getByText('Active', { exact: true })).toBeVisible();
  const height = async () => (await leaders(page).boundingBox()).height;
  const h = await height();
  for (let i = 0; i < 5; i++) {
    await play(page, 5200);
    expect(await height(), 'the box did not grow or shrink on a turn').toBeCloseTo(h, 1);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(leaders(page).getByText('Active', { exact: true })).toBeHidden();
});
