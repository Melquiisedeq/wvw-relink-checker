# WvW Relink Checker

[![Live Demo](https://img.shields.io/badge/demo-live-7fd6f2?style=flat-square)](https://melquiisedeq.github.io/wvw-relink-checker/)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fa9cc?style=flat-square)](LICENSE)

A single-file web tool for Guild Wars 2 WvW alliances. Paste a list of
guild names and instantly see which team each one landed on after a
relink, plus live tier standings for every NA and EU match.

**[Open the live tool](https://melquiisedeq.github.io/wvw-relink-checker/)**

![WvW Relink Checker screenshot](docs/screenshot.png)

## Why this exists

After every WvW relink, alliance members ask the same question: which
server did we land on? Checking manually means looking up each guild's ID
and cross referencing it against the API by hand. This tool does it for a
whole list of guilds at once, and shows live match data on top.

## Features

- Paste guild names, one per line, and get the region and server for each.
- A top banner shows the countdown to the next weekly relink and to the
  season lockout, so you always know how much time is left.
- Live standings for every current NA and EU match: tier, rank, skirmish
  score, victory points, and kill/death ratio.
- Marks which side your guild landed on, right in the results.
- One-click "Copy summary" button that turns the results into a short,
  shareable text block grouped by team, ready to paste in Discord.
- No installation, no backend, no build step. It is a single HTML file.
- No sign-in, no API key, no personal data collected or stored.
- Runs entirely in your browser. It only talks to the official GW2 API.

## How it works

1. Each guild name is resolved to an ID through the guild search endpoint.
2. Guild-to-team mappings are fetched once from the WvW guilds endpoints
   and reused for every guild you check.
3. The team ID is matched against the API's match data to find the current
   tier, score, and side. Team names come from ArenaNet's published team
   list, since there is no endpoint that resolves this automatically.
4. Standings for every active match load automatically when the page opens,
   so most guild checks reuse data that is already cached.
5. The relink and lockout timers come straight from the API's own timer
   endpoints and refresh once a minute while the page is open.

Nothing leaves your browser except requests to `api.guildwars2.com`.

## Usage

1. Open the page, locally or through the hosted link.
2. Paste guild names exactly as they appear in game, one per line.
3. Click Check.
4. Use "Copy summary" to grab a shareable, team-by-team text block.
5. Share the results with your alliance.

Guild names must match exactly, since the API only supports exact search,
not partial or tag based matches. A raw guild GUID also works. Up to 60
entries can be checked per run.

## Running locally

No build step needed. Either:

- Open `index.html` directly in your browser, or
- Serve the folder with any static file server:
  ```bash
  python3 -m http.server 8000
  ```
  then visit `http://localhost:8000`.

## Deploying

This repo works as is with GitHub Pages, since `index.html` sits at the
repo root. No build pipeline required.

## Security

- A strict Content Security Policy only allows connections to
  `api.guildwars2.com`. Everything else is denied by default.
- All dynamic content is rendered through safe DOM APIs, never `innerHTML`
  with interpolated data. This rules out injection through guild names or
  API responses.
- Object lookups guard against prototype pollution explicitly.
- Every request has a timeout and a bounded retry policy, including
  respect for `Retry-After` on rate limit responses.
- Input is capped and deduplicated on the client before any request fires.

## Limitations

- Team names come from a static table since the API has no endpoint to
  resolve them. If ArenaNet adds new matchmaking teams, the `TEAM_NAMES`
  object in `index.html` needs a manual update.
- Guild search requires an exact name match.

## Disclaimer

This is an unofficial, fan made tool. It is not affiliated with, endorsed,
or sponsored by ArenaNet or NCsoft. All game content belongs to its
respective owners. Data is pulled live from the official Guild Wars 2 API.

## License

MIT. See [LICENSE](LICENSE).
