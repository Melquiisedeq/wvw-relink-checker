# WvW Relink Checker

[![Live Demo](https://img.shields.io/badge/demo-live-7fd6f2?style=flat-square)](https://wvwrelink.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fa9cc?style=flat-square)](LICENSE)

A hosted web tool for Guild Wars 2 WvW alliances. Paste a list of guild
names and instantly see which team each one landed on after a relink,
plus live tier standings and interactive maps for every NA and EU match.

**[Open the live tool](https://wvwrelink.com/)**

There is nothing to install and nothing to download — the link above is
the tool.

https://github.com/user-attachments/assets/372a3ade-0d54-4f39-aa1f-d4fc1354904d

## Why this exists

After every WvW relink, alliance members ask the same question: which
server did we land on? Checking manually means looking up each guild's ID
and cross referencing it against the API by hand. This tool does it for a
whole list of guilds at once, and shows live match data on top.

## Features

**Guild lookup**
- Paste guild names, one per line, and get the region, server, and current
  match context for each.
- Marks which side your guild landed on, right in the results.
- Two one-click copy buttons build a shareable summary of who you're
  fighting with and against:
  - **Copy for chat**: a compact, tags-only version that fits the
    in-game chat's character limit.
  - **Copy for Discord**: a fuller version with guild names, plus each
    alliance's tag and every member guild's own tag underneath it (a
    guild doesn't always fly its alliance's tag).
  - The ally/enemy tag breakdown is built from the same NA community
    sheet as the shield icon below, so it's NA only; EU summaries fall
    back to a plain "Fighting: ..." line.

**Live standings (NA and EU)**
- Every current match, all tiers, ranked by victory points, refreshed
  automatically in the background (about every 5 minutes) for as long as
  the page stays open, no reload needed.
- Auto-refresh pauses while the tab is in the background and catches up
  right away when you switch back to it, so it never wastes requests on a
  tab nobody's looking at.
- A small pulsing dot next to "Synced HH:MM" shows the data is live;
  hover it for the refresh interval.
- Each side shows Skirmish score, Activity (kills + deaths this week), and
  K/D, colored green or red depending on whether that side is winning or
  losing the kill trade.
- Whichever side leads a stat within its tier gets that number underlined.
- A small arrow next to each side's VP previews where it lands at the next
  relink: up for 1st place, down for 3rd, a flat bar for 2nd (and for 1st
  or 3rd when there's no tier left to move into). Hover it for the full
  wording.
- A thin score bar shows how the current 2-hour skirmish compares to the
  tier leader.
- Each side is tinted in its own WvW color (red, blue, green) for a quick
  visual read.
- A trophy icon next to each region links to that region's player kill
  leaderboard on gw2mists.com.

**Interactive tier maps** (map icon next to a tier)
- All four maps of that match — Eternal Battlegrounds and the three
  borderlands — drawn from the API's own sector polygons, so every
  objective sits where the game puts it.
- Objective icons are colored for the team currently holding them, and
  sector borders are tinted the same way, so map control reads at a
  glance.
- Upgrade tier shows as small shields under each icon (one, two or three)
  plus a highlight that grows with the tier; tier 0 is left plain.
- A claimed objective shows the owning guild's actual emblem, in
  monochrome.
- Click an objective for its detail: current owner, how long ago it
  flipped, upgrade tier, dolyaks delivered, the guild holding it, and the
  tactics slotted into it.
- Drag to pan, wheel or buttons to zoom; icons scale with the zoom so they
  stay readable at every level.
- While a map is open it refreshes itself every 30 seconds, in place,
  without closing what you have selected.

**Detail popovers** (click the small icon next to a stat; closes on
outside click, Escape, or if the window resizes, though an expanded
guild list stays open on resize and just re-arranges its columns instead)
- Trend icon on Skirmish: score per 2-hour block for the whole week, with
  all three sides on one scale — so a dip tells you whether it was this
  server or the entire tier going quiet. Day ticks along the axis, last
  block, weekly average and peak, and a per-map breakdown of the last
  finished block. The block still being played is reported separately
  with a projection rather than plotted: a half-scored block drawn beside
  finished ones made every chart end in a cliff that wasn't real.
- Info icon on Activity: what the number means, plus how this side's
  total compares with the other two in the tier.
- Crossed-swords icon on K/D: kills, deaths, and K/D broken down per map
  (EBG and each borderland). The bar shows how much of the week's
  fighting happened on each map, so it says where the war actually is,
  while the K/D beside it says how that fighting went.
- Shield icon on NA server names: which alliances and solo guilds the
  community has reported there, tag and name for each. An expand button
  opens it as a large, screenshot-friendly centered view: alliances are
  laid out as cards and auto-arranged (largest first, into whichever
  column has the least content so far) so the list stays compact and
  free of leftover blank space no matter how uneven alliance sizes are.

**Relink and lockout timers**
- A banner at the top counts down to the next relink — when the current
  tier matchups end and everyone gets shuffled into new pairings for the
  following week — and to the season lockout. The relink countdown is
  read straight off the match data already loaded for the standings
  rails (each match's own `end_time`), so it needs no separate request
  and refreshes on the same ~5-minute cadence as standings; the lockout
  timestamp is re-fetched from the API about every 10 minutes. Hover
  either figure for a tooltip explaining what it counts down to.
- Once a season's lockout date has passed and the next one hasn't been
  published yet, the banner shows "Resumes after next relink" instead of
  a countdown stuck at zero.

**No sign-in, no backend, no build step**
- No account, no API key, nothing to configure. Everything runs in your
  browser against public endpoints.
- No package dependencies and no build pipeline: plain HTML, CSS and
  JavaScript, served as they are. Needs a modern evergreen browser
  (Chrome, Firefox, Safari, Edge); no polyfills, no transpiling.

## How it works

1. Each guild name is resolved to an ID through the guild search endpoint.
2. Guild-to-team mappings are fetched once from the WvW guilds endpoints
   and reused for every guild you check, for up to about 10 minutes before
   the next check re-fetches it. This mapping only actually changes at the
   weekly relink, so the 10-minute cache is a conservative, deliberately
   short-lived cache rather than an attempt to match that cadence exactly.
3. The team ID is matched against the API's match data to find the current
   tier, score, and side. Match data includes a legacy "world" field and a
   modern Team ID mixed into an `all_worlds` list; Team IDs are always
   5-digit, so that's what this tool matches on. Team names come from
   ArenaNet's published team list, since there's no endpoint that resolves
   this automatically.
4. Standings for every active match load when the page opens and then
   keep refreshing automatically in the background (see Features above),
   so most guild checks reuse data that's already cached and current.
5. Each side's relink arrow comes from its rank by victory points within
   the tier (1st up, 2nd flat, 3rd down), checked against the highest
   tier active in that region so a 1st place already at tier 1, or a 3rd
   place already at the bottom, shows flat instead.
6. The relink countdown is the current match's own `end_time`, already
   present in the standings data, so it needs no extra request and
   updates on the same ~5-minute cadence as the standings rails. The
   season lockout timestamp comes from the API's own timer endpoint and
   is re-fetched about every 10 minutes. Both on-screen countdowns tick
   every minute between refreshes.
7. The NA guild/alliance list behind the shield icon is fetched from a
   public Google Sheet maintained by the NA WvW Discord (as a CSV export,
   no API key involved), cached for about 5 minutes, and only re-fetched
   when a shield icon is actually clicked. In the expanded view, alliance
   cards are measured after rendering and bin-packed into columns
   (largest card first, always into the currently shortest column), which
   keeps columns evenly filled even when alliance sizes vary a lot.
8. The per-map K/D and Activity breakdowns use match data already loaded
   on the page, so they open instantly with no extra request. The Skirmish
   trend uses the same match's per-skirmish score history.
9. The maps combine three sources, all of them cheap: ownership comes free
   with the match data already loaded; objective names and positions come
   from the objective catalogue, fetched once per session; and the map
   outlines are the API's own sector polygons, in the same coordinate
   space as the objectives. Upgrade tier is derived from dolyaks delivered
   against the per-step thresholds in the upgrade catalogue.

## Usage

1. [Open the tool](https://wvwrelink.com/).
2. Paste guild names exactly as they appear in game, one per line.
3. Click Check.
4. Use "Copy for chat" or "Copy for Discord" to grab a shareable,
   team-by-team text block in the format that fits where you're posting it.
5. Share the results with your alliance.

Guild names must match exactly, since the API only supports exact search,
not partial or tag based matches. A raw guild GUID also works. Up to 60
entries can be checked per run.

## Privacy

**What leaves your browser**

| Host | What for |
|---|---|
| `api.guildwars2.com` | The guild names you paste are sent here to be resolved — that request *is* the lookup. Also all match, objective and upgrade data. |
| `render.guildwars2.com` | Guild emblem images, for objectives claimed by a guild. Images only. |
| `docs.google.com` | Only when you click a shield icon: a read-only CSV export of the community guild sheet. |
| `melquiisedeq.goatcounter.com` | One anonymous page view per visit. Nothing else. |

**What stays in your browser**

The guild list you type is saved in your browser's local storage under
`wvw-relink-checker:guilds`, so it is still there next time you open the
tool. That saved copy never leaves your device and is never sent
anywhere. Pressing Check, of course, does send the names themselves to
the Guild Wars 2 API — that is what the lookup is.

**The visit counter**

Visits are counted with [GoatCounter](https://www.goatcounter.com): no
cookies, no local storage, no fingerprinting, no cross-site tracking, no
persistent identifier of any kind. One request per page load records the
page address, the referring site, the page title, screen width and
country — and nothing you type. It fires once, as the page loads, before
there is any input to leak, and the tool never writes anything into the
page address or the page title.

To keep your own browser out of the count, run `localStorage.skipgc = 't'`
in the developer console on the site, or open it once with
`#toggle-goatcounter` on the end of the address.

GoatCounter's `count.js` is vendored into `js/` and served from this
repository rather than from its CDN, so no third-party script is ever
loaded.

## Security

- A strict Content Security Policy denies everything by default.
  `connect-src` allows `api.guildwars2.com`, `docs.google.com`
  (read-only, the community sheet) and the GoatCounter counting endpoint.
  `img-src` allows this site, `data:`, `render.guildwars2.com` for guild
  emblems, and the same GoatCounter endpoint. `script-src` is `'self'`:
  every script is served from this repository, no CDN.
- Guild names, alliance names, and tags (from the API or the community
  sheet) are always rendered through `textContent`, never `innerHTML`, so
  they can never be parsed as markup. The only values ever interpolated
  into `innerHTML` are numbers already coerced with `Number()`.
- Object lookups guard against prototype pollution explicitly.
- Every request has a timeout and a bounded retry policy, including
  respect for `Retry-After` on rate limit responses.
- Input is capped and deduplicated on the client before any request fires,
  and each pasted line is capped at 64 characters so one absurdly long
  line can't turn into an oversized request.
- Community sheet parsing avoids combined regexes with ambiguous
  backtracking, so a crafted or malformed sheet row can't freeze the tab.
- External links open with `rel="noopener noreferrer"`.

## Project layout

Plain static files, no build step. `index.html` sits at the repository
root, which is all GitHub Pages needs in order to serve it.

```
index.html   markup, the CSP, and the ordered list of scripts
css/         one stylesheet per concern
js/          one file per concern, loaded in order; boot.js runs last
assets/      map renders, game icons, and the screenshot
```

The scripts are plain (non-module) and share one global scope, so the
order in `index.html` matters: `config.js` and `dom.js` come first
because everything reads them, and `boot.js` comes last because it starts
the page.

## Limitations

- Background refresh keeps standings and timers current within a few
  minutes, but it can't outrun ArenaNet's own backend: match data is
  known to update inconsistently on their end (sometimes near-instant,
  occasionally delayed much longer), which no client-side polling
  interval can fix.
- Team names come from a static table since the API has no endpoint to
  resolve them. If ArenaNet adds new matchmaking teams, the `TEAM_NAMES`
  object in `js/config.js` needs a manual update. A scheduled GitHub
  Action compares the live team IDs against that table and fails when the
  two drift apart.
- Guild search requires an exact name match.
- The NA guild/alliance list is community-maintained (not run by ArenaNet
  or this project), covers NA only, and may be incomplete or out of date.
  If the sheet's maintainer renames or reorders its tabs, this feature can
  break silently until updated to match.
- The player kill leaderboard link points to gw2mists.com, a third-party
  community site not affiliated with this project.
- The score for the 2-hour block currently being played is published by
  ArenaNet a little later than the block starts - measured at roughly 15
  minutes, and not at the same moment for every match. Until it lands,
  the trend popover shows how far into the block you are and says the
  score has not been posted yet, rather than inventing one.
- Guild emblems are drawn in monochrome. The API returns emblem colors as
  dye IDs that need an undocumented color transform to resolve, so the
  layer art is used exactly as it ships rather than guessed at.

## Disclaimer

This is an unofficial, fan made tool. It is not affiliated with, endorsed,
or sponsored by ArenaNet or NCsoft. All game content belongs to its
respective owners. Data is pulled live from the official Guild Wars 2 API.

## License

MIT. See [LICENSE](LICENSE).

`js/count.js` is GoatCounter's counting script, used unmodified under the
ISC license; its license header is preserved in the file.
