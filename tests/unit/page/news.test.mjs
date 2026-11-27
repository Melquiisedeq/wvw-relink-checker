// The rules of js/news.js, run in Node without a browser: what a line of /api/notes becomes, and which links are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, clone } from './harness.mjs';

const WIKI = 'https://wiki.guildwars2.com/wiki/';
const row = (text, type, extra = {}) => ({ day: '2026-11-16', update: 'Update - November 16, 2026', section: 'World vs. World', sub: '', text, type, page: WIKI + 'Game_updates/2026-11-16', link: null, ...extra });

test('newsWikiHref: only a page of the wiki on its own host, rebuilt from its parts (js/news.js)', () => {
  const p = fresh();
  const href = (s) => p.call('newsWikiHref', s);
  assert.equal(href(WIKI + 'Stonemist_Castle#Notes'), WIKI + 'Stonemist_Castle#Notes');
  assert.equal(href(WIKI + 'Gate?x=1'), WIKI + 'Gate', 'the query is dropped');
  assert.equal(href('https://wiki.guildwars2.com@evil.example/wiki/Gate'), '');
  assert.equal(href('https://wiki.guildwars2.com.evil.example/wiki/Gate'), '');
  assert.equal(href('https://user@wiki.guildwars2.com/wiki/Gate'), WIKI + 'Gate', 'a userinfo does not survive');
  assert.equal(href('http://wiki.guildwars2.com/wiki/Gate'), '');
  assert.equal(href('https://wiki.guildwars2.com/other/Gate'), '');
  assert.equal(href('javascript:alert(1)'), '');
  assert.equal(href('//evil.example/wiki/Gate'), '');
  assert.equal(href(null), '');
  assert.equal(href(WIKI + 'x'.repeat(300)), '');
});

test('newsRead: lines out of shape are left out, the rest keep their kind (js/news.js)', () => {
  const p = fresh();
  const read = (notes) => clone(p.call('newsRead', { notes }));
  assert.deepEqual(read(null), []);
  assert.deepEqual(read([null, 7, 'x', { day: 'yesterday', text: 'x' }, { day: '2026-11-16', text: '' }, { day: '2026-11-16', text: 5 }]), []);
  const kinds = read([row('A rule.', 'wvw_rule'), row('Fixed it.', 'bug'), row('Gone: Reduced the cooldown from 5 to 4 seconds.', 'nerf'),
    row('Up: Increased the damage from 1 to 2.', 'buff'), row('Neutral thing.', 'neutral'), row('Unsure thing.', null), row('Odd.', 'surprise')]).map((i) => i.kind);
  assert.deepEqual(kinds, ['rule', 'fix', 'nerf', 'buff', '', '', '']);
});

test('newsItem: a rule that replaces a Borderlands map is a map; a value change is read as before and after (js/news.js)', () => {
  const p = fresh();
  const [map, nerf] = clone(p.call('newsRead', { notes: [
    row('The new Example Borderlands map has replaced the Seared Borderlands map in WvW! The beta will run until December 9.', 'wvw_rule'),
    row('Blazing Barrage: Reduced the power coefficient from 1.1 to 0.935 in WvW only.', 'nerf', { sub: 'Tempest' }),
  ] }));
  assert.equal(map.kind, 'map');
  assert.equal(map.until, Date.UTC(2026, 11, 9, 12));
  assert.deepEqual([nerf.before, nerf.after, nerf.desc, nerf.only, nerf.prof, nerf.name], ['1.1', '0.935', 'Power coefficient', true, 'Elementalist', 'Blazing Barrage']);
});

test('newsGroup: three rows of one update\'s value table are one line, two stay two (js/news.js)', () => {
  const p = fresh();
  const rows = (n) => Array.from({ length: n }, (_, i) => row(`Keep ${i}: 250 → 100 (T0)`, 'wvw_rule'));
  assert.equal(p.call('newsRead', { notes: rows(3) }).length, 1);
  assert.equal(p.call('newsRead', { notes: rows(3) })[0].name, 'Point values');
  assert.equal(p.call('newsRead', { notes: rows(2) }).length, 2, 'two rows are two lines, none lost');
  assert.equal(p.call('newsRead', { notes: [...rows(3), row('Fixed it.', 'bug'), ...rows(3)] }).length, 3);
});
