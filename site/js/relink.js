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

const RELINK_URGENT_MS = 2 * 60 * 60 * 1000;
// Time for a new week's maps to open after start_time; the opening line ends with it.
const RELINK_OPENING_MS = 5 * 60 * 1000;
// The fuse for an API that has stopped answering.
const RELINK_STUCK_MS = 30 * 60 * 1000;
// teamAssignment minus this is the previous reset, to the minute.
const RELINK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Urgent when the countdown is inside two hours, while every tier is still on the
// week that just ended, or while the new week's maps are not up: the bar must not
// blink out mid-reset. Asked per region.
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

// A mask over currentColor, not an <img>: the file is a flat alpha silhouette.
function swordsIcon() {
  const s = document.createElement('span');
  s.className = 'swords-icon';
  return s;
}

function buildRelinkValue(naMs, euMs, naNow, euNow, naResetting, euResetting) {
  const frag = document.createDocumentFragment();
  const naRegion = document.createElement('span');
  naRegion.className = naNow ? 'region is-now' : 'region';
  naRegion.textContent = 'NA ';
  const naTime = document.createElement('span');
  naTime.className = naNow ? 'time is-now' : 'time';
  naTime.textContent = countdownText(naMs, naResetting);
  // Its own element, so it never takes EU's is-now.
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

let lockoutTime = null;
let timersLoaded = false;
// Nothing is drawn until the timers answer or fail, or three seconds pass: the
// weekly bar alone would jump to the relink's taller one.
let bannerMayDraw = false;
setTimeout(() => {
  if (!bannerMayDraw) { bannerMayDraw = true; updateRelinkBanner(); }
}, 3000);

let relinkNA = null;
let relinkEU = null;
let resetNA = null;
let resetEU = null;
let liveNA = false;
let liveEU = false;

// The relink proper (teams rebuilt), separate from the weekly reset; NA and EU differ.
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
    // One timestamp is kept for both regions.
    lockoutTime = msOrNull(lockout?.na) ?? msOrNull(lockout?.eu);
    timersLoaded = true;
  } catch {
    // Keep showing the last known value; the banner just skips this cycle.
  }
  // Its own try: one endpoint failing must not cost the other its figures.
  try {
    const raw = await fetchJson(`${API_BASE}/wvw/timers/teamAssignment`);
    const at = Array.isArray(raw) ? raw[0] : raw;
    assignNA = msOrNull(at?.na);
    assignEU = msOrNull(at?.eu);
  } catch {
    // The last figures stand.
  }
  bannerMayDraw = true;
  updateRelinkBanner();
}

// Tiers publish the new week one at a time, so the one furthest ahead has seen the relink.
function latestOf(matches, field) {
  const times = matches
    .map((m) => Date.parse(m && m[field]))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// start_time of the newest week says its maps are about to open; end_time cannot.
// A failed region arrives as null and keeps its figures: an empty list would take
// down its half of the banner.
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

// Pins the green layer (.relink-inner::before, rebuilt every minute) to the red's
// clock so the three stay in step. currentTime, not startTime: the embers' clock
// pauses the looping animations (js/boot.js), which then have no startTime.
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

// A region that has already relinked shows 'done', not 'any moment now'.
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
  line.textContent = 'New link, new enemies, and a month of good fights ahead.';
  alert.appendChild(line);
  relinkBanner.appendChild(alert);
}

// ---- The teams notice -------------------------------------------------
// The Apps Script trigger counts the finding and the page reads it from the sheet
// (RELINK_SHEET_URL in config.js).

// One text cell, "window:published": number cells would come back through the CSV
// export formatted. Only two integers are accepted; the sheet is world-readable.
const RELINK_STATE_RE = /^"?(\d{1,12}):(\d{1,12})"?$/;

let relinkState = null;        // { window, published }
// When the notice last went up; the guild-to-team table kept from before is the
// old month's (getWvwMaps).
let teamsNoticeUpAt = 0;
let relinkStateAt = 0;
let relinkStateInFlight = null;
let relinkStateFailedAt = 0;

// After a failed read, wait before asking again, or the one-minute tick retries
// for the whole window.
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
      // On doubt, no strip.
      relinkStateFailedAt = Date.now();
    } finally {
      relinkStateInFlight = null;
    }
    return relinkState;
  })();
  return relinkStateInFlight;
}

// Held to the sheet's standard: anything but two whole numbers fails and falls back to the sheet.
// 1e12 is the 12 digits RELINK_STATE_RE allows.
async function readOwnRelink() {
  const d = await fetchOwnApi(OWN_RELINK_URL);
  const ok = (n) => Number.isSafeInteger(n) && n >= 0 && n < 1e12;
  if (!d || !ok(d.window) || !ok(d.published)) throw new Error('not two integers');
  return { window: d.window, published: d.published };
}

async function readRelinkSheet() {
  // The same deadline as every request: relinkStateInFlight hands this promise to every later caller.
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

// Dismissal is stored as the window id, so next month's window brings the strip back.
const TEAMS_NOTICE_KEY = 'wvw-relink-checker:teams-notice';

function teamsNoticeDismissed(windowId) {
  try { return localStorage.getItem(TEAMS_NOTICE_KEY) === String(windowId); }
  catch { return false; } // storage off: it shows, which is the harmless way to be wrong
}

const NOTICE_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
  'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

function buildTeamsNotice(windowId) {
  teamsNotice.textContent = '';

  const mark = document.createElement('span');
  mark.className = 'teams-notice-mark';
  mark.innerHTML = NOTICE_ICON;

  const text = document.createElement('p');
  text.className = 'teams-notice-text';

  const lead = document.createElement('strong');
  lead.textContent = 'The new teams are out.';

  const checkRef = document.createElement('span');
  checkRef.className = 'teams-notice-ref';
  checkRef.textContent = 'Check';

  const shieldRef = document.createElement('span');
  shieldRef.className = 'teams-notice-ref teams-notice-ref--icon';
  // 15: the shield's info mark (3.2 by 8 units in a 24 viewBox) lands on whole
  // pixels only at multiples of a .625 scale.
  shieldRef.innerHTML = serverGuildsShield(15);
  // Read out, never seen; serverGuildsShield says why the SVG is aria-hidden.
  const spoken = document.createElement('span');
  spoken.className = 'teams-notice-spoken';
  spoken.textContent = 'guild list shield';
  shieldRef.appendChild(spoken);

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
  // Two drawn strokes, not ×: no CSS centres a glyph inside the font's metrics.
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

// Drawn only while the banner is rebuilding and the sheet says the table moved
// for *this* relink; last month's row fails that comparison, so nothing switches it off.
function updateTeamsNotice(rebuilding) {
  const windowId = assignNA !== null ? Math.floor(assignNA / 1000) : null;
  if (!rebuilding || windowId === null || teamsNoticeDismissed(windowId)) {
    hideTeamsNotice();
    return;
  }
  // Already up: no fetch or redraw, which would take focus off the strip's button.
  if (teamsNotice.dataset.window === String(windowId)) return;

  // Nothing runs with the tab hidden (see schedulePeriodicRefresh and the map poll).
  // visibilityState only, not document.hasFocus(), like the map poll.
  if (document.visibilityState === 'hidden') return;

  getRelinkState().then((state) => {
    // Decided again on arrival: the window may close or the strip be dismissed meanwhile.
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
  // From the lockout closing until NA's teams land; ends on NA, the later region.
  // Reading the future of assignNA stops a stale timer stranding it.
  const rebuilding = lockoutGone && assignNaLeft !== null && assignNaLeft > 0;
  updateTeamsNotice(rebuilding);
  if (rebuilding) {
    buildRebuildBanner(assignNaLeft, assignEuLeft);
    return;
  }

  // The last week of the season: the bar says Relink only once both regions are in it.
  const ahead = [assignNaLeft, assignEuLeft].filter((v) => v !== null && v > 0);
  const relinkWeek = ahead.length > 0 && Math.max(...ahead) <= RELINK_WEEK_MS;

  const inner = document.createElement('div');
  inner.className = 'relink-inner';

  const naUrgent = regionIsUrgent(relinkNA, resetNA, liveNA, now);
  const euUrgent = regionIsUrgent(relinkEU, resetEU, liveEU, now);

  if (hasRelink) {
    const naLeft = relinkNA !== null ? relinkNA - now : null;
    const euLeft = relinkEU !== null ? relinkEU - now : null;
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
  const LOCKOUT_URGENT_MS = 3 * 24 * 60 * 60 * 1000;
  const lockoutLeft = hasLockout ? lockoutTime - now : null;
  const lockoutUrgent = lockoutLeft !== null
    && lockoutLeft > 0 && lockoutLeft <= LOCKOUT_URGENT_MS;

  if (hasLockout) {
    // With the timestamp in the past there is no next value until teams are rebuilt.
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

  // Only one of the two pulses; the lockout wins.
  relinkBanner.classList.toggle('is-lockout', lockoutUrgent);
  relinkBanner.classList.toggle('is-urgent', relinkUrgent && !lockoutUrgent);
  // The header rule's scan stands down (css/layout.css); the mark under Next Relink keeps the colours.
  relinkBanner.classList.toggle('is-relink-week', relinkWeek);

  relinkBanner.style.display = 'block';
  relinkBanner.appendChild(inner);

  if (lockoutUrgent) {
    const alert = document.createElement('div');
    alert.className = 'relink-alert';
    alert.innerHTML = WARN_ICON;
    const text = document.createElement('span');
    // Guild or team, not both: a player with a WvW guild cannot pick a team.
    text.textContent = 'Set your WvW guild before the lockout - or pick a team if you have none. '
      + 'After it, your team is fixed for the month.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  } else if (relinkUrgent) {
    const alert = document.createElement('div');
    alert.className = 'relink-alert relink-alert--relink';
    alert.appendChild(swordsIcon());
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
    // No instruction here; that is the lockout's line.
    const alert = document.createElement('div');
    alert.className = 'relink-alert relink-alert--relink';
    alert.appendChild(swordsIcon());
    const text = document.createElement('span');
    text.textContent = 'Last week of the season. New teams at the next reset.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  }
}
