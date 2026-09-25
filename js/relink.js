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

// Dims the region labels (NA/EU) and emphasizes the countdown values,
// since the time is what the person actually came to read.
function buildRelinkValue(naMs, euMs) {
  const frag = document.createDocumentFragment();
  const naRegion = document.createElement('span');
  naRegion.className = 'region';
  naRegion.textContent = 'NA ';
  const naTime = document.createElement('span');
  naTime.className = 'time';
  naTime.textContent = formatCountdown(naMs);
  const euRegion = document.createElement('span');
  euRegion.className = 'region';
  euRegion.textContent = ' · EU ';
  const euTime = document.createElement('span');
  euTime.className = 'time';
  euTime.textContent = formatCountdown(euMs);
  frag.append(naRegion, naTime, euRegion, euTime);
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
function updateRelinkFromMatches(naMatches, euMatches) {
  relinkNA = naMatches?.[0]?.end_time ? new Date(naMatches[0].end_time).getTime() : null;
  relinkEU = euMatches?.[0]?.end_time ? new Date(euMatches[0].end_time).getTime() : null;
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

  if (hasRelink) {
    const naLeft = relinkNA !== null ? relinkNA - now : null;
    const euLeft = relinkEU !== null ? relinkEU - now : null;
    inner.appendChild(buildRelinkStat(
      'Next Relink',
      buildRelinkValue(naLeft, euLeft),
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
  // Inside the last two hours the banner starts breathing, so the tab
  // catches your eye from across the desk on reset night.
  const URGENT_MS = 2 * 60 * 60 * 1000;
  const remaining = [relinkNA, relinkEU]
    .filter((t) => t !== null)
    .map((t) => t - now)
    .filter((left) => left > 0);
  const relinkUrgent = remaining.length > 0
    && Math.min(...remaining) <= URGENT_MS;

  // The lockout wins, and only one of the two ever runs. A three-day
  // window contains a weekly reset about two cycles out of five, so the
  // overlap is normal rather than freak - and two things pulsing at
  // once reads as decoration instead of as an alarm. The relink stands
  // down; its number is still on the bar, just not shouting.
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
  }
}
