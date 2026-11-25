// The game's update notes, the WvW lines only, for GET /api/notes.
//
// The wiki gives each line its shape (section, profession, link) but anyone can edit it; the
// forum's release notes are ArenaNet's own words but flat and without the hotfixes. So:
//   - apps-script/notes reads the wiki's Game_updates page and pushes its lines, signed
//     (acceptNotes); nothing it sends is trusted: every field is checked again here;
//   - the daily schedule reads the forum's RSS itself (notesDaily) and marks each line of a
//     day the RSS has whose text the RSS also has;
//   - published: a line its day's RSS item holds; the first heading of a day the RSS has, nothing
//     else. Any other line (a hotfix: a day the RSS lacks, or a later heading of a day it has) only
//     when a good RSS read after the line's first reading did not have it, and a reading of the
//     wiki at least STABLE_S after that first one still had it, unchanged.

export const WIKI = 'https://wiki.guildwars2.com/wiki/';
export const RSS_URL = 'https://en-forum.guildwars2.com/forum/6-game-release-notes.xml';
export const USER_AGENT = 'wvwrelink-notes (+https://wvwrelink.com)';
export const MAX_LINE = 300;
export const MAX_PER_NOTE = 60;
const MAX_NOTES = 20;
// A raw line longer than this is not a note line.
const MAX_RAW = 2000;
export const STABLE_S = 20 * 3600;
// A day of the wiki (h2) may sit on a page dated up to this far from it.
const PAGE_SKEW_DAYS = 3;
export const KEEP_NOTE_DAYS = 400;
const MAX_RSS_BYTES = 2 * 1024 * 1024;
const RSS_TIMEOUT_MS = 15e3;
export const RSS_DAYS_PER_RUN = 1;
export const FEED_MAX = 200;
// A reading of a note with fewer than half the most lines ever kept from it is refused for that
// note: a blanked or gutted section never replaces the last good copy, nor do cuts one reading at a time.
const SHRINK_FLOOR = 0.5;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DATE = '(' + MONTHS.join('|') + ') ([1-9]|[12]\\d|3[01]), (20\\d\\d)';
const UPDATE_RE = new RegExp('^(?:Update(?: [2-9])?|Late Notes) - ' + DATE + '$');
const TITLE_RE = new RegExp('^Game Update Notes: ' + DATE + '$');
// A wiki page name as the script sends it: no ':' (no scheme, no namespace), no '/', no '%'.
const LINK_RE = /^[A-Za-z0-9][A-Za-z0-9 _'.,()!&-]{0,99}$/;
const SUB_RE = /^[\p{L}\p{N} .,'&()-]{0,60}$/u;
// The wiki's section titles (h3) a line may sit under (those of the 2026 notes, and the core
// professions older notes put there); any other is left out, but for an event's own section.
const SECTIONS = new Set(['', 'World vs. World', 'Profession Skills', 'Bug Fixes', 'Bug Fix', 'General',
  'World Polish', 'Release Highlights', 'Rewards', "Wizard's Vault", 'Items', 'Gem Store', 'Trading Post',
  'Launcher', 'Fashion Templates', 'Raids', 'Fractals', 'Open World', 'Personal Story', 'Dungeons',
  'Convergence', 'Convergences', 'Player vs. Player', 'Elementalist', 'Engineer', 'Guardian', 'Mesmer',
  'Necromancer', 'Ranger', 'Revenant', 'Thief', 'Warrior']);
const EVENT_SECTION = /^(?:Bonus Event: [A-Za-z' ]{1,40}|[A-Za-z' ]{1,40} (?:Festival|Incursion)|Extra Life|Halloween|Wintersday|Lunar New Year|Dragon Bash)$/;

// ---- the line's text -----------------------------------------------------

// Text with nothing that hides or reorders what is shown: controls, format characters (the
// bidirectional ones and zero widths among them), private use, unassigned, lone surrogates.
// null when nothing is left or it carries markup.
export function plainText(s) {
  if (typeof s !== 'string' || s.length > MAX_RAW) return null;
  const t = s.normalize('NFC').replace(/\s/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '').replace(/ {2,}/g, ' ').trim();
  if (!t || t.includes('<') || t.includes('>')) return null;
  return t;
}

// At most MAX_LINE characters, the cut marked.
export function cut(t) {
  const cps = [...t];
  return cps.length <= MAX_LINE ? t : cps.slice(0, MAX_LINE - 1).join('') + '…';
}

// The form two texts are compared in: one kind of each quote and dash, one space, lower case.
export function matchForm(s) {
  return s.normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-').replace(/\s\s+|[^\S ]/g, ' ').trim().toLowerCase();
}

const WORD = /[\p{L}\p{N}]/u;

// Whether `hay` holds `needle` as whole words. A line cut by `cut` is checked up to the cut.
export function holds(hay, needle) {
  const isCut = needle.endsWith('…');
  const n = matchForm(isCut ? needle.slice(0, -1) : needle);
  if (!n) return false;
  for (let at = hay.indexOf(n); at >= 0; at = hay.indexOf(n, at + 1)) {
    if (at > 0 && WORD.test(hay[at - 1])) continue;
    const end = at + n.length;
    if (!isCut && end < hay.length && WORD.test(hay[end])) continue;
    return true;
  }
  return false;
}

// The day of "Update - November 10, 2026", "2026-11-10", or null.
export function dayOf(update) {
  const m = UPDATE_RE.exec(update);
  return m ? isoDay(m) : null;
}

function isoDay(m) {
  const mo = MONTHS.indexOf(m[1]) + 1;
  const d = new Date(Date.UTC(Number(m[3]), mo - 1, Number(m[2])));
  if (d.getUTCMonth() !== mo - 1) return null;
  return d.toISOString().slice(0, 10);
}

const dayMs = (day) => Date.parse(day + 'T00:00:00Z');

// The wiki address of a page name the script sent; null for anything out of shape.
export function wikiLink(name) {
  if (typeof name !== 'string' || !LINK_RE.test(name)) return null;
  return WIKI + encodeURIComponent(name.replace(/ /g, '_'));
}

// ---- the type of a line ----------------------------------------------------

const PROF = new Set(['Elementalist', 'Engineer', 'Guardian', 'Mesmer', 'Necromancer', 'Ranger', 'Revenant',
  'Thief', 'Warrior']);
const LOW = 'cooldown|recharge|cast time|activation time|aftercast|delay|(?:initiative|energy|resource|adrenaline) cost|\\bcost\\b|damage taken|incoming damage|launch time|channel time|interval|casting time|animation|vulnerab\\w+ taken';
const AMB = /threshold|requirement|required|stack limit/;
const UP = 'increased?|raised?|improved|extended|boosted|doubled';
const DOWN = 'reduced|lowered|decreased|shortened|halved|cut';
const WVW_WORDS = /WvW|World vs|War Score|Borderlands|Eternal Battlegrounds|skirmish|dolyak|\bsiege\b|Stonemist|\bkeeps?\b|\bsentry\b|Obsidian Sanctum|Edge of the Mists|\brelink/;
// The types a reader can trust; any other is shown with no label (a map, an event, a reward: the
// section's own title says it).
const SURE = new Set(['bug', 'neutral', 'buff', 'nerf', 'mixed', 'wvw_rule']);

// Whether the line is about World vs. World: its words, or its section.
export function aboutWvw(text, section) {
  return /\b(?:WvW)\b|World vs\. World/.test(text) || WVW_WORDS.test(text) || section.startsWith('World vs');
}

function clauses(t) {
  const out = [];
  const re = new RegExp('\\b(' + UP + '|' + DOWN + ')\\b (?:the |by )?([^.;]*?)(?= from | to |\\.|;| and (?:increased|reduced|lowered)| in (?:PvE|PvP|WvW)|$)', 'gi');
  for (const m of t.matchAll(re)) {
    out.push([new RegExp('^(?:' + UP + ')').test(m[1].toLowerCase()) ? 1 : -1, m[2].toLowerCase()]);
  }
  return out;
}

function polarity(t) {
  if (/\b(now|no longer|reworked|renamed|moved|instead|will|has been|is now|are now)\b/.test(t)) return null;
  if (!/\d/.test(t)) return null;
  if (new RegExp('(?:' + LOW + ')[^.;]*\\d+%').test(t)) return null;
  const cl = clauses(t);
  if (!cl.length) return null;
  const ps = new Set();
  for (const [dr, obj] of cl) {
    if (AMB.test(obj)) { ps.add('?'); continue; }
    const o = new RegExp(LOW).test(obj) ? -1 : 1;
    ps.add(dr * o > 0 ? 'buff' : 'nerf');
  }
  if (ps.size > 1) return ps.has('?') ? '?' : 'mixed';
  const p = [...ps][0];
  return p === '?' ? null : p;
}

// The type of a line, as the wiki's lab rules give it ('bug', 'buff', 'nerf', 'wvw_rule'...).
export function kindOf(text, section, sub, icon) {
  const body = icon ? text.replace(/^[^:]{1,60}: /, '') : text;
  const prof = PROF.has(section) || section === 'Profession Skills' || PROF.has(sub);
  if (/^Bug Fix/.test(section)) return 'bug';
  if (/^(Fixed|Corrected|Resolved)\b/.test(body) && !/\b(Increased|Reduced|Lowered|Decreased)\b.* from [\d.,]+/.test(body)) return 'bug';
  if (/^Fixed\b/.test(body)) return 'balance_bug_mix';
  if (icon || prof) {
    if (/is unchanged|are unchanged/.test(body)) return 'neutral';
    const p = polarity(body);
    return p === 'buff' || p === 'nerf' || p === 'mixed' ? p : 'balance_unsure';
  }
  if (/^World vs\. World/.test(section) || /\b(War Score)\b/.test(text)) return 'wvw_rule';
  if (/(?<!\w)(Festival|Halloween|Lunar New Year|Dragon Bash|Wintersday|Extra Life|Summer Game Fest|Convergence|Incursion|Bonus Event|Release Highlights|Super Adventure)/.test(section) ||
    /\b(until|through|from) (?:January|February|March|April|May|June|July|August|September|October|November|December) \d|\bbeta\b|\bwill (?:run|be available|begin|end|turn on)\b/.test(text)) return 'event';
  if (/\b(new map|maps?)\b|Borderlands|Battlegrounds|Mists/.test(text)) return 'map';
  if (/^(Rewards|Wizard's Vault)/.test(section) || /\breward/i.test(text)) return 'reward';
  if (/^(Items|Gem Store|Trading Post|Launcher|Fashion Templates)/.test(section)) return 'item';
  if (/^(Raids|Fractals|Open World|Personal Story|Dungeons|Convergences?|Player vs)/.test(section)) return 'content';
  if (/\b(UI|interface|button|tooltip|option|menu|now (?:shows|displays)|display)\b/.test(text)) return 'qol';
  return 'other';
}

// The label shown, or null when the rules are not sure.
export const labelOf = (kind) => (SURE.has(kind) ? kind : null);

// ---- the push --------------------------------------------------------------

// The message: {v: 1, notes: [{page, update, lines: [{section, sub, text, link, icon}]}]}.
// A message out of shape is refused whole (a string, the reason); a note or a line out of shape
// is left out and counted. Returns {notes: [{update, day, page, lines: [...]}], dropped}.
export function checkNotes(data, nowMs) {
  if (!data || typeof data !== 'object' || data.v !== 1) return 'version';
  if (!Array.isArray(data.notes) || !data.notes.length || data.notes.length > MAX_NOTES) return 'notes';
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const n of data.notes) {
    const note = checkNote(n, nowMs);
    if (typeof note === 'string' || seen.has(note.update)) { dropped++; continue; }
    seen.add(note.update);
    dropped += note.dropped;
    out.push(note);
  }
  return { notes: out, dropped };
}

function checkNote(n, nowMs) {
  if (!n || typeof n !== 'object' || !Array.isArray(n.lines)) return 'shape';
  if (typeof n.page !== 'string') return 'page';
  // A real day written as 'yyyy-mm-dd', nothing else.
  const pageMs = dayMs(n.page);
  if (Number.isNaN(pageMs) || new Date(pageMs).toISOString().slice(0, 10) !== n.page) return 'page';
  if (pageMs > nowMs + 86400e3 || pageMs < nowMs - KEEP_NOTE_DAYS * 86400e3) return 'page date';
  if (typeof n.update !== 'string') return 'update';
  const day = dayOf(n.update);
  if (!day || Math.abs(dayMs(day) - pageMs) > PAGE_SKEW_DAYS * 86400e3) return 'day';
  const lines = [];
  let dropped = 0;
  for (const l of n.lines.slice(0, MAX_PER_NOTE)) {
    const line = checkLine(l);
    if (line) lines.push(line);
    else dropped++;
  }
  dropped += Math.max(0, n.lines.length - MAX_PER_NOTE);
  return { update: n.update, day, page: n.page, lines, dropped };
}

function checkLine(l) {
  if (!l || typeof l !== 'object' || typeof l.icon !== 'boolean') return null;
  if (typeof l.section !== 'string' || typeof l.sub !== 'string') return null;
  const section = l.section.replace(/:$/, '');
  const sub = l.sub === '' ? '' : plainText(l.sub);
  if (!(SECTIONS.has(section) || EVENT_SECTION.test(section)) || sub === null || !SUB_RE.test(sub)) return null;
  const raw = plainText(l.text);
  if (!raw || !aboutWvw(raw, section)) return null;
  const text = cut(raw);
  return {
    section, sub, text, icon: l.icon,
    link: l.link === null ? null : (LINK_RE.test(l.link || '') ? l.link : null),
    kind: labelOf(kindOf(raw, section, sub, l.icon))
  };
}

async function lineId(update, line) {
  const bytes = new TextEncoder().encode([update, line.section, line.sub, line.text, line.link || ''].join('\n'));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha16(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// After the signature and before the replay claim: the message checked whole. `claim` claims
// the message's time and answers whether it was first; nothing is written before it.
// Returns a string (refused, the reason) or the outcome to log.
export async function acceptNotes(db, data, nowMs, claim) {
  const checked = checkNotes(data, nowMs);
  if (typeof checked === 'string') return checked;
  const now = Math.floor(nowMs / 1000);
  const push = await sha16(JSON.stringify(checked.notes));
  const state = await db.prepare('SELECT push, wiki FROM note_feed WHERE id = 1').first();
  const { results: groups } = await db.prepare('SELECT note, top FROM note_group').all();
  if (!await claim()) return null;
  const log = { notes: checked.notes.length, dropped: checked.dropped };
  if (state.push === push) {
    // The same reading again: only its time moves (the replay claim, and the feed's wiki time).
    log.same = true;
  } else {
    const kept = new Map(groups.map((g) => [g.note, g]));
    const take = [];
    const shrunk = [];
    for (const n of checked.notes) {
      const before = kept.get(n.update);
      if (before && n.lines.length < Math.ceil(before.top * SHRINK_FLOOR)) shrunk.push(n.update);
      else take.push(n);
    }
    if (shrunk.length) log.shrunk = shrunk;
    const rows = [];
    for (const n of take) {
      let pos = 0;
      for (const l of n.lines) rows.push([n.update, await lineId(n.update, l), pos++, l.section, l.sub, l.text, l.link, l.kind]);
    }
    const names = JSON.stringify(take.map((n) => n.update));
    // A note the last reading had and this one does not (or refused) keeps that reading's time.
    await db.prepare('UPDATE note_group SET current = 0, seen = ?1 WHERE current = 1 AND note NOT IN (SELECT value FROM json_each(?2))')
      .bind(state.wiki, names).run();
    await db.prepare('INSERT INTO note_group (note, day, page, n, top, seen, current) ' +
      "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[3]'), ?2, 1 FROM json_each(?1) j " +
      'WHERE true ON CONFLICT (note) DO UPDATE SET day = excluded.day, page = excluded.page, n = excluded.n, ' +
      'top = max(note_group.top, excluded.n), seen = excluded.seen, current = 1')
      .bind(JSON.stringify(take.map((n) => [n.update, n.day, n.page, n.lines.length])), now).run();
    await db.prepare('DELETE FROM note_line WHERE note IN (SELECT value FROM json_each(?1)) AND ' +
      "note || '|' || id NOT IN (SELECT json_extract(j.value, '$[0]') || '|' || json_extract(j.value, '$[1]') FROM json_each(?2) j)")
      .bind(names, JSON.stringify(rows)).run();
    // A line already held keeps its first reading and its RSS mark.
    await db.prepare('INSERT INTO note_line (note, id, pos, section, sub, body, link, kind, first, rss) ' +
      "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), " +
      "json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), ?2, 0 FROM json_each(?1) j " +
      'WHERE true ON CONFLICT (note, id) DO UPDATE SET pos = excluded.pos WHERE note_line.pos <> excluded.pos')
      .bind(JSON.stringify(rows), now).run();
    log.lines = rows.length;
  }
  await rebuildFeed(db, { push, wiki: now });
  return log;
}

// ---- the forum's RSS -------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// One pass, so "&amp;lt;" stays "&lt;".
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (all, e) => {
    if (e[0] !== '#') return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : all;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}

// The text of an HTML fragment: each tag a space, the entities decoded.
export function htmlText(html) {
  const out = [];
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt < 0) { out.push(html.slice(at)); break; }
    out.push(html.slice(at, lt));
    const gt = html.indexOf('>', lt);
    if (gt < 0) { out.push(''); break; }
    at = gt + 1;
  }
  return decodeEntities(out.join(' '));
}

function between(s, open, close, from = 0) {
  const a = s.indexOf(open, from);
  if (a < 0) return null;
  const b = s.indexOf(close, a + open.length);
  return b < 0 ? null : s.slice(a + open.length, b);
}

// Each "Game Update Notes: <date>" item of the feed's bytes: {day, text()}. The feed is scanned
// as one byte a character (its tags and titles are ASCII), and only an item whose text is asked
// for is decoded as UTF-8 (in matchForm).
export function rssItems(bytes) {
  const xml = new TextDecoder('latin1').decode(bytes);
  const out = [];
  let at = 0;
  for (;;) {
    const s = xml.indexOf('<item>', at);
    if (s < 0) break;
    const e = xml.indexOf('</item>', s);
    if (e < 0) break;
    const item = xml.slice(s, e);
    at = e + 7;
    const title = between(item, '<title>', '</title>');
    if (title === null) continue;
    const m = TITLE_RE.exec(decodeEntities(title).replace(/\s+/g, ' ').trim());
    const day = m && isoDay(m);
    const d = item.indexOf('<description>');
    const de = d < 0 ? -1 : item.indexOf('</description>', d);
    if (!day || de < 0) continue;
    const from = s + d + 13;
    const to = s + de;
    out.push({
      day,
      text() {
        const desc = new TextDecoder().decode(bytes.subarray(from, to));
        const cdata = between(desc, '<![CDATA[', ']]>');
        return matchForm(htmlText(cdata === null ? decodeEntities(desc) : cdata));
      }
    });
  }
  return out;
}

async function readRss(fetchFn) {
  const res = await fetchFn(RSS_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml' },
    redirect: 'manual', signal: AbortSignal.timeout(RSS_TIMEOUT_MS)
  });
  if (res.status !== 200 || !res.body) return 'HTTP ' + res.status;
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RSS_BYTES) { await reader.cancel(); return 'size'; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  const items = rssItems(all);
  return items.length ? items : 'no items';
}

// The daily part: the RSS read, the lines of its days marked, old notes dropped, the feed rebuilt.
// Never throws: the kills cleanup of the same schedule must not depend on it. An RSS that fails
// changes nothing: the lines already marked stay marked.
export async function notesDaily(env, nowMs, fetchFn = fetch) {
  try {
    const now = Math.floor(nowMs / 1000);
    const oldest = new Date(nowMs - KEEP_NOTE_DAYS * 86400e3).toISOString().slice(0, 10);
    await env.DB.prepare('DELETE FROM note_line WHERE note IN (SELECT note FROM note_group WHERE day < ?1)').bind(oldest).run();
    await env.DB.prepare('DELETE FROM note_group WHERE day < ?1').bind(oldest).run();
    let items;
    try {
      items = await readRss(fetchFn);
    } catch (e) {
      items = String(e);
    }
    let marked = 0;
    let rss;
    if (typeof items === 'string') {
      console.log(JSON.stringify({ notes: 'rss', failed: items }));
    } else {
      rss = now;
      const days = JSON.stringify([...new Set(items.map((it) => it.day))]);
      await env.DB.prepare('INSERT OR IGNORE INTO note_day (day) SELECT value FROM json_each(?1)').bind(days).run();
      const { results } = await env.DB.prepare('SELECT l.note, l.id, l.body, g.day FROM note_line l JOIN note_group g ON g.note = l.note ' +
        'WHERE l.rss = 0 AND g.day IN (SELECT value FROM json_each(?1))').bind(days).all();
      // Only the items of a day with a line still to confirm are read as text, the newest
      // RSS_DAYS_PER_RUN of them: a patch day's item is most of the CPU a run has; the rest wait a day each.
      const byDay = new Map();
      for (const day of [...new Set(results.map((r) => r.day))].sort().reverse().slice(0, RSS_DAYS_PER_RUN)) {
        byDay.set(day, items.filter((it) => it.day === day).map((it) => it.text()).join(' \n '));
      }
      // 1: the item holds the line; -1: it does not, and the line is not asked again (a line
      // changed on the wiki is a new one).
      const checked = results.filter((r) => byDay.has(r.day)).map((r) => [r.note, r.id, holds(byDay.get(r.day), r.body) ? 1 : -1]);
      marked = checked.filter((c) => c[2] === 1).length;
      if (checked.length) {
        await env.DB.prepare("UPDATE note_line SET rss = (SELECT json_extract(j.value, '$[2]') FROM json_each(?1) j " +
          "WHERE json_extract(j.value, '$[0]') = note_line.note AND json_extract(j.value, '$[1]') = note_line.id) " +
          "WHERE note || '|' || id IN (SELECT json_extract(j.value, '$[0]') || '|' || json_extract(j.value, '$[1]') FROM json_each(?1) j)")
          .bind(JSON.stringify(checked)).run();
      }
    }
    await rebuildFeed(env.DB, { rss });
    console.log(JSON.stringify({ notes: 'daily', rss: rss ? items.length : 0, marked }));
  } catch (e) {
    console.log(JSON.stringify({ notes: 'daily', failed: String(e) }));
  }
}

// ---- the feed --------------------------------------------------------------

// The published lines, newest day first, as one row: GET /api/notes reads that row alone.
// `set` moves the reading times: {push, wiki} after a push, {rss} after a good RSS.
async function rebuildFeed(db, set) {
  const state = await db.prepare('SELECT wiki, rss FROM note_feed WHERE id = 1').first();
  const wikiAt = set.wiki || state.wiki;
  const rssAt = set.rss || state.rss;
  const { results } = await db.prepare('SELECT l.note, l.section, l.sub, l.body, l.link, l.kind, l.first, l.rss, ' +
    'g.day, g.page, g.seen, g.current, d.day IS NOT NULL AS big FROM note_line l JOIN note_group g ON g.note = l.note ' +
    'LEFT JOIN note_day d ON d.day = g.day ORDER BY g.day DESC, g.note DESC, l.pos').all();
  const out = [];
  for (const r of results) {
    const hotfix = r.rss !== 1;
    if (hotfix) {
      // The first heading of a day the RSS has is the forum's item: only its words.
      if (r.big && r.note.startsWith('Update - ')) continue;
      // No good RSS read since the line's first reading, or its day's item not yet asked: not a hotfix yet.
      if (!(rssAt > r.first) || (r.big && r.rss !== -1)) continue;
      if ((r.current ? wikiAt : r.seen) - r.first < STABLE_S) continue;
    }
    out.push({
      day: r.day, update: r.note, section: r.section, sub: r.sub, text: r.body, type: r.kind,
      hotfix, page: WIKI + 'Game_updates/' + r.page, link: r.link === null ? null : wikiLink(r.link)
    });
    if (out.length >= FEED_MAX) break;
  }
  const body = JSON.stringify(out);
  const version = await sha16(body);
  await db.prepare('UPDATE note_feed SET body = ?1, version = ?2, push = COALESCE(?3, push), wiki = COALESCE(?4, wiki), ' +
    'rss = COALESCE(?5, rss) WHERE id = 1').bind(body, version, set.push ?? null, set.wiki ?? null, set.rss ?? null).run();
}

// ---- the reads ---------------------------------------------------------------

export const NOTES_VERSION_RE = /^\?v=([0-9a-f]{16})$/;

// {v, wiki, rss, notes}: the times of the last good wiki reading and RSS, epoch s (0 never).
export async function notesFeed(db) {
  return db.prepare('SELECT version, wiki, rss, body FROM note_feed WHERE id = 1').first();
}
