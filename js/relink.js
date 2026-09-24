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

function buildRelinkStat(title, value, isPrimary, tooltip) {
  const stat = document.createElement('div');
  stat.className = isPrimary ? 'relink-stat relink-stat--primary' : 'relink-stat';
  if (tooltip) stat.title = tooltip;
  const titleEl = document.createElement('div');
  titleEl.className = 'relink-stat-title';
  titleEl.textContent = title;
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
  if (hasLockout) {
    // Primary stat: larger, accent-colored text. Once the published
    // timestamp is in the past, there's no next value until the next
    // relink, so show a static message instead of a stuck countdown.
    const lockoutValue = lockoutTime - now > 0
      ? formatCountdown(lockoutTime - now)
      : 'resumes after next relink';
    inner.appendChild(buildRelinkStat(
      'Season Lockout',
      lockoutValue,
      true,
      'Deadline for the current WvW season, after which team assignments can change.'
    ));
  }
  // Inside the last six hours the banner starts breathing, so the tab
  // catches your eye from across the desk on reset night.
  const URGENT_MS = 6 * 60 * 60 * 1000;
  const remaining = [relinkNA, relinkEU]
    .filter((t) => t !== null)
    .map((t) => t - now)
    .filter((left) => left > 0);
  relinkBanner.classList.toggle('is-urgent',
    remaining.length > 0 && Math.min(...remaining) <= URGENT_MS);

  relinkBanner.style.display = 'block';
  relinkBanner.appendChild(inner);
}

// Fetches the lockout timer once; fetchTimers() renders the banner itself once
async function loadTimers() {
  await fetchTimers();
}
