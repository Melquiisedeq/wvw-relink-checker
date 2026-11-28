// The game's update notes, the WvW lines only, for GET /api/notes.
//
// apps-script/notes reads the wiki's Game_updates page and pushes its lines, signed (acceptNotes).
// Anyone can edit the wiki, so nothing it sends is trusted: every field is checked again here, a
// line is plain text cut to a size, and its link is built here from a checked page name. A line is
// published as the wiki has it: what the wiki shows, the next reading shows, and so does its undoing,
// but for a hotfix's line, published once the readings have held it unchanged for HOTFIX_WAIT_S.

export const WIKI = 'https://wiki.guildwars2.com/wiki/';
export const MAX_LINE = 300;
export const MAX_PER_NOTE = 60;
const MAX_NOTES = 20;
// A raw line longer than this is not a note line.
const MAX_RAW = 2000;
// A day of the wiki (h2) may sit on a page dated up to this far from it.
const PAGE_SKEW_DAYS = 3;
export const KEEP_NOTE_DAYS = 400;
export const MAX_SERVED = 200;
// A hotfix's line is published once it has been in every reading of its page for this long.
export const HOTFIX_WAIT_S = 86400;
// What the wiki writes under a release's own heading, and under no other update's. A note without it
// is a hotfix: the ones between releases, and the release day's 'Update 2' and 'Late Notes'.
const RELEASE_NOTICE = 'Note to users of third-party programs:';
const RELEASE_RE = /^Update - /;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DATE = '(' + MONTHS.join('|') + ') ([1-9]|[12]\\d|3[01]), (20\\d\\d)';
const UPDATE_RE = new RegExp('^(?:Update(?: [2-9])?|Late Notes) - ' + DATE + '$');
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
// An event or a reward of WvW the rules are sure of; any other is shown with no label.
const EVENT_SURE = /\bbeta event (?:begins|ends)\b|\bbeta\b[^.]{0,40}\bwill run (?:until|through) (?:January|February|March|April|May|June|July|August|September|October|November|December) \d/;
const REWARD_SURE = /^Added\b[^.]{0,120}\b(?:rewards?|armor set|weapon set)\b|\b(?:skirmish|match) rewards?\b[^.]{0,80}\b(?:released|enabled)\b|^A new legendary [a-z]+\b[^.]{0,80}\bis now available\b/;
const WVW_WORDS = /WvW|World vs|War Score|Borderlands|Eternal Battlegrounds|skirmish|dolyak|\bsiege\b|Stonemist|\bkeeps?\b|\bsentry\b|Obsidian Sanctum|Edge of the Mists|\brelink/;
// The types a reader can trust; any other is shown with no label (a map, an event or a reward the
// rules are unsure of: the section's own title says it).
const SURE = new Set(['bug', 'neutral', 'buff', 'nerf', 'mixed', 'wvw_rule', 'event', 'reward']);

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
  // A digit before '%', not '\d+%': after '[^.;]*' that backtracks on a long run of digits (the
  // test "a line built to make the type's rules backtrack").
  if (new RegExp('(?:' + LOW + ')[^.;]*\\d%').test(t)) return null;
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
  if (EVENT_SURE.test(body)) return 'event';
  if (REWARD_SURE.test(body)) return 'reward';
  if (/^World vs\. World/.test(section) || /\b(War Score)\b/.test(text)) return 'wvw_rule';
  if (/(?<!\w)(Festival|Halloween|Lunar New Year|Dragon Bash|Wintersday|Extra Life|Summer Game Fest|Convergence|Incursion|Bonus Event|Release Highlights|Super Adventure)/.test(section) ||
    /\b(until|through|from) (?:January|February|March|April|May|June|July|August|September|October|November|December) \d|\bbeta\b|\bwill (?:run|be available|begin|end|turn on)\b/.test(text)) return 'event_unsure';
  if (/\b(new map|maps?)\b|Borderlands|Battlegrounds|Mists/.test(text)) return 'map';
  if (/^(Rewards|Wizard's Vault)/.test(section) || /\breward/i.test(text)) return 'reward_unsure';
  if (/^(Items|Gem Store|Trading Post|Launcher|Fashion Templates)/.test(section)) return 'item';
  if (/^(Raids|Fractals|Open World|Personal Story|Dungeons|Convergences?|Player vs)/.test(section)) return 'content';
  if (/\b(UI|interface|button|tooltip|option|menu|now (?:shows|displays)|display)\b/.test(text)) return 'qol';
  return 'other';
}

// The label shown, or null when the rules are not sure.
export const labelOf = (kind) => (SURE.has(kind) ? kind : null);

// ---- the push --------------------------------------------------------------

// The message: {v: 1, notes: [{page, update, lead, lines: [{section, sub, text, link, icon}]}]}; lead,
// the text under the update's heading before its first section.
// A message out of shape is refused whole (a string, the reason); a note or a line out of shape
// is left out and counted. Returns {notes: [{update, day, page, hotfix, lines: [...]}], dropped}.
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
  // Whether it is a hotfix is decided here, from the heading and the lead; nothing else the message says.
  const lead = typeof n.lead === 'string' ? plainText(n.lead) : null;
  const hotfix = !(RELEASE_RE.test(n.update) && lead !== null && lead.startsWith(RELEASE_NOTICE));
  return { update: n.update, day, page: n.page, hotfix, lines, dropped };
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
    link: typeof l.link === 'string' && LINK_RE.test(l.link) ? l.link : null,
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
//
// A reading is one push; a page is read when the push has a note on it (the script sends every
// update of each page it read, with or without WvW lines, and whole pages only). Each note of a
// page read takes the reading's lines, and one the reading lacks is deleted. The wiki's index shows
// its five newest pages, so a page the push lacks that is older than every page read has left the
// index, or was cut for size, and its notes keep their lines; one that is not older was deleted or
// renamed on the wiki, and its notes are deleted too. A line keeps `seen`, the first
// reading that had it, while every reading of its page has it, unchanged (a changed line is a new
// one), and `last`, the latest: a hotfix's line is published once `last` is HOTFIX_WAIT_S past `seen`,
// so one waiting on a page no longer read is never published.
export async function acceptNotes(db, data, nowMs, claim) {
  const checked = checkNotes(data, nowMs);
  if (typeof checked === 'string') return checked;
  const now = Math.floor(nowMs / 1000);
  const push = await sha16(JSON.stringify(checked.notes));
  const state = await db.prepare('SELECT push, ripe FROM note_served WHERE id = 1').first();
  const { results: groups } = await db.prepare('SELECT note, page FROM note_group').all();
  if (!await claim()) return null;
  const log = { notes: checked.notes.length, dropped: checked.dropped };
  if (state.push === push) {
    // The same reading again: only its time moves, unless a hotfix's line is due by now.
    log.same = true;
    if (state.ripe && state.ripe <= now) {
      log.ripe = true;
      await publish(db, push, now, JSON.stringify(checked.notes.map((n) => n.update)));
    } else {
      await db.prepare('UPDATE note_served SET wiki = ?1 WHERE id = 1').bind(now).run();
    }
    return log;
  }
  const pages = new Set(checked.notes.map((n) => n.page));
  const read = new Set(checked.notes.map((n) => n.update));
  const first = [...pages].sort()[0];
  const gone = groups.filter((g) => !read.has(g.note) && (pages.has(g.page) || g.page > first)).map((g) => g.note);
  const marks = checked.notes.map((n) => [n.update, n.day, n.page, n.hotfix ? 1 : 0]);
  if (gone.length) log.gone = gone;
  const rows = [];
  for (const n of checked.notes) {
    let pos = 0;
    for (const l of n.lines) rows.push([n.update, await lineId(n.update, l), pos++, l.section, l.sub, l.text, l.link, l.kind, now, now]);
  }
  const names = JSON.stringify([...read]);
  const oldest = new Date(nowMs - KEEP_NOTE_DAYS * 86400e3).toISOString().slice(0, 10);
  const drop = JSON.stringify(gone);
  await db.prepare('DELETE FROM note_line WHERE note IN (SELECT note FROM note_group WHERE day < ?1) OR note IN (SELECT value FROM json_each(?2))')
    .bind(oldest, drop).run();
  await db.prepare('DELETE FROM note_group WHERE day < ?1 OR note IN (SELECT value FROM json_each(?2))').bind(oldest, drop).run();
  await db.prepare('INSERT INTO note_group (note, day, page, hotfix) ' +
    "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]') FROM json_each(?1) j " +
    'WHERE true ON CONFLICT (note) DO UPDATE SET day = excluded.day, page = excluded.page, hotfix = excluded.hotfix')
    .bind(JSON.stringify(marks)).run();
  await db.prepare('DELETE FROM note_line WHERE note IN (SELECT value FROM json_each(?1)) AND ' +
    "note || '|' || id NOT IN (SELECT json_extract(j.value, '$[0]') || '|' || json_extract(j.value, '$[1]') FROM json_each(?2) j)")
    .bind(names, JSON.stringify(rows)).run();
  await db.prepare('INSERT INTO note_line (note, id, pos, section, sub, body, link, kind, seen, last) ' +
    "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), " +
    "json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), json_extract(j.value, '$[8]'), json_extract(j.value, '$[9]') FROM json_each(?1) j " +
    // The type is read again: the id leaves out the icon, which the wiki may add later, and the text past the cut.
    'WHERE true ON CONFLICT (note, id) DO UPDATE SET pos = excluded.pos, kind = excluded.kind ' +
    'WHERE note_line.pos <> excluded.pos OR note_line.kind IS NOT excluded.kind')
    .bind(JSON.stringify(rows)).run();
  log.lines = rows.length;
  await publish(db, push, now, names);
  return log;
}

// The published lines, newest day first, as one row: GET /api/notes reads that row alone. A hotfix's
// line still waiting is left out, and `ripe` is when the first of them a page read holds is due.
// `read`: the notes of this reading, JSON; their lines are all in it.
async function publish(db, push, wiki, read) {
  const held = wiki - HOTFIX_WAIT_S;
  await db.prepare('UPDATE note_line SET last = ?1 WHERE note IN (SELECT value FROM json_each(?2)) AND last - seen < ?3')
    .bind(wiki, read, HOTFIX_WAIT_S).run();
  const { results } = await db.prepare('SELECT l.note, l.section, l.sub, l.body, l.link, l.kind, g.day, g.page, g.hotfix ' +
    'FROM note_line l JOIN note_group g ON g.note = l.note WHERE g.hotfix = 0 OR l.last - l.seen >= ?2 ' +
    'ORDER BY g.day DESC, g.note DESC, l.pos LIMIT ?1').bind(MAX_SERVED, HOTFIX_WAIT_S).all();
  const body = JSON.stringify(results.map((r) => ({
    day: r.day, update: r.note, section: r.section, sub: r.sub, text: r.body, type: r.kind,
    hotfix: r.hotfix === 1, page: WIKI + 'Game_updates/' + r.page, link: r.link === null ? null : wikiLink(r.link)
  })));
  await db.prepare('UPDATE note_served SET body = ?1, version = ?2, push = ?3, wiki = ?4, ' +
    'ripe = coalesce((SELECT min(l.seen) FROM note_line l JOIN note_group g ON g.note = l.note WHERE g.hotfix = 1 AND l.seen > ?5 AND l.note IN (SELECT value FROM json_each(?7))) + ?6, 0) WHERE id = 1')
    .bind(body, await sha16(body), push, wiki, held, HOTFIX_WAIT_S, read).run();
}

// ---- the reads ---------------------------------------------------------------

export const NOTES_VERSION_RE = /^\?v=([0-9a-f]{16})$/;

// {version, wiki, body}: wiki, the time of the last accepted reading, epoch s (0 never).
export async function servedNotes(db) {
  return db.prepare('SELECT version, wiki, body FROM note_served WHERE id = 1').first();
}
