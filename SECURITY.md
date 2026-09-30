# Security

The page runs in the visitor's browser, with no account and no session. There
is one server of mine, `wvwrelink.com/api` (`worker/`), and one database behind
it, and neither ever sees anything a visitor types: they only take in game data
that this project's two Apps Scripts send, each message signed. So the reports
worth making are about the page being turned against the person using it, and
about getting something into that database that the scripts did not send.

## Reporting

**Please do not open a public issue for a security problem.** Use
[private vulnerability reporting](../../security/advisories/new) — it opens a
thread only you and I can see, and it does not put a working recipe in front
of everyone while the page is still live.

I am one person doing this in my spare time. Expect an answer in days rather
than hours.

## What I want to hear about

- **Anything that gets script running on the page.** Guild names arrive from
  the API and from a community spreadsheet and end up on screen. They are put
  in as text, never as markup. A way around that is the report I most want.
- **A way to make the page state something untrue about time.** The timers are
  the reason people come here. A crafted link that shows a relink or a lockout
  that is not real uses the site to mislead someone.
- **A way to make the page send what somebody typed anywhere** other than the
  hosts named in the Content Security Policy, at the top of
  `index.html`.
- **A way to get something into what the site serves** that did not come from
  this repository.
- **A way to get the Worker to write anything** without the secret a script
  signs with — a replay it accepts, a check it skips, a value it stores that
  it should have refused.

## What is not a security report

- Wrong team names, or community spreadsheet data being out of date. That is a
  bug or a stale source — open an issue.
- The Guild Wars 2 API being slow, down, or answering late. Nothing here can
  fix that, and the page is written to say so instead of inventing a number.
- Scanner output with no described effect on somebody using the site. A static
  page with no cookies, no login and nothing to log into does not have the
  same surface as an app, and a missing header is not by itself a finding.
- The `/api` routes answering "refused" or 404 to requests without a
  signature. That is what they are for.

## Scope

This repository, and the site it serves at `wvwrelink.com` — including
`wvwrelink.com/api` and its database, and the two
spreadsheets this project fills and publishes itself: the kills history behind
the crossed swords, and the one cell that decides whether the page announces
that new teams are out. Both are published read-only on purpose. If either
turns out to be writable by anyone with the link, that is a finding here and a
serious one, because whoever can write that cell decides what this page tells
people about their team.

ArenaNet's API, the community guild sheet, Google as a platform, Cloudflare and
GoatCounter are other people's services — report those to them.
