// The camera button in the guilds popover's header: one click puts the whole list on the
// clipboard as a PNG (or shares or downloads it when the clipboard cannot take it), flashes
// the popover, turns the icon into a check and says the word in a bubble and to a screen reader.
import { test, expect } from './support/fixtures.mjs';
import { load } from './support/steps.mjs';

test.describe.configure({ timeout: 60 * 1000 });
test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
const POP = '.info-popover--guilds';
const SHOT = `${POP} .info-popover-shot`;

// Opens the popover of the nth visible guilds icon, content loaded.
async function openGuilds(page, wvw, nth = 0) {
  await load(page, wvw);
  const btn = page.locator('.server-guilds-btn').locator('visible=true').nth(nth);
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.locator(`${POP} .info-popover-body`)).toBeAttached();
  await wvw.settle();
  return btn;
}

test.describe('the screenshot button', () => {
  test('is in the header, left of expand, named, cyan and at least 24 px', async ({ page, wvw }) => {
    await openGuilds(page, wvw);
    const shot = page.locator(SHOT);
    await expect(shot).toHaveAccessibleName('Copy the list as an image');
    await expect(shot).toBeEnabled();
    expect(await page.locator(`${POP} .info-popover-header-actions button`).evaluateAll(
      bs => bs.map(b => b.className)), 'order in the header').toEqual(['info-popover-shot', 'info-popover-expand', 'info-popover-close']);
    const box = await shot.boundingBox();
    expect(box.width, 'target width').toBeGreaterThanOrEqual(24);
    expect(box.height, 'target height').toBeGreaterThanOrEqual(24);
    const accent = await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--accent)';
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(await shot.evaluate(b => getComputedStyle(b).color), 'the icon is the accent colour').toBe(accent);
  });

  test('a click writes the whole list as an image/png, flashes, shows the check and "Copied", then goes back', async ({ page, wvw, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      window.__drawn = [];
      const real = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) { window.__drawn.push(String(t)); return real.call(this, t, ...rest); };
    });
    await openGuilds(page, wvw);
    const names = await page.locator(`${POP} .guild-line`).evaluateAll(ls => ls.map(l => {
      let s = '';
      for (const n of l.childNodes) if (n.nodeType === 3) s += n.nodeValue;
      return s.trim();
    }));
    const team = await page.locator(`${POP} .info-popover-header > span`).textContent();
    const shot = page.locator(SHOT);
    const before = await shot.innerHTML();
    await shot.click();
    await expect(page.locator('.shot-flash'), 'the flash').toHaveCount(1);
    await expect(shot).toHaveClass(/shot-done/);
    expect(await shot.innerHTML(), 'the icon changed').not.toBe(before);
    await expect(page.locator('.shot-bubble')).toHaveText('Copied');
    await expect(page.locator(`${POP} [role=status]`), 'announced').toHaveText('Copied');
    expect(await page.evaluate(() => document.activeElement.classList.contains('info-popover-shot')), 'the focus stays on the button').toBe(true);
    const png = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      const bmp = await createImageBitmap(blob);
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      return { types: items[0].types, head: [...head], w: bmp.width, h: bmp.height };
    });
    expect(png.types).toEqual(['image/png']);
    expect(png.head, 'a PNG signature').toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.w, 'drawn at 2x of 880').toBe(1760);
    expect(png.h).toBeGreaterThan(200);
    const drawn = await page.evaluate(() => window.__drawn.join('\n'));
    expect(drawn, 'the team name').toContain(team);
    expect(drawn, 'the site').toContain('wvwrelink.com');
    expect(names.length, 'the popover has a list').toBeGreaterThan(0);
    for (const n of names) {
      for (const word of n.split(/\s+/)) expect(drawn, `guild ${n}`).toContain(word);
    }
    await expect(page.locator('.shot-flash'), 'the flash is gone').toHaveCount(0);
    await expect(shot).not.toHaveClass(/shot-done/);
    await expect(page.locator('.shot-bubble'), 'the bubble is gone').toHaveCount(0);
    await expect(page.locator(`${POP} [role=status]`)).toHaveText('');
  });

  test('without a clipboard write it downloads the PNG and says "Saved"; a broken canvas says "Failed"', async ({ page, wvw }) => {
    await page.addInitScript(() => {
      // The task of the click: set when it starts, cleared in the next task. A write made
      // after awaiting the blob falls outside it, which is where Safari drops the gesture.
      window.__inClick = false;
      window.addEventListener('click', () => { window.__inClick = true; setTimeout(() => { window.__inClick = false; }, 0); }, true);
      Object.defineProperty(navigator, 'clipboard', { value: { write: () => { window.__writeInClick = window.__inClick; return Promise.reject(new DOMException('no', 'NotAllowedError')); } }, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    });
    await openGuilds(page, wvw);
    const shot = page.locator(SHOT);
    const [download] = await Promise.all([page.waitForEvent('download'), shot.click()]);
    expect(await page.evaluate(() => window.__writeInClick), 'clipboard.write is called inside the click').toBe(true);
    expect(download.suggestedFilename()).toBe('wvwrelink-guilds.png');
    await expect(page.locator('.shot-bubble')).toHaveText('Saved');
    await expect(shot).not.toHaveClass(/shot-done/, { timeout: 5000 });
    await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); }; });
    await shot.click();
    await expect(page.locator('.shot-bubble')).toHaveText('Failed');
    await expect(page.locator(`${POP} [role=status]`)).toHaveText('Failed');
    await expect(shot, 'no check on a failure').not.toHaveClass(/shot-done/);
  });

  test('a share that fails falls back to the download; a cancelled one stays quiet', async ({ page, wvw }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      navigator.share = () => Promise.reject(new DOMException(window.__shareError, window.__shareError));
    });
    await openGuilds(page, wvw);
    await page.evaluate(() => { window.__shareError = 'NotAllowedError'; });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator(SHOT).click()]);
    expect(download.suggestedFilename()).toBe('wvwrelink-guilds.png');
    await expect(page.locator('.shot-bubble')).toHaveText('Saved');
    await expect(page.locator('.shot-bubble')).toHaveCount(0);
    await page.evaluate(() => { window.__shareError = 'AbortError'; });
    await page.locator(SHOT).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.shot-bubble'), 'a cancel shows nothing').toHaveCount(0);
  });

  test.describe('in Los Angeles', () => {
    test.use({ timezoneId: 'America/Los_Angeles' });
    test('the date on the image is the local one, not UTC', async ({ page, wvw }) => {
      await page.addInitScript(() => {
        window.__drawn = [];
        const real = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) { window.__drawn.push(String(t)); return real.call(this, t, ...rest); };
      });
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await openGuilds(page, wvw);
      // 20:00 on 14 March 2026 in Los Angeles (PDT), already the 15th in UTC.
      await page.evaluate(() => globalThis.__skewClock(Date.UTC(2026, 2, 15, 3, 0) - Date.now()));
      await page.locator(SHOT).click();
      await expect(page.locator('.shot-bubble')).toHaveText('Copied');
      expect(await page.evaluate(() => window.__drawn)).toContain('wvwrelink.com · 2026-03-14');
    });
  });

  test('a guild name with no spaces, wider than the column, is cut inside it', async ({ page, wvw }) => {
    await openGuilds(page, wvw);
    const widths = await page.evaluate(() => {
      const seen = [];
      const real = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) { seen.push({ t: String(t), w: this.measureText(String(t)).width }); return real.call(this, t, ...rest); };
      const name = 'W'.repeat(200);
      guildsShotCanvas('Team', [{ tag: 'AB', name: 'Alliance', members: [{ tag: 'XY', name, region: 'NA' }] }], []);
      CanvasRenderingContext2D.prototype.fillText = real;
      return { seen, name };
    });
    const pieces = widths.seen.filter(p => /W{5}/.test(p.t));
    expect(pieces.length, 'cut into several lines').toBeGreaterThan(1);
    expect(pieces.map(p => p.t).join('').replace(/[^W]/g, ''), 'no character lost').toBe(widths.name);
    // One alliance: one column, 836 px wide, the text inset 20 px inside the card.
    for (const p of pieces) expect(p.w, 'inside the column').toBeLessThanOrEqual(836 - 30);
  });

  test('a popover with no list has the button disabled', async ({ page, wvw }) => {
    const trigger = await openGuilds(page, wvw);
    await page.evaluate(() => {
      const pop = document.querySelector('.info-popover--guilds');
      renderGuildsPopoverContent(pop, 'Nowhere', undefined, document.querySelector('.server-guilds-btn.active'));
    });
    await expect(page.locator('.info-popover-body .hint')).toHaveText(/No guilds listed/);
    await expect(page.locator(SHOT)).toBeDisabled();
    await expect(trigger).toHaveClass(/active/);
  });
});
