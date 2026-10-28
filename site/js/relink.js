'use strict';
// Relink and season timers: the countdown to the next relink and the season lockout, and the banner they feed.

function formatCountdown(msRemaining) {
  if (msRemaining === null) return 'unknown';
  if (msRemaining <= 0) return 'any moment now';

  const totalMinutes = Math.floor(msRemaining / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Each region's weekly reset, in UTC: [day of week, hour]. The same hours
// as RESET in worker/index.mjs and supabase/reader.mjs: change all three.
const RESET_SCHEDULE = { NA: [6, 2], EU: [5, 18] };
const RESET_ARRIVAL_MS = 15 * 60 * 1000;

function lastResetOf(region, now) {
  const [day, hour] = RESET_SCHEDULE[region];
  const d = new Date(now);
  const back = (d.getUTCDay() - day + 7) % 7;
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, hour);
  if (t > now) t -= RELINK_WEEK_MS;
  return t;
}

function regionResetting(region, now) {
  const last = lastResetOf(region, now);
  if (now - last >= RESET_ARRIVAL_MS) return false;
  const start = region === 'NA' ? resetNA : resetEU;
  return !(start !== null && start >= last - RESET_ARRIVAL_MS);
}

function countdownText(ms, resetting) {
  if (resetting && (ms === null || ms <= 0)) return 'resetting';
  return formatCountdown(ms);
}

// Feather's alert-triangle, at the weight of the page's other glyphs. Used in
// the stat's own label and the line underneath.
const WARN_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
  '<path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

function buildRelinkStat(title, value, isPrimary, tooltip, warn) {
  const stat = document.createElement('div');
  stat.className = isPrimary ? 'relink-stat relink-stat--primary' : 'relink-stat';
  stat.title = tooltip;
  const titleEl = document.createElement('div');
  titleEl.className = 'relink-stat-title';
  titleEl.textContent = title;
  if (warn) titleEl.insertAdjacentHTML('afterbegin', WARN_ICON);
  const valueEl = document.createElement('div');
  valueEl.className = 'relink-stat-value';
  if (typeof value === 'string') {
    valueEl.textContent = value;
  } else {
    valueEl.appendChild(value);
  }
  stat.appendChild(titleEl);
  stat.appendChild(valueEl);
  return stat;
}

// Inside the last two hours the banner starts breathing.
const RELINK_URGENT_MS = 2 * 60 * 60 * 1000;
// How long after a week is published before its maps are up: every match opened
// 3m37s to 3m47s after start_time, so five minutes covers it. The line dies
// with it: "get in early" is no use once the doors are open.
const RELINK_OPENING_MS = 5 * 60 * 1000;
// Only reached when nothing has been published anywhere: the fuse for an API
// that has stopped answering.
const RELINK_STUCK_MS = 30 * 60 * 1000;
// The final week of the season, after which the countdown is about the relink,
// not a reset. Exact, not an estimate: teamAssignment minus seven days is the
// previous reset to the minute.
const RELINK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Whether a region's relink is close enough to shout about. Three ways
// in, handing over to each other so the bar never blinks out mid-reset:
//
//   before   the countdown is inside two hours
//   during   every tier is still on the week that just ended
//   opening  the new week is published but its maps are not up
//
// NA and EU relink at different times, so this is asked per region.
function regionIsUrgent(relinkAt, resetAt, hasLive, now) {
  if (relinkAt !== null) {
    const left = relinkAt - now;
    if (left > 0 && left <= RELINK_URGENT_MS) return true;
    if (!hasLive && left <= 0 && left > -RELINK_STUCK_MS) return true;
  }
  if (resetAt !== null) {
    const since = now - resetAt;
    if (since >= 0 && since < RELINK_OPENING_MS) return true;
  }
  return false;
}

// The game's own crossed swords, the icon WvW puts on a fight in progress.
// Deliberately not the lockout's warning triangle: a relink is an event you turn
// up for, not a deadline you can miss. The file is a flat alpha silhouette, hence
// a mask over currentColor and not an <img>: one asset, tinted by its state.
function swordsIcon() {
  const s = document.createElement('span');
  s.className = 'swords-icon';
  return s;
}

// Dims the region labels (NA/EU) and emphasizes the countdown values.
function buildRelinkValue(naMs, euMs, naNow, euNow, naResetting, euResetting) {
  const frag = document.createDocumentFragment();
  const naRegion = document.createElement('span');
  naRegion.className = naNow ? 'region is-now' : 'region';
  naRegion.textContent = 'NA ';
  const naTime = document.createElement('span');
  naTime.className = naNow ? 'time is-now' : 'time';
  naTime.textContent = countdownText(naMs, naResetting);
  // The dot is its own element so that it never lights: folded into ' . EU ' it
  // would carry EU's is-now and brighten with the wrong region.
  const sep = document.createElement('span');
  sep.className = 'region';
  sep.textContent = ' · ';
  const euRegion = document.createElement('span');
  euRegion.className = euNow ? 'region is-now' : 'region';
  euRegion.textContent = 'EU ';
  const euTime = document.createElement('span');
  euTime.className = euNow ? 'time is-now' : 'time';
  euTime.textContent = countdownText(euMs, euResetting);
  if (railFirst() === 'eu') frag.append(euRegion, euTime, sep, naRegion, naTime);
  else frag.append(naRegion, naTime, sep, euRegion, euTime);
  return frag;
}

// Module-level so fetchTimers() and updateRelinkBanner() can run on
// independent schedules and both read the latest values.
let lockoutTime = null;
let timersLoaded = false;
// The first drawing has to be the right one: the matches alone draw only the
// weekly countdown, and the timers would then turn it into the relink's taller
// bar and the page would jump. So nothing is drawn until the timers have answered
// or failed, or three seconds have gone (a hung request must not keep the bar away).
let bannerMayDraw = false;
setTimeout(() => {
  if (!bannerMayDraw) { bannerMayDraw = true; updateRelinkBanner(); }
}, 3000);

// Weekly relink: when tier matchups end and everyone is shuffled into
// new pairings. Read straight from the match data's own end_time, so
// no separate request; refreshes on the same cadence as standings.
let relinkNA = null;
let relinkEU = null;
let resetNA = null;
let resetEU = null;
let liveNA = false;
let liveEU = false;

// The relink proper: when the teams themselves are rebuilt, which is a
// different event from the week rolling over even though they land two
// minutes apart. Its own endpoint, and unlike the lockout the regions
// differ - EU goes eight hours before NA.
let assignNA = null;
let assignEU = null;

function msOrNull(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

async function fetchTimers() {
  try {
    const lockoutRaw = await fetchJson(`${API_BASE}/wvw/timers/lockout`);
    const lockout = Array.isArray(lockoutRaw) ? lockoutRaw[0] : lockoutRaw;
    // NA and EU lockout timestamps are always identical, so only one is kept.
    lockoutTime = msOrNull(lockout?.na) ?? msOrNull(lockout?.eu);
    timersLoaded = true;
  } catch {
    // Keep showing the last known value; the banner just skips this cycle.
  }
  // Its own try, so one endpoint failing does not cost the other its
  // figures - they drive different halves of the bar.
  try {
    const raw = await fetchJson(`${API_BASE}/wvw/timers/teamAssignment`);
    const at = Array.isArray(raw) ? raw[0] : raw;
    assignNA = msOrNull(at?.na);
    assignEU = msOrNull(at?.eu);
  } catch {
    // Same reasoning: the last figures stand.
  }
  bannerMayDraw = true;
  updateRelinkBanner();
}

// The latest of a field across a region's matches. Reading one match (tier 1) is
// a coin toss while a relink takes: tiers publish the new week one at a time, and
// not always forwards. Whichever tier is furthest ahead has seen the relink.
function latestOf(matches, field) {
  const times = matches
    .map((m) => Date.parse(m && m[field]))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// start_time is the far side of the event end_time names: when the
// newest published week began, which is what says the maps are about to
// open. end_time cannot say that - by then it is a week away again.
//
// A region whose request failed arrives as null and keeps the figures it
// had. Read as an empty list it would set its countdown to null and take
// that half of the banner down over a single refresh that did not
// answer.
function updateRelinkFromMatches(naMatches, euMatches) {
  if (naMatches) {
    relinkNA = latestOf(naMatches, 'end_time');
    resetNA = latestOf(naMatches, 'start_time');
    liveNA = naMatches.some(matchIsLive);
  }
  if (euMatches) {
    relinkEU = latestOf(euMatches, 'end_time');
    resetEU = latestOf(euMatches, 'start_time');
    liveEU = euMatches.some(matchIsLive);
  }
  if (bannerMayDraw) updateRelinkBanner();
}

// The beat's green layer is .relink-inner::before (css/facets.css), rebuilt every
// minute: its animation would restart and fall out of step with the red and blue
// ones on the bar itself. Pinned to the red's clock, which never restarts, the
// three stay 2.1 s apart. By currentTime, not startTime: while the page idles
// (.is-idle pauses every animation) a paused animation has no startTime.
function keepBeatInStep(inner) {
  if (!document.getAnimations) return;
  let red = null;
  let green = null;
  for (const a of document.getAnimations()) {
    if (a.animationName !== 'rebuild-beat') continue;
    if (a.effect.target === relinkBanner && a.effect.pseudoElement === '::before') red = a;
    else if (a.effect.target === inner) green = a;
  }
  if (red && green && red.currentTime !== null) green.currentTime = red.currentTime;
}

// The relink's own value line, shaped like the weekly one, except that a region
// that has already relinked shows it is done: 'any moment now' would be wrong
// for the eight hours EU spends waiting for NA.
function buildRebuildValue(naLeft, euLeft) {
  const frag = document.createDocumentFragment();
  const half = (name, left) => {
    const lit = left !== null && left > 0 && left <= RELINK_URGENT_MS;
    const region = document.createElement('span');
    region.className = lit ? 'region is-now' : 'region';
    region.textContent = name + ' ';
    const time = document.createElement('span');
    time.className = lit ? 'time is-now' : 'time';
    time.textContent = left !== null && left <= 0 ? 'done' : formatCountdown(left);
    time.dataset.text = time.textContent;
    return [region, time];
  };
  const sep = document.createElement('span');
  sep.className = 'region';
  sep.textContent = ' \u00b7 ';
  const [first, second] = railFirst() === 'eu'
    ? [half('EU', euLeft), half('NA', naLeft)]
    : [half('NA', naLeft), half('EU', euLeft)];
  frag.append(...first, sep, ...second);
  return frag;
}

// The relink's bar. One stat and no divider: by now the lockout has nothing left
// to say, and the reset is the same instant this counts to.
function buildRebuildBanner(naLeft, euLeft) {
  relinkBanner.classList.add('is-rebuild');
  const inner = document.createElement('div');
  inner.className = 'relink-inner';
  const stat = document.createElement('div');
  stat.className = 'relink-stat';

  const word = document.createElement('div');
  word.className = 'relink-word';
  const text = document.createElement('span');
  text.className = 'relink-word-text';
  text.textContent = 'Relink';
  const rule = (right) => {
    const r = document.createElement('span');
    r.className = right ? 'relink-rule is-right' : 'relink-rule';
    return r;
  };
  word.append(swordsIcon(), rule(false), text, rule(true), swordsIcon());

  const value = document.createElement('div');
  value.className = 'relink-stat-value';
  value.appendChild(buildRebuildValue(naLeft, euLeft));

  stat.append(word, value);
  inner.appendChild(stat);
  relinkBanner.style.display = 'block';
  relinkBanner.appendChild(inner);
  keepBeatInStep(inner);

  const alert = document.createElement('div');
  alert.className = 'relink-alert';
  alert.appendChild(swordsIcon());
  const line = document.createElement('span');
  // Nothing here asks for an action: the lockout closed days ago. It announces.
  line.textContent = 'New link, new enemies, and a month of good fights ahead.';
  alert.appendChild(line);
  relinkBanner.appendChild(alert);
}

// ---- The teams notice -------------------------------------------------
// For the days between ArenaNet publishing the new assignment and the relink
// landing. The finding is counted by the Apps Script trigger and read from the
// sheet; RELINK_SHEET_URL in config.js says why it cannot be counted here.

// One cell, holding "window:published" as text: two number cells would come back
// through the CSV export in the sheet's own number format (a thousands separator
// is a comma in a comma-separated file). Nothing but two integers is accepted:
// the sheet is world-readable and this value decides what the page claims.
const RELINK_STATE_RE = /^"?(\d{1,12}):(\d{1,12})"?$/;

let relinkState = null;        // { window, published }
// When the notice last went up on this page. The guild-to-team table kept
// from before that is the old month's (getWvwMaps).
let teamsNoticeUpAt = 0;
let relinkStateAt = 0;
let relinkStateInFlight = null;
let relinkStateFailedAt = 0;

// After a failed read, wait before asking again; otherwise the banner's one-minute
// tick retries for the four days the window is open, in every open tab, usually
// against a misconfiguration. Short enough that a blip costs minutes, not the window.
const RELINK_SHEET_RETRY_MS = 2 * 60 * 1000;

async function getRelinkState() {
  if (relinkState && Date.now() - relinkStateAt < RELINK_SHEET_TTL_MS) {
    return relinkState;
  }
  if (relinkStateFailedAt
    && Date.now() - relinkStateFailedAt < RELINK_SHEET_RETRY_MS) {
    return relinkState;
  }
  if (relinkStateInFlight) return relinkStateInFlight;

  relinkStateInFlight = (async () => {
    try {
      relinkState = await readOwnRelink().catch(readRelinkSheet);
      relinkStateAt = Date.now();
      relinkStateFailedAt = 0;
    } catch {
      // On doubt, nothing: a strip that appears because a read went wrong would
      // send people to the old answer.
      relinkStateFailedAt = Date.now();
    } finally {
      relinkStateInFlight = null;
    }
    return relinkState;
  })();
  return relinkStateInFlight;
}

// The same two integers from this project's API, held to the same standard
// as the sheet: anything but two whole numbers of the sheet's size is a
// failure, and a failure reads the sheet.
async function readOwnRelink() {
  const d = await fetchOwnApi(OWN_RELINK_URL);
  const ok = (n) => Number.isSafeInteger(n) && n >= 0 && n < 1e12;
  if (!d || !ok(d.window) || !ok(d.published)) throw new Error('not two integers');
  return { window: d.window, published: d.published };
}

async function readRelinkSheet() {
  // The same deadline as every other request: a connection that accepts and goes
  // quiet would leave this pending for good, and relinkStateInFlight hands that
  // promise to every later caller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(RELINK_SHEET_URL,
      { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const found = RELINK_STATE_RE.exec((await res.text()).trim());
    if (!found) throw new Error('not two integers');
    return { window: Number(found[1]), published: Number(found[2]) };
  } finally {
    clearTimeout(timer);
  }
}

// Dismissal is remembered as the window it was dismissed in, not as a flag: next
// month's window has a different id and brings the strip back with no expiry logic.
const TEAMS_NOTICE_KEY = 'wvw-relink-checker:teams-notice';

function teamsNoticeDismissed(windowId) {
  try { return localStorage.getItem(TEAMS_NOTICE_KEY) === String(windowId); }
  catch { return false; } // storage off: it shows, which is the harmless way to be wrong
}

// Feather's bell, at the weight of the page's other glyphs. The mark that opens
// the strip has to say "this is a notice" before a word is read; the alert
// triangle belongs to the lockout and the shield means "there is a guild list
// behind this", so the shield appears mid-sentence instead.
const NOTICE_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
  'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

// The page's own name for its two answers, written the way they appear on it.
// The strip neither sends people to the sheet nor grows its own button: the
// sentence points at what is already here, with the marks themselves.
function buildTeamsNotice(windowId) {
  teamsNotice.textContent = '';

  const mark = document.createElement('span');
  mark.className = 'teams-notice-mark';
  mark.innerHTML = NOTICE_ICON;

  const text = document.createElement('p');
  text.className = 'teams-notice-text';

  const lead = document.createElement('strong');
  lead.textContent = 'The new teams are out.';

  // The word wears the button's own colour, a reference recognised at a glance.
  const checkRef = document.createElement('span');
  checkRef.className = 'teams-notice-ref';
  checkRef.textContent = 'Check';

  // The shield inline in the sentence, so "open the shield" needs no hunting.
  const shieldRef = document.createElement('span');
  shieldRef.className = 'teams-notice-ref teams-notice-ref--icon';
  // 15, not 13: the shield is drawn in a 24-wide viewBox and the info mark inside
  // it is 3.2 by 8 units, so the mark lands on whole pixels only when 24 scales
  // by a multiple of .625, which in this range is exactly 15. At 13 the mark is
  // 1.73px wide and antialiases into a smudge.
  shieldRef.innerHTML = serverGuildsShield(15);
  // The word the icon stands for, read out and never seen, because the shield
  // is a noun in the middle of this sentence. serverGuildsShield says why the
  // SVG is aria-hidden rather than labelled.
  const spoken = document.createElement('span');
  spoken.className = 'teams-notice-spoken';
  spoken.textContent = 'guild list shield';
  shieldRef.appendChild(spoken);

  // No explanation of what a relink is: readers in these four days know, and the
  // sentence that teaches it stops the rest being read.
  text.append(
    lead,
    ' Paste your guilds and hit ',
    checkRef,
    ' to see where each one landed — or open the ',
    shieldRef,
    ' beside any NA team for every guild on it.'
  );

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'teams-notice-close';
  close.setAttribute('aria-label', 'Dismiss this notice');
  close.title = 'Dismiss';
  // Two drawn strokes, not the × character: a glyph sits on a baseline inside
  // metrics the font chose and no CSS centres it.
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
  close.addEventListener('click', () => {
    try { localStorage.setItem(TEAMS_NOTICE_KEY, String(windowId)); }
    catch { /* no storage: it comes back on the next load, and that is fine */ }
    teamsNotice.textContent = '';
    teamsNotice.style.display = 'none';
  });

  const inner = document.createElement('div');
  inner.className = 'teams-notice-inner';
  inner.append(mark, text);

  teamsNotice.append(inner, close);
  teamsNotice.dataset.window = String(windowId);
  teamsNotice.style.display = 'block';
}

function hideTeamsNotice() {
  if (teamsNotice.dataset.window) delete teamsNotice.dataset.window;
  teamsNotice.textContent = '';
  teamsNotice.style.display = 'none';
}

// Three things have to agree before anything is drawn: the banner has to be
// in the rebuilding window, the sheet has to say the table has moved, and it
// has to say so about *this* relink.
//
// That last one ends the notice, so nothing has to switch it off: the trigger
// writes once a month, and last month's row is compared against the timer this
// page read itself. Outside the window this returns before asking the sheet
// anything.
function updateTeamsNotice(rebuilding) {
  const windowId = assignNA !== null ? Math.floor(assignNA / 1000) : null;
  if (!rebuilding || windowId === null || teamsNoticeDismissed(windowId)) {
    hideTeamsNotice();
    return;
  }
  // Already up, and nothing in it changes: no fetch and no redraw. The banner is
  // rebuilt every minute, which would take focus off this strip's own button.
  if (teamsNotice.dataset.window === String(windowId)) return;

  // The page's rule - nothing runs with the tab hidden (see schedulePeriodicRefresh
  // and the map poll): the interval would otherwise still ask the sheet every ten minutes. Nothing is lost; coming
  // back runs this within the minute.
  //
  // visibilityState only, not document.hasFocus(), like the map poll: an unfocused
  // window on a second monitor is where somebody parks this page waiting for the
  // teams. Animation can stop when nobody is watching; news cannot.
  if (document.visibilityState === 'hidden') return;

  getRelinkState().then((state) => {
    // The window can close, or the strip be dismissed, while this is in flight:
    // decided again on arrival.
    const stillWanted = state
      && state.window === windowId
      && state.published > 0
      && assignNA !== null && Math.floor(assignNA / 1000) === windowId
      && !teamsNoticeDismissed(windowId);
    if (!stillWanted) {
      hideTeamsNotice();
      return;
    }
    if (teamsNotice.dataset.window === String(windowId)) return;
    teamsNoticeUpAt = Date.now();
    buildTeamsNotice(windowId);
  });
}

function updateRelinkBanner() {
  const now = Date.now();
  const hasRelink = relinkNA !== null || relinkEU !== null;
  const hasLockout = timersLoaded && lockoutTime !== null;
  relinkBanner.textContent = '';
  relinkBanner.classList.remove('is-lockout', 'is-urgent', 'is-relink-week', 'is-rebuild');
  if (!hasRelink && !hasLockout) {
    relinkBanner.style.display = 'none';
    updateTeamsNotice(false);
    return;
  }

  const assignNaLeft = assignNA !== null ? assignNA - now : null;
  const assignEuLeft = assignEU !== null ? assignEU - now : null;
  const lockoutGone = hasLockout && lockoutTime - now <= 0;
  // The stretch between the lockout closing and the teams landing; ArenaNet sets
  // both ends, so its length is not a constant. It ends on NA, the later region,
  // so the bar survives EU's eight-hour head start and is gone the moment NA
  // lands. Reading the future of assignNA also stops a stale timer stranding it.
  const rebuilding = lockoutGone && assignNaLeft !== null && assignNaLeft > 0;
  // Same condition and instant: the notice is born and dies with the bar above it.
  updateTeamsNotice(rebuilding);
  if (rebuilding) {
    buildRebuildBanner(assignNaLeft, assignEuLeft);
    return;
  }

  // The last week of the season. The regions enter it eight hours apart; the bar
  // says Relink only once the later one is in too, since its NA number is NA's own.
  const ahead = [assignNaLeft, assignEuLeft].filter((v) => v !== null && v > 0);
  const relinkWeek = ahead.length > 0 && Math.max(...ahead) <= RELINK_WEEK_MS;

  const inner = document.createElement('div');
  inner.className = 'relink-inner';

  const naUrgent = regionIsUrgent(relinkNA, resetNA, liveNA, now);
  const euUrgent = regionIsUrgent(relinkEU, resetEU, liveEU, now);

  if (hasRelink) {
    const naLeft = relinkNA !== null ? relinkNA - now : null;
    const euLeft = relinkEU !== null ? relinkEU - now : null;
    // Same numbers either way (on the final week the reset and the relink are the
    // same instant); what changes is the name on them.
    const stat = buildRelinkStat(
      relinkWeek ? 'Next Relink' : 'Next Reset',
      buildRelinkValue(naLeft, euLeft, naUrgent, euUrgent,
        regionResetting('NA', now), regionResetting('EU', now)),
      false,
      relinkWeek
        ? 'The last reset of the season. At this one the teams themselves are rebuilt, not just the matchups.'
        : 'When the current matchups end and every tier is redrawn for the week ahead. Weekly - the relink that rebuilds the teams themselves is monthly.'
    );
    if (relinkWeek) {
      stat.classList.add('relink-week');
      stat.querySelector('.relink-stat-title').prepend(swordsIcon());
    }
    inner.appendChild(stat);
  }
  if (hasRelink && hasLockout) {
    const divider = document.createElement('div');
    divider.className = 'relink-divider';
    inner.appendChild(divider);
  }
  // Three days, against the relink's two hours: missing a relink costs a week of
  // not knowing who you fight; missing the lockout can put you on a different
  // team from your guild for a month, with no undo.
  const LOCKOUT_URGENT_MS = 3 * 24 * 60 * 60 * 1000;
  const lockoutLeft = hasLockout ? lockoutTime - now : null;
  const lockoutUrgent = lockoutLeft !== null
    && lockoutLeft > 0 && lockoutLeft <= LOCKOUT_URGENT_MS;

  if (hasLockout) {
    // Once the published timestamp is in the past there is no next value until
    // teams are rebuilt, and the game will not let you change your WvW guild in
    // between: it says it is shut rather than promising it will come back.
    const lockoutValue = lockoutLeft > 0
      ? formatCountdown(lockoutLeft)
      : 'Locked until relink';
    inner.appendChild(buildRelinkStat(
      'Season Lockout',
      lockoutValue,
      true,
      'The last moment to set your WvW guild. After it passes your team for the next month is fixed and cannot be changed.',
      lockoutUrgent
    ));
  }
  const relinkUrgent = naUrgent || euUrgent;

  // The lockout wins, and only one of the two runs: two things pulsing at once read
  // as decoration, and the lockout is the one you can still act on.
  relinkBanner.classList.toggle('is-lockout', lockoutUrgent);
  relinkBanner.classList.toggle('is-urgent', relinkUrgent && !lockoutUrgent);
  // The rule and the mark under Next Relink both scan red to blue to green; two at
  // once read as decoration, so the rule stands down and the mark keeps the colours.
  relinkBanner.classList.toggle('is-relink-week', relinkWeek);

  relinkBanner.style.display = 'block';
  relinkBanner.appendChild(inner);

  // The line only exists while it can be acted on: built from the same condition
  // that lights the stat, and gone with it.
  if (lockoutUrgent) {
    const alert = document.createElement('div');
    alert.className = 'relink-alert';
    alert.innerHTML = WARN_ICON;
    const text = document.createElement('span');
    // Guild or team, not both: a player who has set a WvW guild cannot pick a team,
    // and "guild or server" would send half the readers to a button they do not have.
    text.textContent = 'Set your WvW guild before the lockout - or pick a team if you have none. '
      + 'After it, your team is fixed for the month.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  } else if (relinkUrgent) {
    // Two hours out: a heads-up to get set. Same slot and shape as the lockout's
    // line, in the relink's colour; only one of the two is ever on the bar.
    const alert = document.createElement('div');
    alert.className = 'relink-alert relink-alert--relink';
    alert.appendChild(swordsIcon());
    // Named rather than pointed at: a glyph beside one of two numbers has to be interpreted; the word is read.
    const where = [];
    if (naUrgent) where.push('NA');
    if (euUrgent) where.push('EU');
    if (railFirst() === 'eu') where.reverse();
    const text = document.createElement('span');
    text.textContent = `${where.join(' and ')} reset night. `
      + 'Big fight, and the queue that comes with it.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  } else if (relinkWeek) {
    // Last of the three: it says the season itself is ending, and deliberately
    // carries no instruction (that is the lockout's line).
    const alert = document.createElement('div');
    alert.className = 'relink-alert relink-alert--relink';
    alert.appendChild(swordsIcon());
    const text = document.createElement('span');
    text.textContent = 'Last week of the season. New teams at the next reset.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  }
}
