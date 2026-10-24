<div align="center">

<img src="site/assets/logo.svg" width="100" alt="WvW Relink Checker">

# WvW Relink Checker

**Find out which WvW team your alliance landed on — in one paste.**

A web tool for Guild Wars 2 World vs World. Paste a list of guild names
and see which team each one landed on after a relink, plus tier
standings and live maps that show where the fighting is, for every NA and EU match.

[![Live demo](https://img.shields.io/badge/demo-wvwrelink.com-7fd6f2?style=for-the-badge)](https://wvwrelink.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-3fa9cc?style=for-the-badge)](LICENSE)
[![Site dependencies: none](https://img.shields.io/badge/site_dependencies-none-4caf7d?style=for-the-badge)](CONTRIBUTING.md#the-shape-of-it)
[![Build step: none](https://img.shields.io/badge/build_step-none-4caf7d?style=for-the-badge)](CONTRIBUTING.md#the-shape-of-it)

### [→ Open the live tool](https://wvwrelink.com/)

*No account · No API key · Nothing to install · The link **is** the tool*

</div>

## ✨ Features

|  |  |
|---|---|
| 🔍 | **Guild lookup** — paste names, get the team each one landed on |
| 📋 | **One-click summaries** — sized for in-game chat, or for Discord |
| 📊 | **Standings** — every NA and EU tier, updating on their own |
| 🗺️ | **Live maps** — all four battlegrounds, showing where the fighting is |
| 📈 | **Match detail** — weekly skirmish scores, per-map K/D, alliances per server |
| ⏱️ | **Timers** — relink and season lockout, each with its own warning beforehand |

## 🚀 How to use

Open [wvwrelink.com](https://wvwrelink.com/), paste guild names (one per
line) and read which team each landed on.

> [!NOTE]
> Guild names must match **exactly**: the guild search is exact, not partial
> and not by tag. A guild ID works too. Up to 20 per run. The alliance list
> behind the shield icon is NA only.

How it works: names are resolved to IDs through the API's guild search, then
matched against live match data for each one's team, tier and side. Standings
load once and keep refreshing in the background. The page reads
this project's own `/api` for the kills history, the new-teams notice and the
newest match bodies; the first two fall back to public Google Sheets when it
cannot answer. The NA alliance list is a public sheet kept by the NA WvW
Discord, read only when you click a shield icon.

## 🔒 Privacy

**Everything the page does runs in your browser, and nothing you type is sent
to me; the visits are counted, as the table below shows.** There is one small server of mine, at `wvwrelink.com/api`. It receives game
data from this project's own two Apps Scripts and two Supabase readers, each signed, and the page reads three things
back from it — the kills history, whether the new teams are out (both fall
back to the spreadsheets if it cannot answer) and the newest match bodies. Nothing you type goes near it.

| Host | What for |
|---|---|
| `api.guildwars2.com` | The guild names you paste go here to be resolved — that request *is* the lookup. Also all match, objective and upgrade data. |
| `render.guildwars2.com` | Guild emblem images, for objectives claimed by a guild. Images only. |
| `wvwrelink.com/api` | This site's own server: the kills history when you open a tier's maps, whether the new teams are out (read only in the days before a relink), and the newest match bodies, kept only when further along than the game's own answer. |
| `docs.google.com` | Three public spreadsheets, read-only: the community guild list when you click a shield icon, and the kills history and the new-teams notice when `/api` does not answer. |
| `melquiisedeq.goatcounter.com` | One anonymous page view per visit. Nothing else. |
| `static.cloudflareinsights.com`, `cloudflareinsights.com` | Cloudflare Web Analytics: its script, and a report of how fast the page loaded. |

Six things are kept in your browser's own storage. None of them ever
leave your device; three clear themselves out as they age, and the other
three are a single value each that gets overwritten.

| Key | What it holds |
|---|---|
| `wvw-relink-checker:guilds` | The list you typed, so it is still there next time |
| `wvw-guilds-v1` | Name, tag and emblem of guilds already looked up, so the maps don't ask twice |
| `wvw-fight-v1` | Recent kill counts per match — what puts the crossed swords on the busiest map |
| `wvw-weeks-v1` | The week's team line-up per tier, so a reload on a relink night does not bring back last week's while the API catches up |
| `wvw-rail-first` | Which region's standings column you put on the left, `na` or `eu` |
| `wvw-relink-checker:teams-notice` | Which relink's "the new teams are out" notice you dismissed, so it stays dismissed until the next one |
| `wvw-lab-v1` | Lab preview only (never merged): which of the lab panel's switches you turned on |

<details>
<summary><b>About the visit counter</b></summary>

<br>

Visits are counted with [GoatCounter](https://www.goatcounter.com) (no
cookies, no persistent identifier; its script is `site/js/count.js`, served
from this repository). To keep your own browser out of its count, run
`localStorage.skipgc = 't'` in the developer console on the site.

Cloudflare, which serves the site, also counts visits with its
[Web Analytics](https://developers.cloudflare.com/web-analytics/about/).
Cloudflare says it "does not use any client-side state, such as cookies or
localStorage, to collect usage metrics" and does not "fingerprint"
individuals ([cloudflare.com/web-analytics](https://www.cloudflare.com/web-analytics/)).
What it reports is how long the page took to load and draw, grouped by page,
referrer, country, browser, operating system and device type
([dimensions](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/)).
Its script comes from Cloudflare; a content blocker stops it.

</details>

## ⚠️ Limitations

- Guild search is exact: the full name or a guild ID, not the tag or part of the name.
- Team names come from a static table in `site/js/config.js`. A scheduled
  GitHub Action fails when the live team IDs drift from that table.
- The NA alliance list is community-maintained, not by ArenaNet and not by
  this project, and may be incomplete or out of date.
- The score for the 2-hour block being played can arrive late. Until it does,
  the trend popover says so rather than inventing a number.

## 🤝 Contributing

Bugs and ideas: [open an issue](https://github.com/Melquiisedeq/wvw-relink-checker/issues/new/choose)
([bug](.github/ISSUE_TEMPLATE/bug.yml) and [idea](.github/ISSUE_TEMPLATE/idea.yml) forms).
Code and project layout: [CONTRIBUTING.md](CONTRIBUTING.md). Security
problems: [SECURITY.md](SECURITY.md), not a public issue.

## 📜 Disclaimer & license

This is an unofficial, fan made tool. It is not affiliated with, endorsed,
or sponsored by **ArenaNet** or **NCsoft**. All game content belongs to
its respective owners. Data is pulled live from the official Guild Wars 2
API.

Released under the [MIT license](LICENSE). `site/js/count.js` is GoatCounter's
counting script, used unmodified under the ISC license; its license header
is preserved in the file.

<div align="center">
<br>

**[wvwrelink.com](https://wvwrelink.com/)**

</div>
