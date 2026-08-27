# WvW Relink Checker

A tiny, single-file, client-side tool for **Guild Wars 2** WvW alliances to
quickly check which matchmaking team ("server") each member guild landed on
after a relink.

**[Live demo](#)** — replace this with your GitHub Pages URL once it's deployed.

## Why

When WvW relinks happen, alliance members usually ask the same question over
and over: *"which server did we land on?"*. Answering that manually means
looking up each guild's ID and cross-referencing it against the WvW API by
hand. This tool automates that for a whole list of guilds at once.

## Features

- Paste guild names (one per line) and get the region + server for each one.
- No installation, no backend, no build step — a single static HTML file.
- No sign-in, no API key, no personal data collected or stored.
- Client-side only: your browser talks directly to the official GW2 API.
- Input validation, request timeouts, retry/backoff on rate limits, and a
  strict Content-Security-Policy — see [Security notes](#security-notes).

## How it works

1. Each guild name is resolved to a GUID via `GET /v2/guild/search?name=...`.
2. The current WvW guild-to-team mappings are fetched once from
   `GET /v2/wvw/guilds/na` and `GET /v2/wvw/guilds/eu` and reused for every
   guild in the list.
3. The guild's GUID is matched against those mappings to find its
   matchmaking team ID, which is translated into a human-readable server
   name using ArenaNet's published "Team IDs" table (there is currently no
   API endpoint that resolves this automatically).

All of this happens in the browser — nothing is sent to any server other
than `api.guildwars2.com`.

## Usage

1. Open the page (locally or via the hosted link).
2. Paste guild names, one per line, exactly as they appear in-game.
3. Click **Check**.
4. Share the resulting list with your alliance.

Guild names must match exactly (the API performs an exact-name search, not a
partial or tag-based one). You can also paste a raw guild GUID directly if
you already know it. Up to 60 entries can be checked per run.

## Running locally

No build step required. Either:

- Double-click `index.html` to open it directly in your browser, or
- Serve the folder with any static file server, e.g.:
  ```bash
  python3 -m http.server 8000
  ```
  then open `http://localhost:8000`.

## Deploying

This repo is set up to be served as-is via **GitHub Pages** (`index.html` at
the repo root). No build pipeline is needed.

## Security notes

- Strict `Content-Security-Policy`: the page is only allowed to connect to
  `api.guildwars2.com`; everything else (images, forms, other origins) is
  denied by default.
- All dynamic content is rendered through DOM APIs (`textContent`), never
  `innerHTML` with interpolated strings, which rules out XSS from guild
  names or API responses.
- Object lookups use `hasOwnProperty` explicitly to avoid any prototype
  pollution edge cases.
- Requests have a hard timeout and a bounded retry/backoff policy (including
  respecting `Retry-After` on HTTP 429) to avoid hammering the public API.
- Input is capped at 60 entries per run and de-duplicated client-side.

## Limitations

- The WvW team-name table is static (sourced from the [official API
  wiki](https://wiki.guildwars2.com/wiki/API:2/wvw/guilds/:region)) since
  there is no API endpoint to resolve team IDs to names. If ArenaNet adds new
  matchmaking teams, the `TEAM_NAMES` object in `index.html` needs a manual
  update.
- Guild name search requires an exact match.

## Disclaimer

This is an unofficial, fan-made tool and is not affiliated with, endorsed,
sponsored, or specifically approved by ArenaNet or NCsoft. All game content
and materials are property of their respective owners. Data is retrieved
live from the [official Guild Wars 2 API](https://wiki.guildwars2.com/wiki/API:Main).

## License

MIT — see [LICENSE](LICENSE).
