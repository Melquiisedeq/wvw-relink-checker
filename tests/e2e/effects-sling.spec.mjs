import { test, expect } from './support/fixtures.mjs';
import { answer, hold } from './support/faults.mjs';
import { check, frame, load, search } from './support/steps.mjs';
import { slingGap } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// The page's clock stops a moment ahead, and only runFor moves it from there. It runs by
// itself until then, so the instant asked for may already be behind it: asked again, further on.
async function pause(page, wvw) {
  for (let ahead = 100; ; ahead *= 2) {
    try { return await page.clock.pauseAt(await wvw.now() + ahead); }
    catch (e) { if (!/past/.test(String(e)) || ahead > 5000) throw e; }
  }
}

// ---- the second explosion -----------------------------------------------------
// A search that finds a guild ends in the siege engine's blast: lobes, rays and
// shards thrown from the crest. They stay in the page after they fade; the next
// blast takes them out before it puts its own, so the pieces do not pile up.
test('a second search blasts again: the first one\'s lobes, rays and shards are gone', async ({ page, wvw }) => {
  await load(page, wvw);
  const PIECES = '.blast-lobe, .blast-ray, .impact-shard';
  const count = () => page.evaluate(sel => ({
    all: document.querySelectorAll(sel).length,
    first: document.querySelectorAll(sel.split(', ').map(x => x + '[data-first]').join(', ')).length,
    lobes: document.querySelectorAll('.blast-lobe').length,
    rays: document.querySelectorAll('.blast-ray').length,
    shards: document.querySelectorAll('.impact-shard').length,
  }), PIECES);
  await search(page, wvw.guilds[0]);
  await expect.poll(async () => (await count()).all, { message: 'the first blast thrown' }).toBeGreaterThan(0);
  expect(await count(), 'the first blast: lobes, rays, shards').toMatchObject({ lobes: 7, rays: 12, shards: 22 });
  await page.evaluate(sel => document.querySelectorAll(sel).forEach(e => e.setAttribute('data-first', '')), PIECES);
  await check(page, wvw, wvw.guilds[0]);
  await expect.poll(async () => (await count()).all - (await count()).first, { message: 'the second blast thrown' }).toBeGreaterThan(0);
  expect(await count(), 'after the second blast: none of the first, one blast of each').toEqual({ all: 41, first: 0, lobes: 7, rays: 12, shards: 22 });
});

// ---- the round on the sling ----------------------------------------------------
// Check gathers a round in the sling; the finale lets it go at the top of the swing, SWING_MS
// (js/trebuchet.js) after the launch. A Check pressed inside that window takes the new round up while the old one
// is still on the sling, and the old one is let go all the same.
// The clock is held, so the window is as wide as the test wants.
test.describe('the round on the sling', () => {
  test.use({ clock: 'playwright' });

  const ROUNDS = '.siege-charge';
  async function toDone(page, { press = true } = {}) {
    if (press) await page.locator('#runBtn').click();
    for (let i = 0; i < 100; i++) {
      if (await page.locator('#searchAnswer .search-card, #searchAnswer .search-err').count()) return;
      await page.clock.runFor(100);
      await page.waitForTimeout(20);
    }
    await expect(page.locator('#searchAnswer .search-card, #searchAnswer .search-err')).toBeVisible();
  }
  // On to the launch, a few ms into the swing (SWING_MS).
  async function toSwing(page) {
    for (let i = 0; i < 100; i++) {
      if (await page.locator('#trebuchet.firing').count()) return;
      await page.clock.runFor(10);
    }
    await expect(page.locator('#trebuchet')).toHaveClass(/firing/);
  }

  test('let go at the top of the swing it flies, and is gone when it lands', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await expect(page.locator(`${ROUNDS}.charging`), 'the round gathering in the sling').toHaveCount(1);
    await toSwing(page);
    await expect(page.locator(`${ROUNDS}.charging`), 'the round still in the sling, the swing under way').toHaveCount(1);
    await page.clock.runFor(200);
    await expect(page.locator(`${ROUNDS}.flying`), 'the round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`)).toHaveCount(0);
    await page.clock.runFor(700);
    await expect(page.locator(ROUNDS), 'the round, landed').toHaveCount(0);
    await wvw.settle();
  });

  test('a Check pressed in the swing: the new round keeps riding the sling after the old one is let go', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    await page.locator('#runBtn').click();
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    // Knocked off the sling on purpose: only the round's own follower, run on a frame, puts it back.
    const knockedBack = () => page.evaluate(() => {
      const b = document.querySelector('.siege-charge.charging');
      if (!b) return null;
      b.style.left = '-999px';
      return true;
    });
    const gaps = [];
    for (let i = 0; i < 6; i++) {
      if (!(await knockedBack())) break;
      await page.clock.runFor(20);
      gaps.push(await slingGap(page));
    }
    const seen = gaps.filter(g => g !== null);
    expect(seen.length, 'samples taken while the new round gathers').toBeGreaterThan(2);
    expect(Math.max(...seen), "the new round's distance (px) from the sling's tip after being knocked off it").toBeLessThan(5);
    await wvw.settle();
  });

  test('a Check pressed before the deferred launch: the old round is let go and lands, the new one keeps gathering', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await expect(page.locator('#trebuchet.firing'), 'the answer beat the wind-up: no swing yet').toHaveCount(0);
    await page.locator('#runBtn').click();
    // Stepped to the first round let go: the new search must not be over yet, or its own round would fly too.
    for (let i = 0; i < 100 && !(await page.locator(`${ROUNDS}.flying`).count()); i++) await page.clock.runFor(10);
    await expect(page.locator(`${ROUNDS}.flying`), 'the old round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round, still gathering').toHaveCount(1);
    await page.clock.runFor(30);
    await expect(page.locator(`${ROUNDS}.flying`), 'only the old round has flown').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round is still on the sling').toHaveCount(1);
    await page.evaluate(() => { window.__oldRound = document.querySelector('.siege-charge.flying'); });
    await page.clock.runFor(700);
    expect(await page.evaluate(() => window.__oldRound.isConnected), 'the old round, landed and gone').toBe(false);
    await wvw.settle();
  });

  test('a Check pressed before the last round is let go takes up a new one beside it', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    await expect(page.locator(`${ROUNDS}.charging`), 'the first round, in the swing').toHaveCount(1);
    await page.locator('#runBtn').click();
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round and the first one, not yet let go').toHaveCount(2);
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round, still gathering').toHaveCount(1);
    await toDone(page, { press: false });
    await toSwing(page);
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the second round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`)).toHaveCount(0);
    await page.clock.runFor(1000);
    await expect(page.locator(ROUNDS), 'both rounds landed').toHaveCount(0);
    await wvw.settle();
  });

  test('the second round let go soon after the first one struck keeps the broken shield for its own 1.2 s', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    await page.locator('#runBtn').click();
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    // The second round is let go as the first strikes; the first strike's 1.2 s runs out mid-break of the second.
    let struck = false, second = false;
    for (let t = 0; t < 4000 && !second; t += 10) {
      await page.clock.runFor(10);
      struck = struck || (await page.locator('#impactOverlay.broken').count()) > 0;
      second = struck && (await page.locator(`${ROUNDS}.flying`).count()) > 0;
    }
    expect(second, 'the second round, let go after the first impact').toBe(true);
    await page.clock.runFor(1300);
    await expect(page.locator('#impactOverlay.play.broken'), "the second round's shield, broken and still up").toHaveCount(1);
    await page.clock.runFor(700);
    await expect(page.locator('#impactOverlay.play'), "the second round's shield, gone with its own 1.2 s").toHaveCount(0);
    await wvw.settle();
  });

  test('a second round let go 700 ms after the first one struck keeps its shield through the flight', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    // The second search's name read is held, so its round cannot be let go before the first strikes.
    const release = await hold(page, new RegExp(`/guild/search\\?name=${encodeURIComponent(wvw.guilds[1])}$`));
    await page.locator('#guildInput').fill(wvw.guilds[1]);
    await page.locator('#runBtn').click();
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    for (let t = 0; t < 2000 && !(await page.locator('#impactOverlay.broken').count()); t += 10) await page.clock.runFor(10);
    await expect(page.locator('#impactOverlay.broken'), 'the first impact').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.flying`), 'no second round in the air yet').toHaveCount(0);
    await page.clock.runFor(700);
    release();
    await expect.poll(() => release.reads, { message: 'the second search read, held' }).toBe(1);
    await toDone(page, { press: false });
    for (let t = 0; t < 2000 && !(await page.locator(`${ROUNDS}.flying`).count()); t += 10) await page.clock.runFor(10);
    await expect(page.locator(`${ROUNDS}.flying`), 'the second round, let go').toHaveCount(1);
    // Past the first impact's 1.2 s, short of the second round's landing.
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the second round still in the air').toHaveCount(1);
    await expect(page.locator('#impactOverlay.play'), 'its shield, still up').toHaveCount(1);
    await wvw.settle();
  });

  // Two rounds in the air with the first one landing as the second is let go; stepped to the second's landing.
  async function twoInTheAir(page, wvw, onStep) {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    await page.locator('#runBtn').click();
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    await toDone(page, { press: false });
    for (let t = 0; t < 4000; t += 10) {
      await page.clock.runFor(10);
      await onStep();
    }
  }

  test('a second round landing on a shield the first already broke breaks it afresh', async ({ page, wvw }) => {
    const seen = [];
    let second = false, inAir = 0;
    await twoInTheAir(page, wvw, async () => {
      const now = await page.evaluate(() => {
        const a = document.querySelector('#impactOverlay .crest-side--l').getAnimations().find(x => x.animationName === 'half-l');
        window.__halves = window.__halves || [];
        if (a && !window.__halves.includes(a)) window.__halves.push(a);
        return { halves: window.__halves.length, flying: document.querySelectorAll('.siege-charge.flying').length };
      });
      inAir = Math.max(inAir, now.flying);
      second = second || inAir > 1;
      seen.push(now.halves);
    });
    expect(second, 'both rounds in the air together').toBe(true);
    expect(Math.max(...seen), 'a new break animation for each landing').toBe(2);
    await wvw.settle();
  });

  test('the cards keep their blur off while a second round is still gathering after the first landed', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    // The second search's name read is held: its round gathers on.
    const release = await hold(page, new RegExp(`/guild/search\\?name=${encodeURIComponent(wvw.guilds[1])}$`));
    await page.locator('#guildInput').fill(wvw.guilds[1]);
    await page.locator('#runBtn').click();
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    for (let t = 0; t < 2000 && !(await page.locator('#impactOverlay.broken').count()); t += 10) await page.clock.runFor(10);
    await expect(page.locator('#impactOverlay.broken'), 'the first impact').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`), 'the second round, still gathering').toHaveCount(1);
    await page.clock.runFor(2000);
    await expect(page.locator(`${ROUNDS}.charging`), 'the second round, still gathering').toHaveCount(1);
    await expect(page.locator('html.finale'), 'the blur still off, past the first impact\'s tail').toHaveCount(1);
    release();
    await wvw.settle();
    for (let t = 0; t < 8000 && (await page.locator('html.finale').count()); t += 100) await page.clock.runFor(100);
    await expect(page.locator('html.finale'), 'the blur back once the second round struck').toHaveCount(0);
  });

  test('the first round let go after a Check pressed before the deferred launch leaves the beam cocked for the new round', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await expect(page.locator('#trebuchet.firing'), 'no swing yet').toHaveCount(0);
    // The new search's name read is held: its own round is never let go here.
    const release = await hold(page, new RegExp(`/guild/search\\?name=${encodeURIComponent(wvw.guilds[1])}$`));
    await page.locator('#guildInput').fill(wvw.guilds[1]);
    await page.locator('#runBtn').click();
    for (let i = 0; i < 100 && !(await page.locator(`${ROUNDS}.flying`).count()); i++) await page.clock.runFor(10);
    await expect(page.locator(`${ROUNDS}.flying`), 'the old round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round, on the sling').toHaveCount(1);
    await expect(page.locator('#trebuchet'), 'the beam cocked for the new round').toHaveClass(/cocking/);
    release();
    await wvw.settle();
  });

  test('a click on the page with a round gathering throws its own shot and leaves the beam cocked', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await page.locator('#runBtn').click();
    await expect(page.locator(`${ROUNDS}.charging`), 'the round, gathering').toHaveCount(1);
    await expect(page.locator('#trebuchet')).toHaveClass(/cocking/);
    await page.mouse.click(900, 600);
    await page.clock.runFor(200);
    await expect(page.locator('.siege-shot'), "the click's shot, in the air").toHaveCount(1);
    await expect(page.locator('#trebuchet'), 'the beam still cocked, the round still on the sling').toHaveClass(/cocking/);
    await expect(page.locator(`${ROUNDS}.charging`)).toHaveCount(1);
    await wvw.settle();
  });
});
