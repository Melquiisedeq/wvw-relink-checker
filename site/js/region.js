'use strict';
// Which standings column goes on the left: the visitor's own choice if
// they made one, else their region by ArenaNet's rule - Western and
// Eastern Europe play on EU, every other country defaults to NA
// (guildwars2.com, "A World of Choice - The Regions of Guild Wars 2").
// The time zone stands in for the country and never leaves the browser.
//
// In <head> and blocking, so the columns are painted on the right side
// the first time instead of jumping across once the scripts at the end
// run. It only sets data-rail-first on <html>: css/layout.css orders the
// columns from it until placeRails() in js/standings.js moves them in the
// DOM. The storage key is RAIL_FIRST_KEY in js/config.js, which loads
// after this.
(function () {
  const EU_ZONE = /^(Europe\/|Atlantic\/(Azores|Canary|Faroe|Faeroe|Madeira|Reykjavik)$|Asia\/(Famagusta|Nicosia)$|Arctic\/Longyearbyen$)/;
  let first = null;
  try { first = localStorage.getItem('wvw-rail-first'); } catch (e) {}
  if (first !== 'na' && first !== 'eu') {
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    first = EU_ZONE.test(zone) ? 'eu' : 'na';
  }
  document.documentElement.dataset.railFirst = first;
})();
