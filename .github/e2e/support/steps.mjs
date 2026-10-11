// Moves several specs make the same way. Nothing here asserts a rule of its
// own beyond "the thing a visitor waits for appeared".
import { expect } from '@playwright/test';

// A phone's screen at `width`, as the check-page puts it (the protocol's device
// override, mobile on). A page wider than the screen makes the layout widen to fit
// and innerWidth then differs: `exact` (default) says so, for the steps that
// check the width first; the others only measure.
export async function phone(page, width, { exact = true, height = 800 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  if (!exact) return cdp;
  const inner = () => page.evaluate(() => innerWidth);
  try {
    await expect.poll(inner, { timeout: 5000 }).toBe(width);
  } catch {
    const why = await page.evaluate(w => {
      const past = [...document.querySelectorAll('body *')].filter(e => {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return r.width && r.right > w + 0.5 && cs.position !== 'fixed' && cs.display !== 'none'
          && ![...e.children].some(c => c.getBoundingClientRect().right > w + 0.5);
      }).slice(0, 6).map(e => e.tagName + '.' + String(e.className?.baseVal ?? e.className).split(' ').slice(0, 2).join('.'));
      return `innerWidth ${innerWidth}, page ${document.documentElement.scrollWidth} px wide; past ${w}: ${past.join(' | ') || 'none'}`;
    }, width);
    throw new Error(`a ${width} px phone got a wider layout: ${why}`);
  }
  return cdp;
}

// The guild search, typed as a visitor does, to the end: "Done", the rows, the
// match panels, the button back. Watches the standings meanwhile, so that the
// blink and the strip cannot be missed between two looks.
export async function search(page, names) {
  await page.evaluate(() => {
    window.__found = { flash: false, strip: null, gone: false };
    new MutationObserver(() => {
      const f = window.__found;
      if (document.querySelector('.guild-found-flash')) f.flash = true;
      const s = document.querySelector('.guild-found-strip');
      if (s) { f.strip = s.textContent; f.gone = false; }
      else if (f.strip) f.gone = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.locator('#guildInput').focus();
  await page.keyboard.insertText(names.join('\n'));
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
  await expect(page.locator('#resultBody tr').first()).toBeVisible();
  await expect(page.locator('#matchPanelsContainer > *').first()).toBeAttached();
  await expect(page.locator('#runBtn')).toBeEnabled();
}
