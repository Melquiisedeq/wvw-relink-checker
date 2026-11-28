'use strict';
// LAB (never merged): the preview of the new middle. The Worker that serves /api/notes is not live yet, so this
// answers /api/notes with recorded lines, shaped as worker/notes.mjs serves them; every other request goes out as is.
(() => {
  const WIKI = 'https://wiki.guildwars2.com/wiki/';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const now = Date.now();
  const at = (ago) => new Date(now - ago * 864e5);
  const line = (ago, text, type, extra = {}) => {
    const d = at(ago);
    const day = d.toISOString().slice(0, 10);
    return { day, update: `Update - ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
      section: 'World vs. World', sub: '', text, type, hotfix: false, page: `${WIKI}Game_updates/${day}`, link: null, ...extra };
  };
  const ends = at(-9);
  const until = `${MONTHS[ends.getUTCMonth()]} ${ends.getUTCDate()}`;
  const notes = [
    line(1, `The new Example Borderlands map has replaced the Seared Borderlands map in WvW! The beta for this new map will run until ${until}.`, 'event', { link: WIKI + 'Example_Borderlands' }),
    line(1, 'Fixed an issue that caused the Example Borderlands garrison gate to stay closed after a capture.', 'bug', { section: 'Bug Fixes' }),
    line(2, `The Example Festival is on in WvW and will run until ${until}.`, 'event'),
    line(3, 'Match rewards and skirmish rewards that were previously beta tested will now be fully released as well!', 'reward'),
    line(3, 'Fixed a bug that prevented players from buying Heart of Thorns items from the Heroics Notary in WvW.', 'bug', { section: 'Bug Fixes', hotfix: true }),
    line(6, 'Keep captures: 250 → 100 (T0)', 'wvw_rule'),
    line(6, 'Camp captures: 100 → 50 (T0)', 'wvw_rule'),
    line(6, 'Blazing Barrage: Reduced the power coefficient from 1.1 to 0.935 in WvW only.', 'nerf', { section: 'Profession Skills', sub: 'Tempest', link: WIKI + 'Blazing_Barrage' }),
    line(9, "Death's Retreat: Reduced the initiative cost from 6 to 5 in WvW only.", 'buff', { section: 'Profession Skills', sub: 'Thief' }),
    line(12, 'Keep waypoints now stay open for 30 seconds after the objective becomes contested.', 'wvw_rule'),
  ];
  const body = JSON.stringify({ v: 'a'.repeat(16), wiki: Math.floor(now / 1000) - 3600, notes });
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (String((u && u.url) || u).includes('/api/notes')
    ? Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json', Date: new Date().toUTCString() } }))
    : real(u, o));
})();

// LAB (never merged): the preview has no /api, so no copy brings the server's objective counts
// (`taken`). These are made up from each body's own objectives, only so the "Objective points"
// metric and the Busiest map by the server's count show: the numbers are not the real ones.
(() => {
  const made = () => {
    if (typeof newestMatches === 'undefined' || typeof latestTaken === 'undefined') return;
    let added = false;
    for (const e of newestMatches.values()) {
      const m = e && e.match;
      if (!m || latestTaken.has(m) || !Array.isArray(m.maps)) continue;
      const points = { red: 0, blue: 0, green: 0 };
      const flips = { red: 0, blue: 0, green: 0 };
      const maps = {};
      const start = Date.parse(m.start_time) || 0;
      for (const map of m.maps) {
        for (const o of map.objectives || []) {
          const c = String(o.owner || '').toLowerCase();
          if (!(c in points) || !['Camp', 'Tower', 'Keep', 'Castle'].includes(o.type)) continue;
          const at = Date.parse(o.last_flipped) || 0;
          if (at <= start) continue;
          flips[c] += 1;
          points[c] += Number(o.points_capture) || 0;
          if (Date.now() - at < 2 * 3600e3) maps[map.id] = (maps[map.id] || 0) + 1;
        }
      }
      if (flips.red + flips.blue + flips.green === 0) continue;
      latestTaken.set(m, { points, flips, maps });
      added = true;
    }
    if (added && typeof paintHighlights === 'function') paintHighlights();
  };
  setInterval(made, 3000);
})();
