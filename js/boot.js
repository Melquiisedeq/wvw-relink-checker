'use strict';
// ---------------------------------------------------------------------
// Boot
// Kicks off the first load, starts the background refreshes, seeds the
// ember field and idles the page when nobody is looking. Loads last.
// ---------------------------------------------------------------------

// Initial load, then keep both data sets fresh in the background for as
// long as the tab stays open (see STANDINGS_REFRESH_MS / TIMERS_REFRESH_MS).
showStandingsSkeleton(standingsGridNA);
showStandingsSkeleton(standingsGridEU);
refreshStandings();
loadTimers();
setInterval(updateRelinkBanner, 60000); // ticks the countdown display only
schedulePeriodicRefresh(refreshStandings, STANDINGS_REFRESH_MS);
schedulePeriodicRefresh(fetchTimers, TIMERS_REFRESH_MS);
// Embers drifting up the page: 46 of them, one in four cyan instead of
// warm. Each gets its own column, duration and sideways drift so the
// field never resolves into a visible loop.

// Ambient animation is for when someone is looking. A second monitor is
// the case that matters here: the page is still visible, so
// visibilitychange never fires and the ember field keeps compositing 46
// shadowed sprites forever - enough to cost frames in whatever is
// playing on the other screen. Focus is the signal that actually
// distinguishes "on screen" from "being watched".
(function idleWhenUnwatched() {
  const root = document.documentElement;
  const update = () => {
    const away = document.visibilityState === 'hidden' || !document.hasFocus();
    root.classList.toggle('is-idle', away);
  };
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
})();

(function seedEmbers() {
  const host = document.getElementById('fxEmbers');
  if (!host) return;
  for (let i = 0; i < 46; i++) {
    const ember = document.createElement('span');
    ember.className = i % 4 === 0 ? 'ember ember--cold' : 'ember';
    ember.style.left = `${Math.random() * 100}%`;
    ember.style.animationDuration = `${14 + Math.random() * 16}s`;
    // Negative delay starts each one mid-flight, so the field is already
    // populated on load instead of rising all at once from the bottom.
    ember.style.animationDelay = `${-Math.random() * 26}s`;
    ember.style.setProperty('--drift', `${Math.round(Math.random() * 90 - 45)}px`);
    host.appendChild(ember);
  }
})();

