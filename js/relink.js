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
  updateRelinkBanner();
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
  frag.append(...half('NA', naLeft), sep, ...half('EU', euLeft));
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

function updateRelinkBanner() {
  const now = Date.now();
  const hasRelink = relinkNA !== null || relinkEU !== null;
  const hasLockout = timersLoaded && lockoutTime !== null;
  relinkBanner.textContent = '';
  relinkBanner.classList.remove('is-lockout', 'is-urgent', 'is-rebuild');
  if (!hasRelink && !hasLockout) {
    relinkBanner.style.display = 'none';
    return;
  }

  const assignNaLeft = assignNA !== null ? assignNA - now : null;
  const assignEuLeft = assignEU !== null ? assignEU - now : null;
  const lockoutGone = hasLockout && lockoutTime - now <= 0;
  // The three days between the lockout closing and the teams landing.
  // It ends on NA, the later region, so the bar survives EU's eight-hour
  // head start - and the moment NA lands it is gone. Reading the future
  // of assignNA is also what stops a stale timer stranding it here.
  const rebuilding = lockoutGone && assignNaLeft !== null && assignNaLeft > 0;
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
