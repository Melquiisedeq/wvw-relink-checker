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
// get on one. Measured across nine matches in both regions - EU mid-week,
// NA at a fresh reset and NA a full week old - and every one opened at
// start_time plus 3m37s to 3m47s. Five minutes covers that with room,
// and the line dies with it: "get in early" is no use once the doors
// are open and the queue is the queue.
const RELINK_OPENING_MS = 5 * 60 * 1000;
// Only reached when nothing has been published anywhere. A tier normally
// turns up within minutes, so this is the fuse for an API that has
// stopped answering, not a window anyone is meant to see the end of.
const RELINK_STUCK_MS = 30 * 60 * 1000;

// Whether a region's relink is close enough to shout about. Three ways
// in, handing over to each other so the bar never blinks out in the
// middle of a reset:
//
//   before   the countdown is inside two hours
//   during   every tier is still on the week that just ended, so the
//            new one has not been published anywhere yet
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

// Crossed swords, at the weight the other glyphs on the page are drawn.
// Deliberately not the lockout's warning triangle: a relink is an event
// you turn up for, not a deadline you can miss, and giving both the same
// glyph would leave hue as the only thing telling them apart.
const SWORDS_ICON =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4.5 19.5 L19 5"/><path d="M19.5 19.5 L5 5"/>' +
  '<path d="M5.5 15.5 L8.5 18.5"/><path d="M18.5 15.5 L15.5 18.5"/></svg>';

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
  frag.append(naRegion, naTime, sep, euRegion, euTime);
  return frag;
}

// Module-level so fetchTimers() and updateRelinkBanner() can run on
// independent schedules and both read the latest values.
let lockoutTime = null;
let timersLoaded = false;

// Weekly relink: when tier matchups end and everyone is shuffled into
// new pairings. Read straight from the match data's own end_time, so
// no separate request; refreshes on the same cadence as standings.
let relinkNA = null;
let relinkEU = null;
let resetNA = null;
let resetEU = null;
let liveNA = false;
let liveEU = false;

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
  updateRelinkBanner();
}

// Reads each region's weekly matchup end_time straight off the match
// objects already loaded for the standings rails.
// The latest of a field across a region's matches. Reading one match -
// naMatches[0], which is tier 1 - is a coin toss for as long as a relink
// takes: on 26/09 tier 4 had been running the new week for forty minutes
// while tiers 1 and 3 were still serving the old one, and tier 2
// published the new week and then went back to the old. Whichever tier
// is furthest ahead is the one that has seen the relink.
function latestOf(matches, field) {
  const times = (matches || [])
    .map((m) => Date.parse(m && m[field]))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

function updateRelinkFromMatches(naMatches, euMatches) {
  relinkNA = latestOf(naMatches, 'end_time');
  relinkEU = latestOf(euMatches, 'end_time');
  // The far side of the same event: when the newest published week
  // began. It is what says the maps are about to open, which end_time
  // cannot - by then end_time is a week away again.
  resetNA = latestOf(naMatches, 'start_time');
  resetEU = latestOf(euMatches, 'start_time');
  // One tier still running the week it published is enough to know the
  // new data exists somewhere.
  liveNA = (naMatches || []).some(matchIsLive);
  liveEU = (euMatches || []).some(matchIsLive);
  updateRelinkBanner();
}

function updateRelinkBanner() {
  const now = Date.now();
  const hasRelink = relinkNA !== null || relinkEU !== null;
  const hasLockout = timersLoaded && lockoutTime !== null;
  relinkBanner.textContent = '';
  if (!hasRelink && !hasLockout) {
    relinkBanner.style.display = 'none';
    return;
  }

  const inner = document.createElement('div');
  inner.className = 'relink-inner';

  const naUrgent = regionIsUrgent(relinkNA, resetNA, liveNA, now);
  const euUrgent = regionIsUrgent(relinkEU, resetEU, liveEU, now);

  if (hasRelink) {
    const naLeft = relinkNA !== null ? relinkNA - now : null;
    const euLeft = relinkEU !== null ? relinkEU - now : null;
    inner.appendChild(buildRelinkStat(
      'Next Relink',
      buildRelinkValue(naLeft, euLeft, naUrgent, euUrgent),
      false,
      'When the current tier matchups end and everyone is shuffled into new pairings for the week.'
    ));
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
  // the two the lockout is the one you can still act on. How often the
  // windows overlap is not measured - the arithmetic for a randomly
  // placed three-day window would say two weeks in five, but the
  // lockout is scheduled rather than random, and has been landing after
  // the NA relink rather than across it. The relink stands down; its
  // number is still on the bar, just not shouting.
  relinkBanner.classList.toggle('is-lockout', lockoutUrgent);
  relinkBanner.classList.toggle('is-urgent', relinkUrgent && !lockoutUrgent);

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
    alert.innerHTML = SWORDS_ICON;
    // Named rather than pointed at. A glyph beside one of two numbers
    // has to be noticed and then interpreted; the word is read.
    const where = [];
    if (naUrgent) where.push('NA');
    if (euUrgent) where.push('EU');
    const text = document.createElement('span');
    text.textContent = `${where.join(' and ')} reset night. `
      + 'Big fight, and the queue that comes with it.';
    alert.appendChild(text);
    relinkBanner.appendChild(alert);
  }
}
