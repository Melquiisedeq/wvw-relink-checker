// ---------------------------------------------------------------------
// Configuration
// Team tables, API endpoints and every tunable number in one place.
// Nothing here reads the DOM or the network; it is all constants.
// ---------------------------------------------------------------------

'use strict';

// Team ID to name table from the official API wiki. Update manually for new teams.
const TEAM_NAMES = Object.freeze({
  "11001": "Moogooloo",
  "11002": "Rall's Rest",
  "11003": "Domain of Torment",
  "11004": "Yohlon Haven",
  "11005": "Tombs of Drascir",
  "11006": "Hall of Judgment",
  "11007": "Throne of Balthazar",
  "11008": "Dwayna's Temple",
  "11009": "Abaddon's Prison",
  "11010": "Cathedral of Blood",
  "11011": "Lutgardis Conservatory",
  "11012": "Mosswood",
  "12001": "Skrittsburgh",
  "12002": "Fortune's Vale",
  "12003": "Silent Woods",
  "12004": "Ettin's Back",
  "12005": "Domain of Anguish",
  "12006": "Palawadan",
  "12007": "Bloodstone Gulch",
  "12008": "Frost Citadel",
  "12009": "Dragrimmar",
  "12010": "Grenth's Door",
  "12011": "Mirror of Lyssa",
  "12012": "Melandru's Dome",
  "12013": "Kormir's Library",
  "12014": "Great House Aviary",
  "12015": "Bava Nisos"
});

// Looks up a team's display name. Uses hasOwnProperty so a lookup key like
// "__proto__" can't resolve through the prototype chain instead of failing.
function getTeamName(teamId) {
  if (Object.prototype.hasOwnProperty.call(TEAM_NAMES, teamId)) return TEAM_NAMES[teamId];
  return `Unknown team (ID ${teamId})`;
}

const REGION_NAMES = Object.freeze({ '1': 'NA', '2': 'EU' });
const COLORS = ['red', 'blue', 'green'];
const RANK_LABELS = Object.freeze({ 1: '1', 2: '2', 3: '3' });

// "all_worlds" mixes legacy 4-digit world numbers with the modern 5-digit
// Team ID in no fixed order, so >= 10000 reliably picks out the Team ID.
function matchTeamId(match, color) {
  const list = match.all_worlds && match.all_worlds[color];
  if (!Array.isArray(list)) return null;
  const teamId = list.find((n) => Number(n) >= 10000);
  return teamId !== undefined ? String(teamId) : null;
}

const API_BASE = "https://api.guildwars2.com/v2";
const GUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// NA WvW Discord's community-maintained guild/alliance sheet. Covers NA
// servers only. Read-only, via the gviz CSV export (no API key needed).
const SHEET_ID = '1Txjpcet-9FDVek6uJ0N3OciwgbpE0cfWozUK7ATfWx4';
const SHEET_URL = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
const SHEET_HUMAN_URL = 'https://bit.ly/46pscDg';

const MAX_ENTRIES = 60;        // hard cap so a pasted wall of text can't hammer a public API
const MAX_NAME_LENGTH = 64;    // real guild names and GUIDs are well under this
const REQUEST_TIMEOUT_MS = 10000;
const THROTTLE_MS = 200;       // gap between sequential lookups, to stay well under rate limits
const MAX_RETRIES = 2;         // for 429 / transient network errors

// Match data updates unpredictably on ArenaNet's end; 3 min balances
// freshness vs load. Lockout barely changes, so it's checked less often.
// Both stay under the API rate limit and only run while the tab is visible.
const STANDINGS_REFRESH_MS = 5 * 60 * 1000;  // match scores, kills/deaths, VP, relink
const TIMERS_REFRESH_MS = 10 * 60 * 1000;    // season lockout
// Community sheet is edited by hand; re-fetched on click with a short TTL.
const COMMUNITY_SHEET_TTL_MS = 5 * 60 * 1000;
