'use strict';
// Community guild sheet (NA WvW Discord): CSV parsing and the per-team index of alliances and solo guilds.

// Minimal CSV parser: quoted fields and embedded newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip, \n right after ends the row
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Splits "[TAG] Name (region)". Two anchored regexes, not one combined pattern: a lazy match plus an optional group backtracks badly (ReDoS).
const GUILD_TAG_RE = /^\[([^\]]+)\]/;
const TRAILING_REGION_RE = /\(([^()]+)\)\s*$/;
function parseGuildEntry(raw) {
  const trimmed = raw.trim();
  const tagMatch = GUILD_TAG_RE.exec(trimmed);
  if (!tagMatch) return { tag: null, name: trimmed, region: null };

  let rest = trimmed.slice(tagMatch[0].length).trim();
  if (rest.startsWith('-')) rest = rest.slice(1).trim();

  const regionMatch = TRAILING_REGION_RE.exec(rest);
  if (!regionMatch) return { tag: tagMatch[1], name: rest, region: null };

  return {
    tag: tagMatch[1],
    name: rest.slice(0, regionMatch.index).trim(),
    region: regionMatch[1]
  };
}

// Columns shift whenever a maintainer inserts one, so they are resolved by header
// name at parse time. These numbers are only the fallback for an unexpected header rename.
const SOLO_WORLD_FALLBACK = 21;
const SOLO_MISMATCH_FALLBACK = 19;
const ALLIANCE_MEMBERS_FALLBACK = 2;
const ALLIANCE_WORLD_FALLBACK = 22;

// Exact header match first, substring second - that ordering is what lets
// 'World' find the alliance tab's "World ID" without a loose match
// hijacking a tab that has a real "World" column somewhere later.
function findColumn(header, names, fallbackIndex) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const cells = (Array.isArray(header) ? header : []).map(norm);

  for (const name of names) {
    const i = cells.indexOf(norm(name));
    if (i !== -1) return i;
  }
  for (const name of names) {
    const i = cells.findIndex((c) => c.includes(norm(name)));
    if (i !== -1) return i;
  }
  return fallbackIndex;
}

let communityGuildsCache = null; // Map: teamName -> { alliances, solo }
let communityGuildsCachedAt = 0;

async function fetchSheetCsv(tab) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(SHEET_URL(tab), { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`Sheet "${tab}" request failed (HTTP ${res.status})`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function addToTeam(byTeam, teamName) {
  if (!byTeam.has(teamName)) byTeam.set(teamName, { alliances: [], solo: [] });
  return byTeam.get(teamName);
}

async function loadCommunityGuilds() {
  if (communityGuildsCache && Date.now() - communityGuildsCachedAt < COMMUNITY_SHEET_TTL_MS) {
    return communityGuildsCache;
  }

  const [soloText, allianceText] = await Promise.all([
    fetchSheetCsv('SoloGuilds'),
    fetchSheetCsv('Alliances')
  ]);

  const soloRows = parseCsv(soloText);
  const allianceRows = parseCsv(allianceText);

  const soloWorldCol = findColumn(soloRows[0], ['World'], SOLO_WORLD_FALLBACK);
  const soloMismatchCol = findColumn(soloRows[0], ['API Mismatch'], SOLO_MISMATCH_FALLBACK);
  const allianceWorldCol = findColumn(allianceRows[0], ['World ID', 'World'], ALLIANCE_WORLD_FALLBACK);
  const allianceMembersCol = findColumn(allianceRows[0], ['Guilds'], ALLIANCE_MEMBERS_FALLBACK);

  const byTeam = new Map();

  // A flagged guild is one the maintainers cannot place. The row keeps the World it
  // was last sorted into, but the sheet leaves it out of that team's own tab, so the
  // column alone would put guilds on a server the sheet does not.
  for (const row of soloRows.slice(1)) {
    const world = (row[soloWorldCol] || '').trim();
    const raw = (row[0] || '').trim();
    if (!world || !raw) continue;
    if ((row[soloMismatchCol] || '').trim().toUpperCase() === 'TRUE') continue;
    addToTeam(byTeam, world).solo.push(parseGuildEntry(raw));
  }

  for (const row of allianceRows.slice(1)) {
    const world = (row[allianceWorldCol] || '').trim();
    const raw = (row[0] || '').trim();
    if (!world || !raw) continue;
    const members = (row[allianceMembersCol] || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseGuildEntry);
    addToTeam(byTeam, world).alliances.push({ ...parseGuildEntry(raw), members });
  }

  communityGuildsCache = byTeam;
  communityGuildsCachedAt = Date.now();
  return byTeam;
}

