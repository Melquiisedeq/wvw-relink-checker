// The hours the page writes, in other time zones and languages: "Synced", the
// map's corner and its note, and the skirmish block.
//
// Zones: Berlin and Los Angeles, which change the clock (the two changes of
// autumn 2026), and Sao Paulo, which does not. Languages: en-US and pt-BR.
//
//   static    three instants - the EU reset, the NA reset, and 80 min into the
//             NA week - each written
//             as the zone and language say, never "Invalid Date"/"NaN", and the
//             skirmish block the same everywhere (it counts from the match's
//             start in UTC, not from the zone's midnight).
//   crossing  the page open while the zone changes its clock - Berlin's
//             change (10 s before it: 02:59:50 CEST then 02:00:00 CET) and Los
//             Angeles' (01:59:50 PDT then 01:00:00 PST) - the map's hours still
//             those of the zone, "Synced" rewritten after the change on the
//             new offset, once.
// What an hour must read is worked out here with Intl, in Node, from the
// instant the page itself gives (a <time>'s datetime, its Date.now()).
import { test, expect } from './support/fixtures.mjs';
import { at, MIN, HOUR } from './support/scenarios.mjs';
import { recording } from './support/recordings.mjs';
import { iso } from './support/steps.mjs';

const ZONES = [
  { zone: 'Europe/Berlin', city: 'Berlin' },
  { zone: 'America/Los_Angeles', city: 'Los Angeles' },
  { zone: 'America/Sao_Paulo', city: 'Sao Paulo' },
];
const LOCALES = ['en-US', 'pt-BR'];
const DAY = 24 * HOUR;

// The instants, from the recording's own, so a new recording moves them.
// Resets: the first Friday 18:00Z (EU) and Saturday 02:00Z (NA) at least 13
// days on, so that the recorded weeks have rolled over twice. A change of the
// clock: the first hour after the recording at which the zone's offset differs
// from the hour before, found with Intl.
const FROM = recording().recordedAt;
const resetAfter = (from, day, hour) => {
  const d = new Date(from);
  d.setUTCHours(hour, 0, 0, 0);
  while (d.getUTCDay() !== day || d.getTime() <= from) d.setTime(d.getTime() + DAY);
  return d.getTime();
};
const offsetOf = (ms, zone) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).reduce((o, x) => ({ ...o, [x.type]: Number(x.value) }), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};
const changeAfter = (from, zone) => {
  const first = Math.ceil(from / HOUR) * HOUR;
  for (let t = first; t < first + 400 * DAY; t += HOUR) if (offsetOf(t, zone) !== offsetOf(t - HOUR, zone)) return t;
  throw new Error(`zones: no change of clock in ${zone} within 400 days of ${new Date(from).toISOString()}`);
};
const euReset = resetAfter(FROM + 13 * DAY, 5, 18);
const naReset = resetAfter(FROM + 13 * DAY, 6, 2);
const ANCHORS = [euReset, naReset, naReset + 80 * MIN].map(iso);
const BLOCK = 2 * 60 * MIN;

// Chrome puts a narrow no-break space before AM/PM; Node's ICU may differ.
const squash = s => String(s).replace(/[\s ]+/g, ' ').trim();
const hhmm = (ms, zone, locale) => squash(new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: zone }));

// What the page says now, in one go.
const read = page => page.evaluate(() => {
  const q = sel => document.querySelector(sel);
  const ago = q('.info-popover .wvw-hud-ago');
  const small = q('.info-popover .wvw-hud-small2 time');
  const note = q('.info-popover .wvw-hud-note');
  const words = [...document.querySelectorAll('[title], [aria-label]')].map(e => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''));
  return {
    now: Date.now(),
    synced: ['NA', 'EU'].map(r => ({ text: q('#standingsStatus' + r).textContent, dots: q('#standingsStatus' + r).querySelectorAll('.live-dot').length, tip: q('#standingsStatus' + r + ' .live-dot')?.title })),
    ago: ago ? { text: ago.querySelector('.wvw-hud-when').textContent, at: Date.parse(ago.dateTime) } : null,
    small: small && !small.closest('[hidden]') && small.dateTime ? { text: small.textContent, at: Date.parse(small.dateTime) } : null,
    note: note && !note.hidden ? note.textContent : null,
    shown: document.body.innerText + ' ' + words.join(' '),
  };
});

async function opened(page, wvw, anchor) {
  await page.clock.setSystemTime(Date.parse(anchor));
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await wvw.settle();
}

async function openMapNote(page, wvw) {
  await page.locator('.tier-map-btn').first().click();
  await expect(page.locator('.info-popover .wvw-plot-wrap .wvw-hud-r')).toBeVisible();
  await wvw.settle();
  const when = page.locator('.info-popover .wvw-hud-r .wvw-hud-btn');
  await when.click();
  await expect(page.locator('.info-popover .wvw-hud-note')).toBeVisible();
}

// The invariants of one look; the problems, each starting with our own words.
function wrong(seen, zone, locale, { synced }) {
  const out = [];
  const bad = /Invalid Date|NaN|undefined/.exec(seen.shown);
  if (bad) out.push(`the page says "${bad[0]}": ...${seen.shown.slice(Math.max(0, bad.index - 40), bad.index + 40).replace(/\s+/g, ' ')}...`);
  for (const [i, s] of seen.synced.entries()) {
    const want = synced.map(t => `Synced ${hhmm(t, zone, locale)}`);
    if (!want.includes(squash(s.text))) out.push(`region ${i ? 'EU' : 'NA'} reads "${squash(s.text)}", wanted one of ${want.join(' / ')}`);
    if (s.dots !== 1) out.push(`region ${i ? 'EU' : 'NA'} has ${s.dots} live dots`);
    else if (s.tip !== 'Checks for new standings every half minute or so while you use the page') out.push(`region ${i ? 'EU' : 'NA'} live dot says "${s.tip}"`);
  }
  if (seen.ago) {
    if (!Number.isFinite(seen.ago.at)) out.push('the corner has no instant');
    else if (squash(seen.ago.text) !== hhmm(seen.ago.at, zone, locale)) out.push(`the corner reads "${squash(seen.ago.text)}" for ${new Date(seen.ago.at).toISOString()}, wanted ${hhmm(seen.ago.at, zone, locale)}`);
    if (seen.note !== null && !squash(seen.note).includes(`Score last changed at ${hhmm(seen.ago.at, zone, locale)}`)) out.push(`the note says "${squash(seen.note).slice(0, 160)}", wanted "Score last changed at ${hhmm(seen.ago.at, zone, locale)}"`);
  }
  if (seen.small && squash(seen.small.text) !== hhmm(seen.small.at, zone, locale)) {
    out.push(`the corner's second line reads "${squash(seen.small.text)}" for ${new Date(seen.small.at).toISOString()}, wanted ${hhmm(seen.small.at, zone, locale)}`);
  }
  return out;
}

for (const { zone, city } of ZONES) {
  for (const locale of LOCALES) {
    test.describe(`${city}, ${locale}`, () => {
      test.describe.configure({ timeout: 60 * 1000 });
      test.use({ clock: 'playwright', timezoneId: zone, locale, viewport: { width: 1280, height: 900 } });

      for (const anchor of ANCHORS) {
        test.describe(anchor, () => {
          test.use({ timeline: at(anchor) });
          test('the hours and the skirmish block', async ({ page, wvw }) => {
            await opened(page, wvw, anchor);
            await openMapNote(page, wvw);
            const seen = await read(page);
            expect(seen.ago, 'the map corner').not.toBeNull();
            const broken = wrong(seen, zone, locale, { synced: [Date.parse(anchor), seen.now] });
            expect(broken, `${anchor} in ${zone}, ${locale}: ${broken.join(' | ')}`).toEqual([]);

            // The block counts from the match's start; the zone has no say.
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await expect(page.locator('.info-popover')).toHaveCount(0);
            const start = Date.parse(wvw.timeline.body('1-1', Date.parse(anchor) - wvw.recordedAt).start_time);
            await page.locator('.standing-match[data-match-id="1-1"] .activity-btn[aria-label^="Show skirmish score trend"]').first().click();
            const head = page.locator('.info-popover .trend-live-head');
            await expect(head, 'the skirmish block being played').toBeVisible();
            const text = squash(await head.textContent());
            const after = (await read(page)).now;
            const block = t => { const h = (t - start) / 3600000; return `Block ${Math.floor(h / 2) + 1} playing · ${Math.round(((h % 2) / 2) * 120)} of 120 min`; };
            const wanted = [...new Set([Date.parse(anchor), after].map(block))];
            expect(wanted.includes(text), `the skirmish block reads "${text}", wanted ${wanted.join(' or ')} (start ${new Date(start).toISOString()})`).toBe(true);
          });
        });
      }
    });
  }
}

// The zone changes its clock while the page is open.
const CROSSINGS = [
  { city: 'Berlin', zone: 'Europe/Berlin' },
  { city: 'Los Angeles', zone: 'America/Los_Angeles' },
].map(c => ({ ...c, anchor: iso(changeAfter(FROM, c.zone) - 10 * 1000) }));
const clock24 = (ms, zone) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: zone });
for (const c of CROSSINGS) {
  for (const locale of LOCALES) {
    test.describe(`${c.city} changing its clock, ${locale}`, () => {
      test.describe.configure({ timeout: 90 * 1000 });
      test.use({ clock: 'playwright', timezoneId: c.zone, locale, viewport: { width: 1280, height: 900 }, timeline: at(c.anchor) });
      test('the hours stay the zone\'s across the change', async ({ page, wvw }) => {
        const clock = () => page.evaluate(() => new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        await page.clock.setSystemTime(Date.parse(c.anchor));
        const t0 = Date.parse(c.anchor);
        expect(await clock(), `the clock of ${c.zone} at ${c.anchor}`).toBe(clock24(t0, c.zone));
        await opened(page, wvw, c.anchor);
        await openMapNote(page, wvw);
        const times = [Date.parse(c.anchor)];
        const look = async what => {
          const seen = await read(page);
          times.push(seen.now);
          return { seen, what };
        };
        const first = await look('before the change');
        expect(squash(first.seen.synced[0].text), 'Synced before the change').toBe(`Synced ${hhmm(first.seen.now, c.zone, locale)}`);
        const early = wrong(first.seen, c.zone, locale, { synced: times });
        expect(early, `${c.zone} ${locale} before the change: ${early.join(' | ')}`).toEqual([]);

        // Ten seconds, and the clock has gone back an hour.
        await page.clock.fastForward(10 * 1000);
        expect(await clock(), `the clock of ${c.zone} ten seconds on`).not.toBe(clock24(t0, c.zone));
        expect(offsetOf(t0 + 10 * 1000, c.zone), `the offset of ${c.zone} before and after`).not.toBe(offsetOf(t0, c.zone));
        const crossed = await look('after the change');
        const mid = wrong(crossed.seen, c.zone, locale, { synced: times });
        expect(mid, `${c.zone} ${locale} just after the change: ${mid.join(' | ')}`).toEqual([]);

        // Until the standings are read again (every 5 min; an open popover
        // skips the tick): Synced follows the new offset.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(page.locator('.info-popover')).toHaveCount(0);
        const text0 = squash(first.seen.synced[0].text);
        let seen = crossed.seen;
        for (let i = 0; i < 12 && squash(seen.synced[0].text) === text0; i++) {
          await page.clock.fastForward(30 * 1000);
          await wvw.settle();
          seen = (await look('reading again')).seen;
          const broken = wrong(seen, c.zone, locale, { synced: times });
          expect(broken, `${c.zone} ${locale}, ${Math.round((seen.now - Date.parse(c.anchor)) / 1000)} s after ${c.anchor}: ${broken.join(' | ')}`).toEqual([]);
        }
        expect(squash(seen.synced[0].text), 'Synced after the standings were read again past the change').not.toBe(text0);
        expect([0, 1, 2, 3].map(k => `Synced ${hhmm(seen.now - k * 1000, c.zone, locale)}`), 'Synced is the zone\'s hour of a moment ago, on the new offset').toContain(squash(seen.synced[0].text));
        expect(squash(seen.synced[1].text), 'both regions say the same').toBe(squash(seen.synced[0].text));

        // The map opened now: its hours on the new offset.
        await openMapNote(page, wvw);
        const late = (await look('map opened after the change')).seen;
        expect(late.ago, 'the map corner').not.toBeNull();
        const last = wrong(late, c.zone, locale, { synced: times });
        expect(last, `${c.zone} ${locale}, map opened after the change: ${last.join(' | ')}`).toEqual([]);
      });
    });
  }
}
