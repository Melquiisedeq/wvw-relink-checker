// Configuration: team tables, endpoints and every tunable number. Constants only.

'use strict';

// Team ID to name, from the official API wiki. Updated by hand for new teams.
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

// hasOwnProperty, so a key like "__proto__" cannot resolve through the prototype chain.
function getTeamName(teamId) {
  if (Object.prototype.hasOwnProperty.call(TEAM_NAMES, teamId)) return TEAM_NAMES[teamId];
  return `Unknown team (ID ${teamId})`;
}

const REGION_NAMES = Object.freeze({ '1': 'NA', '2': 'EU' });
// The three sides of every match, and the only spelling of them.
const COLORS = Object.freeze(['red', 'blue', 'green']);

// "all_worlds" mixes legacy 4-digit world numbers with the modern 5-digit
// Team ID in no fixed order, so >= 10000 reliably picks out the Team ID.
function matchTeamId(match, color) {
  const list = match.all_worlds && match.all_worlds[color];
  if (!Array.isArray(list)) return null;
  const teamId = list.find((n) => Number(n) >= 10000);
  return teamId !== undefined ? String(teamId) : null;
}

// A match whose end_time has passed describes a week that is over. ArenaNet
// republishes the tiers one at a time and not always forwards, so this is
// asked of a single match, never of a region.
function matchIsLive(match) {
  const end = Date.parse(match && match.end_time);
  return Number.isFinite(end) && end > Date.now();
}

const API_BASE = "https://api.guildwars2.com/v2";
const GUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// NA WvW Discord's community guild/alliance sheet (NA servers only), read through the gviz CSV export.
const SHEET_ID = '1Txjpcet-9FDVek6uJ0N3OciwgbpE0cfWozUK7ATfWx4';
const SHEET_URL = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
// The same sheet for a person to open: built from SHEET_ID, not a shortener
// whose owner could repoint it.
const SHEET_HUMAN_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`;

const MAX_ENTRIES = 20;        // hard cap so a pasted wall of text can't hammer a public API
const MAX_NAME_LENGTH = 64;    // real guild names and GUIDs are well under this
const REQUEST_TIMEOUT_MS = 10000;
// The whole ids=all standings body and the guild tables can take 40 s on a slow
// line, so 10 s throws them away. Only the first standings load and the guild
// search wait this long; every refresh keeps the short deadline.
const SLOW_REQUEST_TIMEOUT_MS = 30000;
// After a failed standings load: the window, in ms, of each extra try, with full
// jitter (a random point inside it). Then the ordinary cycle takes over.
const STANDINGS_RETRY_WINDOWS_MS = [[5000, 15000], [15000, 40000]];
const THROTTLE_MS = 200;       // gap between sequential lookups, to stay well under rate limits
const MAX_RETRIES = 2;         // for 429 / transient network errors

// Match data updates unpredictably; 5 min balances freshness and load. Lockout
// barely changes, so it is checked less often. Both run only while the tab is visible.
// The visitor's choice of which standings column goes left, 'na' or 'eu'.
// js/region.js reads it by this same literal, before this file loads.
const RAIL_FIRST_KEY = 'wvw-rail-first';

const STANDINGS_REFRESH_MS = 5 * 60 * 1000;  // match scores, kills/deaths, VP, relink
const TIMERS_REFRESH_MS = 10 * 60 * 1000;    // season lockout
// Community sheet is edited by hand; re-fetched on click with a short TTL.
const COMMUNITY_SHEET_TTL_MS = 5 * 60 * 1000;

// Kills history: an Apps Script snapshot every five minutes over a rolling two
// hours. The shape is this project's own: change it at the source.
// Columns, in this order, no header row:
//   epoch ms | match id | Center | RedHome | BlueHome | GreenHome
// The four numbers are player kills summed over all three sides (fightTotals
// in js/maps.js says why deaths are left out).
const KILLS_SHEET_ID = '1Lh6dGhlYVvvKlXT_tofEUKZhYGW71Jij1IstbdPF2fg';
const KILLS_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${KILLS_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=kills`;
const KILLS_SHEET_TTL_MS = 5 * 60 * 1000;

// This project's own copy of the same two things, served by the wvwrelink-api
// Worker. Tried first; any failure reads the sheet, so the page is never worse
// off. The short deadline is what a failure costs before that fallback.
const OWN_KILLS_URL = '/api/kills';
const OWN_RELINK_URL = '/api/relink';
const OWN_API_TIMEOUT_MS = 4000;
// Must match the column order the Apps Script writes.
const KILLS_MAP_ORDER = Object.freeze(['Center', 'RedHome', 'BlueHome', 'GreenHome']);

// The teams notice. The API announces a new team assignment nowhere, so an Apps
// Script trigger compares the guild-to-team table and leaves two integers in one
// cell (the counting cannot happen in the page).
//   window     the NA teamAssignment these numbers are about, epoch seconds
//   published  when the table was seen to have moved, epoch seconds, or 0
// Nothing else is read out of that cell; updateTeamsNotice in js/relink.js says
// what each decides. Its own spreadsheet, shared read-only: whoever could write
// that cell could make this page announce a relink that has not happened.
const RELINK_SHEET_ID = '14kWfueHYO2-aLKGDVFgdkuO9pHkmYs1fghCO9eMIEl4';
// `range=A1:A1` is load-bearing. A2 of the same tab holds the trigger's
// heartbeat and RELINK_STATE_RE anchors the WHOLE body: a second row is a body
// the page refuses, which removes the notice and looks like the sheet being down.
const RELINK_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${RELINK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=relink&range=A1:A1`;
// No point being fresher than the timers that decide the window; the value changes
// once a month, and once it says published the page stops asking.
const RELINK_SHEET_TTL_MS = 10 * 60 * 1000;
