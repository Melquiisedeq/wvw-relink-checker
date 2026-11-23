// The skirmish trend's match is served and its score's time is the page's clock when it rose (page.clock);
// only the trend with that time unknown is planted.
//
// Each test opens a new page and asks of the game only what the recording
// holds: the tier's match (?id=), the lists, and the guild tactics, which the
// recording answers one by one in any order (support/recordings.mjs). A read it
// cannot answer fails the test, naming the address.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { recordedJson, load, firstTier } from './support/steps.mjs';
import { loadNow, loadSettled, trendTexts } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

const ALL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';

// The skirmish trend, red's, of NA tier 1's match (1-1) served with a case's blocks: the page sees the
// body a point lower first, then its score rise with the page's clock at the case's `at` (the score's
// time), and the trend opens with the clock stood at `now`.
const H = 3600000;
const MIN = 60000;
const sk = n => ({ scores: { red: n, blue: n, green: n } });
const iso = t => new Date(t).toISOString();

async function trendSeen(page, wvw, { start, blocks, at, now }) {
  const id = '1-1';
  const recorded = recordedJson(ALL);
  const match = { ...structuredClone(recorded.find(m => m.id === id)),
    start_time: iso(start), end_time: iso(start + 168 * H), skirmishes: blocks.map(sk) };
  let body = { ...match, scores: { ...match.scores, red: match.scores.red - 1 } };
  await answer(page, ALL, () => recorded.map(m => (m.id === id ? body : m)));
  await load(page, wvw);
  // The same body just before: it ends the gap of the jump, so the rise is one the page watched.
  await page.clock.setFixedTime(at - 10e3);
  await loadNow(page, 'manual');
  await loadSettled(page);
  body = match;
  await page.clock.setFixedTime(at);
  await loadNow(page, 'manual');
  await loadSettled(page);
  await page.clock.setFixedTime(now);
  await page.locator(`.standing-match[data-match-id="${id}"] .side-red`)
    .getByRole('button', { name: /^Show skirmish score trend for / }).click();
  return page.locator('.info-popover--trend').textContent();
}

// Each case: its blocks, the score's time and the clock's from the match's start, and what the text says.
// The match starts so that every instant is past the page's opening, so the clock jumps forward to
// each `at`; `now` before `at` (a body ahead of the clock) sets it back.
const TREND = {
  // The clock a block ahead of the body: 63 whole blocks of 1,000 and a 64th of 400, the clock 30 min
  // into block 65. Body time before the end of block 64 (the API froze mid-block): 400 is not "Last
  // block", the average ignores it and the text says the data stopped. Body time after it: 400 is a
  // finished block, as before.
  'stalled: a block cut off midway is not the last block': {
    blocks: [...Array(63).fill(1000), 400], at: 128 * H - 40 * MIN, now: 128.5 * H,
    says: [[/Last block\s*400/, false, 'a block cut off midway'], [/Last block\s*1,000/], [/63 of 84 finished/, true, 'the finished count'],
      [/stopped partway through block 64/, true, 'the text says the data stopped'], [/ArenaNet hasn't published/, false]],
  },
  'stalled: a body past the end of block 64 shows it finished': {
    blocks: [...Array(63).fill(1000), 400], at: 128 * H + 5 * MIN, now: 128.5 * H,
    says: [[/Last block\s*400/], [/64 of 84 finished/], [/stopped partway/, false]],
  },
  // Just after the turn of a block the body is still the old one, but it rose minutes ago: that is the
  // API running behind, not a stop. The block that closed counts and the text does not say the data stopped.
  'a body that rose minutes ago, just after the turn, is not stalled': {
    blocks: [...Array(63).fill(1000), 400], at: 128 * H - MIN, now: 128 * H + 2 * MIN,
    says: [[/stopped partway/, false, 'no stop right after the turn'], [/ArenaNet hasn't published this block yet/],
      [/Last block\s*400/, true, 'the block that closed counts'], [/64 of 84 finished/]],
  },
  'a body 22 min old, just after the turn, is a real stop': {
    blocks: [...Array(63).fill(1000), 400], at: 128 * H - 20 * MIN, now: 128 * H + 2 * MIN,
    says: [[/stopped partway through block 64/]],
  },
};
// The pace of the block being played divides by how far into it the body was, not by the clock: the clock
// 60 min into block 65, which holds 500 points (20 in a body from before it).
const PLAY = [...Array(64).fill(1000), 500];
const BLOCK = 128 * H;
const CLOCK = BLOCK + 60 * MIN;
for (const [name, at, says, blocks = PLAY] of [
  ['body 6 min behind: 500 at 54 of 120, exactly the margin: still "so far"', BLOCK + 54 * MIN,
    [[/on pace for\s*1,111/], [/500 so far · on pace/]]],
  ['body 10 min behind: the body\'s own minute', BLOCK + 50 * MIN, [[/500 by minute 50 · on pace for\s*1,200/]]],
  ['early and past the margin: the body\'s minute', BLOCK + 40 * MIN, [[/500 by minute 40 · too early to project/]]],
  ['the pace follows the minute shown, not the exact fraction', BLOCK + 48.4 * MIN, [[/500 by minute 48 · on pace for\s*1,250/]]],
  ['a second past the margin: its minute', CLOCK - 6 * MIN - 1000, [[/500 by minute 54 · on pace for/]]],
  ['body at 10 min: too early, never a division by a sliver', BLOCK + 10 * MIN, [[/too early to project/]]],
  ['a body from before the block is at its start: too early, not a low pace', BLOCK - 30 * MIN,
    [[/20 so far · too early to project/]], [...Array(64).fill(1000), 20]],
  ['a body ahead of the clock: capped at it', CLOCK + 30 * MIN, [[/so far · on pace for\s*1,000/]]],
]) TREND[`pace: ${name}`] = { blocks, at, now: CLOCK, says };

test.describe('skirmish trend', () => {
  test.use({ clock: 'playwright' });
  for (const [name, c] of Object.entries(TREND)) {
    test(name, async ({ page, wvw }) => {
      const start = wvw.opensAt + H - Math.min(c.at, c.now);
      const out = await trendSeen(page, wvw, { start, blocks: c.blocks, at: start + c.at, now: start + c.now });
      for (const [re, has = true, why] of c.says) {
        if (has) expect(out, why).toMatch(re);
        else expect(out, why).not.toMatch(re);
      }
    });
  }
});

// A score whose time the page does not know (0) paces by the clock's fraction. No served body reaches
// it: every body the page keeps is stamped when it came, so the time is set in the page.
test('skirmish trend pace, the score\'s time unknown: the clock\'s fraction', async ({ page, wvw }) => {
  await load(page, wvw);
  const id = (await firstTier(page)).id;
  const start = await wvw.now() - (128 * H + 1 * H);
  const match = { id, start_time: iso(start), end_time: iso(start + 168 * H), skirmishes: PLAY.map(sk) };
  const out = await trendTexts(page, { unknown: { match, at: 0 } }, start + CLOCK);
  expect(out.unknown, 'time unknown: the clock\'s fraction').toMatch(/so far · on pace for\s*1,000/);
});
