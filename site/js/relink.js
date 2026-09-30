'use strict';
// ---------------------------------------------------------------------
// Relink and season timers
// The countdown to the next relink and the season lockout, plus the
// banner they feed.
// ---------------------------------------------------------------------

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

// Feather's alert-triangle, at the weight the other glyphs on the page
// are drawn. Used in two places - the stat's own label and the line
// underneath - so it lives here rather than being typed twice.
const WARN_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
  '<path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

function buildRelinkStat(title, value, isPrimary, tooltip, warn) {
  const stat = document.createElement('div');
  stat.className = isPrimary ? 'relink-stat relink-stat--primary' : 'relink-stat';
  if (tooltip) stat.title = tooltip;
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

// Inside the last two hours the banner starts breathing, so the tab
// catches your eye from across the desk on reset night.
const RELINK_URGENT_MS = 2 * 60 * 60 * 1000;
// How long after a week is published before its maps are up and you can
// get on one. Measured across nine matches in both regions and every one
// opened at start_time plus 3m37s to 3m47s, so five minutes covers it
// with room. The line dies with it: "get in early" is no use once the
// doors are open and the queue is the queue.
const RELINK_OPENING_MS = 5 * 60 * 1000;
// Only reached when nothing has been published anywhere. A tier normally
// turns up within minutes, so this is the fuse for an API that has
// stopped answering, not a window anyone is meant to see the end of.
const RELINK_STUCK_MS = 30 * 60 * 1000;
// The final week of the season, after which the countdown stops being
// about a reset and starts being about the relink. It is not an
// estimate: teamAssignment minus seven days lands on the previous reset
// to the minute, so the window is exactly "this is the last week".
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

// The game's own crossed swords - the icon WvW already puts on a fight
// in progress, so it needs no learning. Deliberately not the lockout's
// warning triangle: a relink is an event you turn up for, not a deadline
// you can miss. The file is a flat alpha silhouette, which is why it is
// a mask over currentColor and not an <img>: one asset, tinted by
// whatever state it lands in.
function swordsIcon() {
  const s = document.createElement('span');
  s.className = 'swords-icon';
  return s;
}

// Dims the region labels (NA/EU) and emphasizes the countdown values,
// since the time is what the person actually came to read.
function buildRelinkValue(naMs, euMs, naNow, euNow) {
  const frag = document.createDocumentFragment();
  const naRegion = document.createElement('span');
  naRegion.className = naNow ? 'region is-now' : 'region';
  naRegion.textContent = 'NA ';
  const naTime = document.createElement('span');
  naTime.className = naNow ? 'time is-now' : 'time';
  naTime.textContent = formatCountdown(naMs);
  // The dot is its own element so that it never lights: folded into
  // ' . EU ' as it used to be, the separator would carry EU's is-now and
  // brighten along with the region it does not belong to.
  const sep = document.createElement('span');
  sep.className = 'region';
  sep.textContent = ' · ';
  const euRegion = document.createElement('span');
  euRegion.className = euNow ? 'region is-now' : 'region';
  euRegion.textContent = 'EU ';
  const euTime = document.createElement('span');
  euTime.className = euNow ? 'time is-now' : 'time';
  euTime.textContent = formatCountdown(euMs);
  if (railFirst() === 'eu') frag.append(euRegion, euTime, sep, naRegion, naTime);
  else frag.append(naRegion, naTime, sep, euRegion, euTime);
  return frag;
}

// Module-level so fetchTimers() and updateRelinkBanner() can run on
// independent schedules and both read the latest values.
let lockoutTime = null;
let timersLoaded = false;
// The first drawing has to be the right one. The matches alone can only
// draw the weekly countdown, and during a relink window the timers then
// turned it into the relink's own, taller bar: on reload the small one
// showed first and the page jumped. So nothing is drawn until the timers
// have answered or failed - or three seconds have gone, so a hung
// request cannot keep the bar away.
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
    lockoutTime = lockout?.na
      ? new Date(lockout.na).getTime()
      : (lockout?.eu ? new Date(lockout.eu).getTime() : null);
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

// The latest of a field across a region's matches. Reading one match -
// naMatches[0], which is tier 1 - is a coin toss for as long as a relink
// takes: on 26/09 tier 4 had been running the new week for forty minutes
// while tiers 1 and 3 were still serving the old one, and tier 2
// published the new week and then went back. Whichever tier is furthest
// ahead is the one that has seen the relink.
function latestOf(matches, field) {
  const times = (matches || [])
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

// The relink's own value line. Same shape as the weekly one, with one
// difference: a region that has already relinked shows that it is done
// rather than a countdown, because 'any moment now' would be a lie for
// the eight hours EU spends waiting for NA.
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

// The relink's bar. One stat and no divider: the lockout has nothing
// left to say by now, and the reset it used to sit beside is the same
// instant this is counting to.
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

  const alert = document.createElement('div');
  alert.className = 'relink-alert';
  alert.appendChild(swordsIcon());
  const line = document.createElement('span');
  // Nothing here asks for an action, because by now there is none to
  // take - the lockout closed days ago. It announces.
  line.textContent = 'New link, new enemies, and a month of good fights ahead.';
  alert.appendChild(line);
  relinkBanner.appendChild(alert);
}

// ---------------------------------------------------------------------
// The teams notice
// For the days between ArenaNet publishing the new assignment and the
// relink landing, when the answer is already there to be looked up and
// nothing says so. The finding is counted by this project's Apps Script
// trigger and read from the sheet; see RELINK_SHEET_URL in config.js for
// why the counting cannot happen here.
// ---------------------------------------------------------------------

// One cell, holding "window:published" as text. Two number cells would
// come back through the CSV export in whatever format the sheet happens
// to be using, and a thousands separator is a comma inside a
// comma-separated file. Nothing but two integers is ever accepted: the
// sheet is world-readable and this is the one value on the page that
// decides what the page claims, so it is parsed strictly rather than
// trustingly.
const RELINK_STATE_RE = /^"?(\d{1,12}):(\d{1,12})"?$/;

let relinkState = null;        // { window, published }
let relinkStateAt = 0;
let relinkStateInFlight = null;
let relinkStateFailedAt = 0;

// After a failed read, wait before asking again. Without this the banner's
// one-minute tick would retry every minute for the four days the window is
// open, in every tab anyone left open - and the case that makes it fail is
// usually a misconfiguration that will not fix itself, so it would fail
// every time. Short enough that a blip costs the notice minutes, not the
// window.
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
      // On doubt, nothing. The notice stays down and the next attempt is a
      // couple of minutes away; a strip that appears because a read went
      // wrong would send people to the old answer, which is the one thing
      // it must not do.
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
  // The same deadline every other request on this page gets. Without it
  // a connection that accepts and goes quiet would leave this pending
  // for good, and relinkStateInFlight hands that promise to every later
  // caller - so the notice would never resolve for the whole session.
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

// Dismissal is remembered as the window it was dismissed in, not as a
// flag. The window is up to four days long and a regular visitor would
// otherwise meet the same strip every time, but next month's window has
// a different id and brings it back on its own - which is the behaviour
// wanted in both directions, out of one string and no expiry logic.
const TEAMS_NOTICE_KEY = 'wvw-relink-checker:teams-notice';

function teamsNoticeDismissed(windowId) {
  try { return localStorage.getItem(TEAMS_NOTICE_KEY) === String(windowId); }
  catch { return false; } // storage off: it shows, which is the harmless way to be wrong
}

// Feather's bell, at the weight the other glyphs on the page are drawn.
// The mark that opens the strip has to say "this is a notice" before a
// word of it is read, and the page's other two candidates are both
// already spoken for: the alert triangle belongs to the lockout, and the
// shield means "there is a guild list behind this" - which is why the
// shield appears in the middle of the sentence instead, where it is
// pointing at the thing it has always pointed at.
const NOTICE_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
  'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

// The page's own name for its two answers, written the way they appear
// on it. A strip that says "check the sheet" sends people off the site to
// do by hand the thing the site exists to do; a strip that grows its own
// button puts a rival beside the one verb the page has. So neither: the
// sentence points at what is already here and already working, and the
// marks it points with are the marks themselves.
function buildTeamsNotice(windowId) {
  teamsNotice.textContent = '';

  const mark = document.createElement('span');
  mark.className = 'teams-notice-mark';
  mark.innerHTML = NOTICE_ICON;

  const text = document.createElement('p');
  text.className = 'teams-notice-text';

  const lead = document.createElement('strong');
  lead.textContent = 'The new teams are out.';

  // Named, and drawn the way it is drawn. "Hit Check" is a reference
  // someone has to go and find; the word wearing the button's own colour
  // is a reference they recognise on the way past.
  const checkRef = document.createElement('span');
  checkRef.className = 'teams-notice-ref';
  checkRef.textContent = 'Check';

  // The shield inline in the sentence, so "open the shield" is not an
  // instruction to go hunting for something described in words.
  const shieldRef = document.createElement('span');
  shieldRef.className = 'teams-notice-ref teams-notice-ref--icon';
  // 15, not 13, and the reason is arithmetic rather than taste. The shield
  // is drawn in a 24-wide viewBox and the info mark inside it is 3.2 by 8
  // units, so the mark lands on whole pixels only when 24 scales by a
  // multiple of .625 - which in this range means a width of exactly 15. At
  // 13 the mark is 1.73px wide and antialiases into a smudge, and a smudge
  // is what it looked like.
  shieldRef.innerHTML = serverGuildsShield(15);
  // The word the icon stands for, read out and never seen, because the shield
  // is a noun in the middle of this sentence. serverGuildsShield says why the
  // SVG is aria-hidden rather than labelled.
  const spoken = document.createElement('span');
  spoken.className = 'teams-notice-spoken';
  spoken.textContent = 'guild list shield';
  shieldRef.appendChild(spoken);

  // No explanation of what a relink is: anyone reading this page in
  // these four days knows, and the sentence that teaches them is the
  // sentence that stops the rest being read.
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
  // Two drawn strokes, not the × character. A glyph cannot be centred in
  // a box by any amount of CSS - it sits on a baseline inside metrics the
  // font chose, and ×, ✕ and the multiplication sign each sit at a
  // different height in a different face. Drawn, the cross is centred
  // because its own coordinates say so.
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
// That last one is what ends the notice, and why nothing ever has to come back
// and switch it off - the trigger writes once a month, and next month last
// month's row is still sitting there to be compared against the timer this
// page read itself. Outside the window this returns before asking the sheet
// anything, which keeps twenty-six days a month free of a request that could
// only ever answer "no".
function updateTeamsNotice(rebuilding) {
  const windowId = assignNA !== null ? Math.floor(assignNA / 1000) : null;
  if (!rebuilding || windowId === null || teamsNoticeDismissed(windowId)) {
    hideTeamsNotice();
    return;
  }
  // Already up, and nothing in it changes - so no fetch and no redraw. The
  // banner is rebuilt every minute; taking the focus off this strip's own
  // button once a minute for four days would not be.
  if (teamsNotice.dataset.window === String(windowId)) return;

  // The rule the rest of the page already follows - see the visibility test in
  // schedulePeriodicRefresh and the one in the map poll. It matters here
  // because the interval driving this was left ungated while it only ticked
  // text: hidden, it would still ask the sheet every ten minutes for as long
  // as the tab stayed open. Nothing is lost, since coming back runs this
  // within the minute.
  //
  // visibilityState only, and deliberately not document.hasFocus(), like the
  // map poll: an unfocused window on a second monitor is exactly where
  // somebody parks this page waiting for the teams. Animation can stop when
  // nobody is watching; news cannot.
  if (document.visibilityState === 'hidden') return;

  getRelinkState().then((state) => {
    // The window can close, or the strip be dismissed, while this is in
    // flight - so the decision is made again on arrival rather than
    // assumed from when it was asked.
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
  // The stretch between the lockout closing and the teams landing - 3d18h in
  // the window measured off the API timers on 28/09/2026, and ArenaNet sets
  // both ends, so the figure is not a constant. It ends on NA, the later of
  // the two regions, so the bar survives EU's eight-hour head start and is
  // gone the moment NA lands. Reading the future of assignNA is also what
  // stops a stale timer stranding it here.
  const rebuilding = lockoutGone && assignNaLeft !== null && assignNaLeft > 0;
  // Same condition and the same instant: the notice is born and dies with the
  // bar above it rather than deciding its own life.
  updateTeamsNotice(rebuilding);
  if (rebuilding) {
    buildRebuildBanner(assignNaLeft, assignEuLeft);
    return;
  }

  // The last week of the season. Both regions enter it eight hours
  // apart, so the earlier one opens the window for the whole bar - it
  // is the same week either way.
  const ahead = [assignNaLeft, assignEuLeft].filter((v) => v !== null && v > 0);
  const relinkWeek = ahead.length > 0 && Math.min(...ahead) <= RELINK_WEEK_MS;

  const inner = document.createElement('div');
  inner.className = 'relink-inner';

  const naUrgent = regionIsUrgent(relinkNA, resetNA, liveNA, now);
  const euUrgent = regionIsUrgent(relinkEU, resetEU, liveEU, now);

  if (hasRelink) {
    const naLeft = relinkNA !== null ? relinkNA - now : null;
    const euLeft = relinkEU !== null ? relinkEU - now : null;
    // Same numbers either way - on the final week the reset and the
    // relink are the same instant - so what changes is the name on
    // them, which is the whole point of the state.
    const stat = buildRelinkStat(
      relinkWeek ? 'Next Relink' : 'Next Reset',
      buildRelinkValue(naLeft, euLeft, naUrgent, euUrgent),
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
  // Three days, against the relink's two hours, and the gap between
  // those two numbers is the whole point. Missing a relink costs you a
  // week of not knowing who you fight; missing the lockout can put you
  // on a different team from your guild for a month, and there is no
  // way to undo it once it passes.
  const LOCKOUT_URGENT_MS = 3 * 24 * 60 * 60 * 1000;
  const lockoutLeft = hasLockout ? lockoutTime - now : null;
  const lockoutUrgent = lockoutLeft !== null
    && lockoutLeft > 0 && lockoutLeft <= LOCKOUT_URGENT_MS;

  if (hasLockout) {
    // Once the published timestamp is in the past there is no next value
    // until teams are rebuilt, several days later, and in that window the
    // game will not let you change your WvW guild at all. So it says it is
    // shut rather than promising it will come back.
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

  // The lockout wins, and only one of the two ever runs: two things
  // pulsing at once reads as decoration instead of as an alarm, and of
  // the two the lockout is the one you can still act on. The relink
  // stands down; its number is still on the bar, just not shouting.
  relinkBanner.classList.toggle('is-lockout', lockoutUrgent);
  relinkBanner.classList.toggle('is-urgent', relinkUrgent && !lockoutUrgent);
  // The rule scans red to blue to green and so does the mark under Next
  // Relink; two of them at once read as decoration rather than as one
  // signal, so the rule stands down and the mark keeps the colours.
  relinkBanner.classList.toggle('is-relink-week', relinkWeek);

  relinkBanner.style.display = 'block';
  relinkBanner.appendChild(inner);

  // The line only exists while it can still be acted on. A banner that
  // tells you to do something you can no longer do is worse than no
  // banner, so this is built from the same condition that lights the
  // stat and disappears with it.
  if (lockoutUrgent) {
    const alert = document.createElement('div');
    alert.className = 'relink-alert';
    alert.innerHTML = WARN_ICON;
    const text = document.createElement('span');
    // Guild or team, not both: a player who has set a WvW guild cannot
    // pick a team, and one who has not is the only one who can. Saying
    // "guild or server" as though they were two options you choose
    // between would send half the readers to a button they do not have.
    text.textContent = 'Set your WvW guild before the lockout - or pick a team if you have none. '
      + 'After it, your team is fixed for the month.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  } else if (relinkUrgent) {
    // Two hours out, so this is a heads-up to get set rather than a
    // report of something already under way. Same slot and same shape as
    // the lockout's line, in the relink's own colour - only one of the
    // two is ever on the bar.
    const alert = document.createElement('div');
    alert.className = 'relink-alert relink-alert--relink';
    alert.appendChild(swordsIcon());
    // Named rather than pointed at. A glyph beside one of two numbers
    // has to be noticed and then interpreted; the word is read.
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
    // Last of the three, and it says the one thing the other two do not:
    // that the season itself is ending. It deliberately carries no
    // instruction - going to set your guild is the lockout's line, and
    // saying it twice would leave neither being read.
    const alert = document.createElement('div');
    alert.className = 'relink-alert relink-alert--relink';
    alert.appendChild(swordsIcon());
    const text = document.createElement('span');
    text.textContent = 'Last week of the season. New teams at the next reset.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  }
}
