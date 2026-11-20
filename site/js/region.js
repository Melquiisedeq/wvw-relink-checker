'use strict';
// Which standings column goes on the left: the visitor's own choice, else their region by ArenaNet's rule: Western and Eastern Europe play on EU, every other
// country defaults to NA (guildwars2.com, "A World of Choice - The Regions of Guild Wars 2").
// The time zone stands in for the country and stays in the browser.
//
// In <head> and blocking, so the columns paint on the right side the first time.
// It sets data-rail-first on <html>: css/layout.css orders the columns from it
// until placeRails() in js/standings.js moves them in the DOM. The storage key is
// RAIL_FIRST_KEY in js/config.js, which loads after this. It also watches the
// scripts below it: see scriptsMissing.
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

// The <body> scripts that did not download. Any one leaves the page broken, so the
// notice is written here as it happens (boot.js may be the one missing), and
// js/boot.js starts nothing while the list has one. Two go unsaid: js/trebuchet.js is
// effects only (js/run.js's fx()), and js/maps.js reads the game when js/wvw-static.js is missing.
const scriptsMissing = [];
window.addEventListener('error', (e) => {
  const s = e.target;
  // Async ones stand outside the page's order: js/maps.js has its own fallback, and a blocked analytics beacon costs nothing.
  if (!(s instanceof HTMLScriptElement) || s.async || /\/js\/(trebuchet|wvw-static)\.js$/.test(s.src)) return;
  scriptsMissing.push(s.src);
  // The three lines sit above every <body> script in index.html.
  for (const id of ['statusMsg', 'standingsStatusNA', 'standingsStatusEU']) {
    document.getElementById(id).textContent = "Part of the page didn't load. Reload to fix it.";
  }
  document.getElementById('statusMsg').classList.add('status-err');
}, true);
