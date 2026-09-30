# Security

Everything here runs in the visitor's browser. There is no server of mine, no
database, no account and no session. So the reports worth making are the ones
about the page being turned against the person using it.

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

## What is not a security report

- Wrong team names, or community spreadsheet data being out of date. That is a
  bug or a stale source — open an issue.
- The Guild Wars 2 API being slow, down, or answering late. Nothing here can
  fix that, and the page is written to say so instead of inventing a number.
- Scanner output with no described effect on somebody using the site. A static
  page with no cookies, no login and nothing to log into does not have the
  same surface as an app, and a missing header is not by itself a finding.

## Scope

This repository, and the site it serves at `wvwrelink.com` — including the two
spreadsheets this project fills and publishes itself: the kills history behind
the crossed swords, and the one cell that decides whether the page announces
that new teams are out. Both are published read-only on purpose. If either
turns out to be writable by anyone with the link, that is a finding here and a
serious one, because whoever can write that cell decides what this page tells
people about their team.

ArenaNet's API, the community guild sheet, Google as a platform, Cloudflare and
GoatCounter are other people's services — report those to them.
