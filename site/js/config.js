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
// The three sides of every match, and the only spelling of them -
// maps.js used to carry a Set and a literal saying the same thing.
const COLORS = Object.freeze(['red', 'blue', 'green']);

// "all_worlds" mixes legacy 4-digit world numbers with the modern 5-digit
// Team ID in no fixed order, so >= 10000 reliably picks out the Team ID.
function matchTeamId(match, color) {
  const list = match.all_worlds && match.all_worlds[color];
  if (!Array.isArray(list)) return null;
  const teamId = list.find((n) => Number(n) >= 10000);
  return teamId !== undefined ? String(teamId) : null;
}

// A match whose end_time has passed describes a week that is over: the
// scores are final and the maps are last week's. ArenaNet republishes
// the tiers one at a time and not always forwards - during the relink of
// 26/09 tier 4 was on the new week while 1, 2 and 3 were still on the
// old, and tier 2 published the new week and then went back. So this is
// asked of a single match, never of a region.
function matchIsLive(match) {
  const end = Date.parse(match && match.end_time);
  return Number.isFinite(end) && end > Date.now();
}

const API_BASE = "https://api.guildwars2.com/v2";
const GUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// NA WvW Discord's community-maintained guild/alliance sheet. Covers NA
// servers only. Read-only, via the gviz CSV export (no API key needed).
const SHEET_ID = '1Txjpcet-9FDVek6uJ0N3OciwgbpE0cfWozUK7ATfWx4';
const SHEET_URL = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
// The same sheet for a person to open, built from SHEET_ID rather than
// kept as a bit.ly link: whoever owns a shortener can repoint it later,
// and it hides where the link goes until after the click.
const SHEET_HUMAN_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`;

const MAX_ENTRIES = 60;        // hard cap so a pasted wall of text can't hammer a public API
const MAX_NAME_LENGTH = 64;    // real guild names and GUIDs are well under this
const REQUEST_TIMEOUT_MS = 10000;
const THROTTLE_MS = 200;       // gap between sequential lookups, to stay well under rate limits
const MAX_RETRIES = 2;         // for 429 / transient network errors

// Match data updates unpredictably on ArenaNet's end; 5 min balances
// freshness vs load. Lockout barely changes, so it's checked less often.
// Both stay under the API rate limit and only run while the tab is visible.
const STANDINGS_REFRESH_MS = 5 * 60 * 1000;  // match scores, kills/deaths, VP, relink
const TIMERS_REFRESH_MS = 10 * 60 * 1000;    // season lockout
// Community sheet is edited by hand; re-fetched on click with a short TTL.
const COMMUNITY_SHEET_TTL_MS = 5 * 60 * 1000;

// Kills history. The GW2 API publishes kills and deaths only as running
// totals for the week, so "which map is busy now" cannot be read from one
// answer - and a visitor arriving cold has no earlier reading. So a
// Google Apps Script trigger takes a snapshot every five minutes and
// appends it here, trimming to a rolling two hours. Read through the gviz
// CSV export, the same trick the community guild sheet uses: no API key,
// and docs.google.com is already in the CSP. Measured at 449ms for the
// whole file, faster than the GW2 call the popover already waits on.
//
// The sheet and the script that fills it are part of this project, not a
// third-party feed, so the shape below is a decision rather than a
// constraint: change it at the source, not around it here.
//
// Columns, in this order and with no header row:
//   epoch ms | match id | Center | RedHome | BlueHome | GreenHome
// The four numbers are player kills summed over all three sides - see
// fightTotals in js/maps.js for why deaths are left out.
const KILLS_SHEET_ID = '1Lh6dGhlYVvvKlXT_tofEUKZhYGW71Jij1IstbdPF2fg';
const KILLS_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${KILLS_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=kills`;
const KILLS_SHEET_TTL_MS = 5 * 60 * 1000;

// This project's own copy of the same two things, served by the wvwrelink-api
// Worker from its database, which both Apps Scripts push to after every tick.
// Tried first; any failure - quota, rate limit, a stale copy, a timeout - reads
// the sheet as before, so the page is never worse off than without it. The
// shorter deadline is what a failure costs before that fallback.
const OWN_KILLS_URL = '/api/kills';
const OWN_RELINK_URL = '/api/relink';
const OWN_API_TIMEOUT_MS = 4000;
// Must match the column order the Apps Script writes.
const KILLS_MAP_ORDER = Object.freeze(['Center', 'RedHome', 'BlueHome', 'GreenHome']);

// The teams notice. In the days before a relink the new team assignment becomes
// queryable and nothing announces it: the API has no timestamp for it, no ETag,
// no field that changes. The only signal in existence is the guild-to-team
// table itself moving, and seeing that means holding a copy and comparing half
// a megabyte - which is why the comparing happens in an Apps Script trigger on
// this project's own account, the same way the kills history is produced, and
// arrives here as two integers in one cell.
//
//   window     the NA teamAssignment these numbers are about, epoch seconds
//   published  when the table was seen to have moved, epoch seconds, or 0
//
// Both are integers and nothing else is ever read out of that cell.
// updateTeamsNotice in js/relink.js says what each of them decides.
//
// Its own spreadsheet rather than a tab of the kills one, so the two features
// do not share a fate. The cost is a second sharing setting to keep right, and
// it is the one that matters: published read-only, because whoever could write
// that cell could make this page announce a relink that has not happened.
const RELINK_SHEET_ID = '14kWfueHYO2-aLKGDVFgdkuO9pHkmYs1fghCO9eMIEl4';
// `range=A1:A1` is load-bearing, not tidiness. A2 of the same tab holds the
// trigger's heartbeat, and RELINK_STATE_RE anchors the WHOLE body - so a second
// row in the export is a body the page refuses, which would take the notice away
// entirely and look exactly like the sheet being down. Asking for the one cell
// also means nothing added to that tab later can reach this read.
const RELINK_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${RELINK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=relink&range=A1:A1`;
// No point being fresher than the timers that decide the window, and the value
// changes once a month. Once it says published there is nothing left to learn,
// and the page stops asking entirely.
const RELINK_SHEET_TTL_MS = 10 * 60 * 1000;
