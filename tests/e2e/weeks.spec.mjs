// Weeks and line-ups: a relink night where the API's list is partial or still
// on last week, the first hours of a week, the Check on a relink day, and the
// week's line-up the page keeps between loads (wvw-weeks-v1).
//
// The recording is the world here, bent by the test into the state in the
// test's name: a list without some tiers, a tier on last week's body, a team
// the API has not got yet. Only "a fresh week" is the factory's (gw2.newWeek).
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { check, iso, recordedJson, matchReads, serveList } from './support/steps.mjs';
import { MIN, FOCUS } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 }, timezoneId: 'UTC', locale: 'en-US' });

const GAME = 'https://api.guildwars2.com/v2/';
const ALL = GAME + 'wvw/matches?ids=all';
const IDS = GAME + 'wvw/matches?ids=';
const WEEK = 7 * 86400000;
const NA = '#standingsGridNA > .standing-match';
const TEAMS = ['red', 'blue', 'green'];
// The team of a tier the new line-up brought (ids from 10000 are the real ones).
const team = m => TEAMS.map(c => String(m.all_worlds[c].find(n => n >= 10000)));
const nameOf = (page, id) => page.evaluate(i => getTeamName(i), String(id));
const names = (page, m) => page.evaluate(t => t.map(getTeamName), team(m));

async function opened(page, wvw) {
  await page.goto(wvw.url);
  await expect(page.locator(NA)).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await wvw.settle();
}

// The NA cards, as the standings show them.
const cards = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(b => ({
  id: b.dataset.matchId, sides: b.querySelectorAll('.standing-side').length,
  stale: b.querySelectorAll('.standing-stale').length, map: !!b.querySelector('.tier-map-btn'),
  title: b.querySelector('.standing-match-title')?.textContent || '',
  waiting: [...b.querySelectorAll('.standings-waiting')].map(p => p.textContent),
  moved: [...b.querySelectorAll('.standing-moved')].map(e => [e.previousElementSibling?.textContent || '', e.textContent, e.title]),
})), NA);
const ids = list => list.map(c => c.id).join(' ');

// One standings cycle: what it asked of the game by id, and the cards after.
async function cycle(page, wvw, asked) {
  const at = asked.length;
  await page.evaluate('loadStandings()');
  await wvw.settle();
  const urls = asked.slice(at);
  return { all: urls.filter(u => u === ALL).length, byId: urls.filter(u => u.startsWith(IDS) && u !== ALL), cards: await cards(page) };
}

// Last week's body of a tier, holding a team of `from` (a tier that is new).
function oldOf(m, from) {
  const shared = from.all_worlds.red.find(n => n >= 10000);
  return { shared, body: { ...m, start_time: iso(Date.parse(m.start_time) - WEEK), end_time: iso(Date.parse(m.end_time) - WEEK),
    all_worlds: { ...m.all_worlds, red: m.all_worlds.red.map(n => (n >= 10000 ? shared : n)) } } };
}

// ---- partial lists --------------------------------------------------------
// A relink night. A normal cycle asks ids=all and nothing else. A partial list
// is read again for the missing tiers only, by id, and they stay; a gap the
// second read lacks too keeps the last body seen, or, never seen, a "Waiting
// on the API" card; a tier missing from both reads with no gap is gone.
test.describe('partial lists', () => {
  const all = recordedJson(ALL);
  const rec = new Map(all.map(m => [m.id, m]));
  const without = (...gone) => all.filter(m => !gone.includes(m.id));

  test('a normal cycle reads ids=all once and nothing by id', async ({ page, wvw }) => {
    const asked = matchReads(page);
    await opened(page, wvw);
    expect(asked.filter(u => u.startsWith(IDS) && u !== ALL), 'the first load read again by id').toEqual([]);
    const r = await cycle(page, wvw, asked);
    expect(r.all, 'reads of ids=all').toBe(1);
    expect(r.byId).toEqual([]);
  });

  test('a list without two tiers is read again for them and they stay', async ({ page, wvw }) => {
    await opened(page, wvw);
    const asked = matchReads(page);
    await answer(page, ALL, without('1-1', '1-4'));
    const both = await answer(page, IDS + '1-1,1-4', [rec.get('1-1'), rec.get('1-4')]);
    const r = await cycle(page, wvw, asked);
    expect(r.byId, 'reads by id').toHaveLength(2);
    expect(both.reads).toBe(2);
    expect(ids(r.cards)).toBe('1-1 1-2 1-3 1-4');
    expect(r.cards.map(c => c.sides)).toEqual([3, 3, 3, 3]);
  });

  test('a gap the second read lacks too keeps its last body, and a tier missing from both goes', async ({ page, wvw }) => {
    await opened(page, wvw);
    const asked = matchReads(page);
    await answer(page, ALL, without('1-1', '1-4'));
    await answer(page, IDS + '1-1,1-4', []);
    const r = await cycle(page, wvw, asked);
    expect(ids(r.cards)).toBe('1-1 1-2 1-3');
    expect(r.cards[0].sides, 'tier 1 from its last body').toBe(3);
  });

  test('a tier this page never saw reads "Waiting on the API", with no map', async ({ page, wvw }) => {
    await opened(page, wvw);
    const asked = matchReads(page);
    await answer(page, ALL, without('1-1', '1-4'));
    await answer(page, IDS + '1-1,1-4', []);
    await answer(page, IDS + '1-1', []);
    await page.evaluate("newestMatches.delete('1-1'); matchDataCache.delete('1-1')");
    const r = await cycle(page, wvw, asked);
    expect(ids(r.cards)).toBe('1-1 1-2 1-3');
    const w = r.cards[0];
    expect({ sides: w.sides, map: w.map, title: w.title, waiting: w.waiting.join('|') })
      .toEqual({ sides: 0, map: false, title: 'Tier 1', waiting: 'Waiting on the API' });
  });

  // A tier on last week (the list from both weeks) is read again by id,
  // alone; still old, its card shows where a shared team plays now.
  test('the only tier on last week shows the line-up left over, no score, no map', async ({ page, wvw }) => {
    await opened(page, wvw);
    const asked = matchReads(page);
    const old2 = oldOf(rec.get('1-2'), rec.get('1-3'));
    const newLine = await Promise.all(TEAMS.map(c => nameOf(page, rec.get('1-2').all_worlds[c].find(n => n >= 10000))));
    await page.evaluate("newestMatches.delete('1-2')");
    await answer(page, ALL, all.map(m => (m.id === '1-2' ? old2.body : m)));
    const still = await answer(page, IDS + '1-2', [old2.body]);
    const r = await cycle(page, wvw, asked);
    expect(r.byId, 'reads by id').toHaveLength(2);
    expect(still.reads).toBe(2);
    const c2 = r.cards.find(c => c.id === '1-2');
    const line = await page.evaluate(() => [...document.querySelectorAll('#standingsGridNA > [data-match-id="1-2"] .standing-stale .standing-side-name')].map(e => e.textContent));
    expect({ stale: c2.stale, sides: c2.sides, map: c2.map, waiting: c2.waiting.join('|'), moved: c2.moved.length })
      .toEqual({ stale: 3, sides: 0, map: false, waiting: "This week's line-up · scores not in yet", moved: 0 });
    expect([...line].sort()).toEqual([...newLine].sort());
  });

  test('two tiers on last week stay old, each marked with the tier its shared team plays now', async ({ page, wvw }) => {
    await opened(page, wvw);
    const asked = matchReads(page);
    const old2 = oldOf(rec.get('1-2'), rec.get('1-3')), old4 = oldOf(rec.get('1-4'), rec.get('1-1'));
    await page.evaluate("newestMatches.delete('1-2'); newestMatches.delete('1-4')");
    await answer(page, ALL, all.map(m => (m.id === '1-2' ? old2.body : m.id === '1-4' ? old4.body : m)));
    const still = await answer(page, IDS + '1-2,1-4', [old2.body, old4.body]);
    const r = await cycle(page, wvw, asked);
    expect(r.byId, 'reads by id').toHaveLength(2);
    expect(still.reads).toBe(2);
    for (const [id, shared, tier] of [['1-2', old2.shared, 3], ['1-4', old4.shared, 1]]) {
      const c = r.cards.find(x => x.id === id), name = await nameOf(page, shared);
      expect({ stale: c.stale, waiting: c.waiting.join('|'), moved: c.moved }, `last week's ${id}`).toEqual({
        stale: 3, waiting: "Last week's line-up · waiting on the API", moved: [[name, `→ Tier ${tier}`, `This week: Tier ${tier}`]] });
    }
    expect(r.cards.find(c => c.id === '1-3').moved.length, "this week's 1-3 marked").toBe(0);
    // The recorded bodies replace last week's.
    await page.unroute(IDS + '1-2,1-4');
    await page.unroute(ALL);
    const back = await cycle(page, wvw, asked);
    expect(back.cards.map(c => c.sides)).toEqual([3, 3, 3, 3]);
  });

  // The rule itself, on the recorded bodies. Only one late tier and a count
  // that closes give a line-up: two late tiers leave 6 teams with 10 ways to
  // split them, three leave 9 with 280, and a table with a team too many or
  // too few breaks the count.
  test('deduceLineup: one late tier whose count closes, nothing else', async ({ page, wvw }) => {
    await opened(page, wvw);
    const eu = all.filter(m => m.id.startsWith('2-')).sort((x, y) => x.id.localeCompare(y.id));
    expect(eu).toHaveLength(5);
    const na = ['1-1', '1-2', '1-3', '1-4'].map(i => rec.get(i));
    const lateOf = (list, late) => list.map(m => {
      if (!late.includes(m.id)) return m;
      const live = list.find(x => !late.includes(x.id));
      return oldOf(m, m.id === late[0] ? live : m).body;
    });
    const cases = [
      ['NA, 1-2 late', lateOf(na, ['1-2']), '1', 4, '1-2'],
      ['NA, 1-2 live but on last week', lateOf(na, ['1-2']).map(m => (m.id === '1-2' ? { ...m, end_time: iso(Date.now() + WEEK) } : m)), '1', 4, '1-2'],
      ['NA, 1-2 and 1-4 late', lateOf(na, ['1-2', '1-4']), '1', 4, null],
      ['NA, three late', lateOf(na, ['1-2', '1-3', '1-4']), '1', 4, null],
      ['NA, all on this week', na, '1', 4, null],
      ['NA, a team too many', lateOf(na, ['1-2']), '1+', 4, null],
      ['NA, a team too few', lateOf(na, ['1-2']), '1-', 4, null],
      ['EU, 2-3 late', lateOf(eu, ['2-3']), '2', 5, '2-3'],
    ];
    for (const [what, list, set, tiers, want] of cases) {
      const got = await page.evaluate(([list, set, tiers, want]) => {
        const teams = new Set(Object.keys(TEAM_NAMES).filter(id => id.startsWith('1' + set[0])));
        if (set[1] === '+') teams.add('1' + set[0] + '999');
        if (set[1] === '-') {
          const taken = new Set(list.filter(m => m.id !== '1-2').flatMap(m => COLORS.map(c => matchTeamId(m, c))));
          teams.delete([...teams].find(id => !taken.has(id)));
        }
        const line = deduceLineup(list, teams, tiers);
        return line && { id: line.id, teams: COLORS.map(c => matchTeamId(line, c)).sort() };
      }, [list, set, tiers, want]);
      const real = want && rec.get(want);
      const expected = want && { id: want, teams: TEAMS.map(c => String(real.all_worlds[c].find(n => n >= 10000))).sort() };
      expect(got, what).toEqual(expected || null);
    }
  });
});

// ---- a fresh week ---------------------------------------------------------
// The first hours of a week: every side on 0 VP is tied with the others, so no
// arrow and no bar says who moves; no deaths has no ratio, so K/D is a dash
// and nobody is underlined. The page opens on the recorded week with its
// arrows, then the week turns (gw2.newWeek) and the standings read it.
test.describe('a fresh week', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().newWeek() });

  test('every side tied on 0 VP: no arrows, "Tied on VP", a dash for K/D', async ({ page, wvw }) => {
    await opened(page, wvw);
    const read = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#standingsGridNA .standing-match')].map(box => {
      const kd = [...box.querySelectorAll('.standing-side-stats')].map(l => [...l.querySelectorAll('.stat-value')].pop());
      return [box.dataset.matchId, { sides: box.querySelectorAll('.standing-side').length,
        arrows: box.querySelectorAll('.movement-up, .movement-down, .movement-bar').length,
        tied: [...box.querySelectorAll('.movement-tied')].map(e => e.title),
        kd: kd.map(e => e.textContent.trim()), leaders: kd.filter(e => e.classList.contains('stat-leader')).length,
        coloured: kd.filter(e => e.classList.contains('kd-good') || e.classList.contains('kd-bad')).length }];
    })));
    const before = await read();
    expect(before[FOCUS].arrows, 'the recorded week has its arrows').toBeGreaterThan(0);
    // The week turns: the clock goes to its end, the standings read again.
    const turn = wvw.recordedAt + wvw.timeline.end + MIN;
    await wvw.skew(turn - await wvw.now());
    await page.evaluate('loadStandings()');
    await wvw.settle();
    await expect.poll(async () => (await read())[FOCUS].arrows, { message: 'arrows once the week turned' }).toBe(0);
    const a = (await read())[FOCUS];
    expect(a.sides).toBe(3);
    expect(a.tied, 'tied sides').toEqual(['Tied on VP', 'Tied on VP', 'Tied on VP']);
    expect(a.kd.every(x => x.startsWith('–')), `K/D ${JSON.stringify(a.kd)}, wanted a dash with no deaths`).toBe(true);
    expect(a.leaders, 'a K/D leader underlined with no deaths anywhere').toBe(0);
    expect(a.coloured, 'a dash coloured as good or bad K/D').toBe(0);
  });
});

// ---- the Check on a relink day ---------------------------------------------
// The same team in last week's tier (read last in the list) and this week's
// must land on this week's; a team whose match the API does not hold yet
// (?world= answers another team's) gets a grey dot and a note, and no wrong
// pair is kept, so a second Check finds it once the API answers right. The
// guilds are the recorded two; the second one is moved to a team no match holds.
async function guildTables() {
  const tables = {}, where = [];
  for (const r of ['na', 'eu']) tables[r] = { url: GAME + 'wvw/guilds/' + r, body: recordedJson(GAME + 'wvw/guilds/' + r) };
  return { tables, where };
}
function placeGuilds(guilds, tables) {
  return guilds.slice(0, 2).map(name => {
    const gid = recordedJson(`${GAME}guild/search?name=${encodeURIComponent(name)}`)[0];
    const r = ['na', 'eu'].find(x => gid && Object.hasOwn(tables[x].body, gid));
    if (!r) throw new Error(`${name} is in neither recorded guild table`);
    return { gid, r };
  });
}
const dots = page => page.evaluate(() => [...document.querySelectorAll('#resultBody tr')].map(tr => {
  const d = tr.querySelector('.dot'); return d ? { cls: d.className, title: d.title } : null; }));

test('relink day Check: this week\'s match wins; a team the API lacks gets a grey dot, a note, and finds it next Check', async ({ page, wvw }) => {
  const all = recordedJson(ALL);
  const { tables } = await guildTables();
  const where = placeGuilds(wvw.guilds, tables);
  const T = String(tables[where[0].r].body[where[0].gid]);
  const holds = (m, t) => Object.values(m.all_worlds).some(l => l.map(String).includes(String(t)));
  const colorOf = (m, t) => TEAMS.find(c => m.all_worlds[c].map(String).includes(String(t)));
  const fresh = all.find(m => holds(m, T));
  const other = all.find(m => m.id !== fresh?.id && m.id.startsWith('1-') === where[1].r.startsWith('n'));
  expect(fresh && other, `a match holding team ${T} and a second one to borrow`).toBeTruthy();
  const MISSING = '99999';
  const rot = { red: 'blue', blue: 'green', green: 'red' };
  const old = { ...fresh, id: fresh.id.replace(/-\d+$/, '-9'),
    start_time: iso(Date.parse(fresh.start_time) - WEEK), end_time: iso(Date.parse(fresh.end_time) - WEEK),
    all_worlds: Object.fromEntries(Object.entries(fresh.all_worlds).map(([c, l]) => [rot[c], l])) };
  expect(colorOf(old, T), 'the old tier on another side').not.toBe(colorOf(fresh, T));
  const moved = structuredClone(tables[where[1].r].body);
  moved[where[1].gid] = typeof moved[where[1].gid] === 'string' ? MISSING : Number(MISSING);

  await opened(page, wvw);
  await answer(page, ALL, [...all, old]);
  await answer(page, tables[where[1].r].url, moved);
  const wrong = await answer(page, `${GAME}wvw/matches?world=${MISSING}`, other);
  await page.evaluate('wvwMapCache = null; loadStandings()');
  await wvw.settle();
  await check(page, wvw, wvw.guilds.slice(0, 2));
  const got = await dots(page);
  expect(got[0]?.cls, `team ${T} is in ${fresh.id} and in last week's ${old.id}`).toBe(`dot dot-${colorOf(fresh, T)}`);
  expect(await page.evaluate(t => teamToMatchId.get(t), T)).toBe(fresh.id);
  expect(got[1]?.cls).toBe('dot dot-pending');
  expect(got[1]?.title).toMatch(/not on the API yet/);
  expect(await page.locator('#matchPanelsContainer .panel-note').allTextContents()).toEqual([`Unknown team (ID ${MISSING}): this week's match isn't on the API yet.`]);
  expect(await page.evaluate(m => teamToMatchId.has(m) || teamToMatchId.has(Number(m)), MISSING), 'a wrong match kept for the missing team').toBe(false);
  expect(wrong.reads, '?world= reads').toBeGreaterThanOrEqual(1);
  expect(wrong.reads).toBeLessThanOrEqual(3);

  // The API now answers right: a second Check finds the guild.
  wrong.off();
  await answer(page, `${GAME}wvw/matches?world=${MISSING}`, { ...other, all_worlds: { ...other.all_worlds, red: [Number(MISSING)] } });
  await check(page, wvw, wvw.guilds.slice(0, 2));
  expect((await dots(page))[1]?.cls, 'the second Check once ?world= answered right').toBe('dot dot-red');
  await expect(page.locator('#matchPanelsContainer .panel-note')).toHaveCount(0);
});

// ---- the week memory -----------------------------------------------------------
// The week's line-up kept between loads (wvw-weeks-v1). A load sees 1-2 and
// 1-3 on a new week with each other's teams; the next load, same profile, is
// served last week's 1-2 and 1-3 everywhere: their cards show the new line-up
// by name with "This week's line-up · scores not in yet", no score, no map,
// and the Check gets that line-up for one of its teams, never cached. Two
// hours after that week began the API has the last word again. A corrupt
// memory is ignored with nothing logged (the fixture fails on any log). With
// one late tier, the line-up deduced from the API wins over the memory.
test.describe('week memory', () => {
  const KEY = 'wvw-weeks-v1';
  const all = recordedJson(ALL);
  const rec = new Map(all.map(m => [m.id, m]));
  const t2 = rec.get('1-2'), t3 = rec.get('1-3'), t4 = rec.get('1-4');
  const old = m => ({ ...m, start_time: iso(Date.parse(m.start_time) - WEEK), end_time: iso(Date.parse(m.end_time) - WEEK) });
  const startOf = recordedAt => Math.floor((recordedAt - 600000) / 60000) * 60000;
  const fresh = (start, m, worlds) => ({ ...m, start_time: iso(start), end_time: iso(start + WEEK), all_worlds: worlds });
  const card = (page, id) => page.evaluate(i => {
    const b = document.querySelector(`#standingsGridNA > .standing-match[data-match-id="${i}"]`);
    return b ? { sides: b.querySelectorAll('.standing-side').length, map: !!b.querySelector('.tier-map-btn'),
      vp: !!b.querySelector('.standing-vp'), names: [...b.querySelectorAll('.standing-side-name')].map(e => e.textContent),
      waiting: [...b.querySelectorAll('.standings-waiting')].map(p => p.textContent) } : null;
  }, id);
  const LINE = "This week's line-up · scores not in yet", LAST = "Last week's line-up · waiting on the API";

  test('a new week is remembered, and served back when the API still has last week', async ({ page, wvw }) => {
    const start = startOf(wvw.recordedAt);
    const newWeek = await serveList(page, all.map(m => (m.id === '1-2' ? fresh(start, t2, t3.all_worlds) : m.id === '1-3' ? fresh(start, t3, t2.all_worlds) : m)));
    await opened(page, wvw);
    const seen = await card(page, '1-2');
    expect(seen.sides).toBe(3);
    expect([...seen.names].sort()).toEqual([...await names(page, t3)].sort());
    const kept = await page.evaluate(k => localStorage.getItem(k), KEY);
    const mem = JSON.parse(kept || '{}');
    expect(mem['1-2']?.s, 'the memory of 1-2').toBe(start);
    expect(TEAMS.map(c => String(mem['1-2'].t[c]))).toEqual(team(t3));
    expect(kept.length, 'characters kept').toBeLessThan(2048);

    // Reloaded onto last week's 1-2 and 1-3, the read by id too.
    newWeek.off();
    const lastWeek = await serveList(page, all.map(m => (m.id === '1-2' || m.id === '1-3' ? old(m) : m)));
    await opened(page, wvw);
    expect(await card(page, '1-2')).toEqual({ sides: 0, map: false, vp: false, names: await names(page, t3), waiting: [LINE] });
    expect(lastWeek.reads, "last week's 1-2 and 1-3 read again by id").toBeGreaterThan(1);
    // The Check: a team of the new 1-2, every body in hand and ?world= on last week.
    const x = team(t3)[0];
    const world = await answer(page, `${GAME}wvw/matches?world=${x}`, old(t3));
    const got = await page.evaluate(t => getMatchForTeam(t).then(m => ({ id: m.id, memory: !!m.fromMemory,
      cached: [...matchDataCache.values(), ...[...newestMatches.values()].map(k => k.match)].some(b => b.fromMemory) })), x);
    expect(got, `the Check for team ${x}`).toEqual({ id: '1-2', memory: true, cached: false });
    expect(world.reads, '?world= reads').toBeGreaterThan(0);

    // Two hours after the remembered week began: the API's body stands.
    await page.addInitScript('__skewClock(' + 2 * 3600000 + ');');
    await opened(page, wvw);
    const c = await card(page, '1-2');
    expect([...c.names].sort()).toEqual([...await names(page, t2)].sort());
    expect(c.waiting.join('|')).toBe(LAST);
  });

  test('one late tier: the line-up deduced from the API wins over the memory', async ({ page, wvw }) => {
    const start = startOf(wvw.recordedAt);
    const good = Object.fromEntries(TEAMS.map((c, i) => [c, Number(team(t3)[i])]));
    await serveList(page, all.map(m => (m.id === '1-2' ? old(t2) : m)));
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({ '1-2': { s: start, e: start + WEEK, t: good, v: start } })]);
    await opened(page, wvw);
    const c = await card(page, '1-2');
    expect({ ...c, names: [...c.names].sort() }).toEqual({ sides: 0, map: false, vp: false, names: [...await names(page, t2)].sort(), waiting: [LINE] });
  });

  // Two late tiers: nothing to deduce, so a corrupt memory is the only thing
  // that could change 1-2 - each would-be winner otherwise well formed.
  test('a corrupt memory is ignored quietly and cannot reach Object.prototype', async ({ page, wvw }) => {
    const start = startOf(wvw.recordedAt);
    const entry = (t, s = start) => ({ s, e: s + WEEK, t, v: start });
    const good = Object.fromEntries(TEAMS.map((c, i) => [c, Number(team(t3)[i])]));
    const corrupt = {
      'not JSON': '{"1-2": {"s": ',
      'team 99999 and __proto__': `{"__proto__": ${JSON.stringify(entry(good))}, "1-2": ${JSON.stringify(entry({ ...good, green: 99999 }))}}`,
      '10 KB': JSON.stringify({ '1-2': entry(good), pad: 'x'.repeat(10240) }),
      'a week 20 h ahead': JSON.stringify({ '1-2': entry(good, start + 20 * 3600000) }),
      'a start past any date': JSON.stringify({ '1-2': entry(good, 8.7e15) }),
    };
    await serveList(page, all.map(m => (m.id === '1-2' ? old(t2) : m.id === '1-4' ? old(t4) : m)));
    await page.goto(wvw.url);   // a document to hold the storage
    for (const [what, text] of Object.entries(corrupt)) {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, text]);
      await opened(page, wvw);
      expect((await card(page, '1-2')).waiting.join('|'), `1-2 with a memory of ${what}`).toBe(LAST);
      expect(await page.evaluate(() => Object.prototype.s !== undefined || ({}).t !== undefined), `${what} reached Object.prototype`).toBe(false);
    }
  });
});
