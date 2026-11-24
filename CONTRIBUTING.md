# Contributing

Issues and pull requests are both welcome. This file is the half the README
leaves out on purpose: the README is for people using the tool, this is for
people opening the code.

## The shape of it

Plain static files. **The site has no build step, no dependencies, no package
manager, nothing pulled from a CDN.** That is not something waiting to be fixed, it is
the point — the page works because there is nothing between the browser and
the files, and it will still work in five years for the same reason. The one
script from elsewhere is Cloudflare's visit counter, and the page does not
need it to work. `worker/`, the Supabase readers in `supabase/` and the Apps Scripts in
`apps-script/` are the code that runs outside the browser; `worker/` follows the
same rule: one file of code, no dependencies, nothing to install. There is no local setup for
`worker/`: the tests in `tests/unit/` run it under Node against a stand-in for its database (`tests/worker-fakes/`, which the browser tests use too);
merging into `main` deploys the code, and a schema file is run by hand. The browser tests in
`tests/e2e/` are the one place with dependencies, Playwright Test,
monocart-coverage-reports and @axe-core/playwright, and nothing in `site/` or `worker/` may import from there.

So a pull request that adds a library, a bundler or a framework will not be
merged, however good the library is. If something really does need one, open
an issue first and say what for.

```
site/          everything the browser downloads; Cloudflare serves it as it is
  index.html   markup and the ordered list of scripts
  css/         one stylesheet per concern
  js/          one file per concern, loaded in order; boot.js runs last,
               then js/maps.js, asked for by js/maps-early.js
  assets/      map renders, game icons, and the link-preview card
  _headers     response headers, the CSP among them
worker/        wvwrelink.com/api: takes each script's signed results into a
               Cloudflare D1 database, says when each last reported
               (/api/health), tells the page by WebSocket (/api/ws) when
               newer matches are in, and serves the page its reads (/api/kills,
               /api/relink, /api/latest,
               /api/latest/summary, /api/history/<region>); its SQL schemas
               and wrangler.jsonc sit beside index.mjs
apps-script/   the two Google Apps Script projects behind the spreadsheets:
               the teams notice and the kills history; the copies they are
               pasted from
supabase/      the reader, one function run from two Supabase regions, one per
               API server pool, that pushes the newest match
               bodies to the Worker every 20 seconds
tests/         unit/: the Worker's and the Supabase reader's rules, and the page's
               rules with its scripts in a node:vm, run by node --test;
               e2e/: the browser tests (Playwright Test, monocart-coverage-reports, @axe-core/playwright)
scripts/       the checks (check-*.mjs), the helper they import (workflow-text.mjs) and the contract they compare against
.github/       the workflows that run them, and the branch pruning
wrangler.jsonc the root Worker: serves site/ as static assets, no code
CONTRIBUTING.md  SECURITY.md  LICENSE
```

## Four things that will bite you

**The scripts are not modules.** They share one global scope, so the order in
`index.html` decides everything: `config.js` and `dom.js` come first because
everything reads them, and `boot.js` comes last because it starts the page. A
new file goes into that list at the right position, not at the end by default.
One file is outside it: `maps.js`, the map drawing, which `maps-early.js` asks
for once the standings are drawn or a map is opened, so it runs after all of
them.

**The Content Security Policy is strict.** It is a response header in
`site/_headers`, never a `<meta>` (in Chromium, a policy in a `<meta>` makes the
preload scanner's fetches wait until the tag is read and applied, so the scripts
end up requested one after another), and names every host the page talks to.
Anything fetched from a host that is not on that list is blocked by the
browser — quietly, with the page looking perfectly fine and the feature
simply not happening. Adding a host is a
decision, not a side effect: if a change needs one, say so in the pull request
and say why.

**Reduced motion is honoured only for those who ask.** The effects are the
character of the site, so for everyone else nothing changes. With `prefers-reduced-motion:
reduce` what moves on its own and never stops (the embers, the sweeping rule, the pulses,
the sheen, the skeleton rows, the live dots) stands still: the media query in `site/css/base.css`
pauses those animations one by one, and `idleWhenUnwatched` in `site/js/boot.js` stops the
canvas and follows the setting if it changes. The loading indicator keeps turning, since
stopped it looks stuck. The animations that run once (the shake after a search, the
trebuchet, the click effects) are not changed by it, except that the ember blast still
plays, with the rising embers moving for its two seconds.

**What comes back from the API or the spreadsheet is text, never markup.**
Guild names are written by other people and end up on the page. They go in as
text content. Passing a value from a response to the page as markup (`innerHTML` and the like) is the one change
that turns this tool into a way to attack the person using it.

## Running it

Serve it over http rather than double-clicking the file — the Content Security
Policy does not behave the same on a `file://` URL:

    python3 -m http.server 8000 --directory site

Then open `http://localhost:8000`. No API key, no account, nothing to set up.

The Worker behind `wvwrelink.com/api` has tests, and so do the page's rules
(its scripts loaded into a `node:vm`, no browser), with nothing to install
(Node 22.13 or later):

    node --test "tests/unit/**/*.test.mjs"

The page itself has browser tests that open it in a real Chrome. They use
Playwright Test, pinned in `tests/e2e/package-lock.json` (Node 22 and one
installed Chrome or Chromium; no browser is downloaded):

    cd tests/e2e && npm ci --ignore-scripts && npx playwright test

They drive your installed Google Chrome, or the executable `CHROME` names
(`CHROME=/usr/bin/chromium npx playwright test`); CI uses its own Google
Chrome. They serve `site/` with its real headers (`SITE_DIR` serves another
folder) and answer the API and the sheets from a recording in
`tests/e2e/data/recordings.json.gz`, so they run offline, and start the page's
clock at the recording's instant. The tests walk the page as a visitor would: a
guild search, every tier map and each of its tabs, the popovers, the NA/EU
swap, a second load with `/api` answering 503. A test fails on an exception, a
console error, a Content Security Policy violation, or a URL that was not
recorded (the message names it). A skipped test fails the run; on CI a test
that passes only on its retry is a warning.

A new or changed test goes through the screen, the network and the clock: it
finds an element by its role and its text (`getByRole`, `getByText`; a class
only where neither names it), counts requests (`page.on('request')`) rather
than calls, and waits on what is drawn or on the clock. What none of those
shows is asked of the page through one file, `tests/e2e/support/page.mjs`, a
function there for each thing read or done; `tests/unit/e2e/spec-port.test.mjs`
fails on a name from `site/js/` anywhere else under `tests/e2e/` (its
`WAITING` list holds the older specs that still use some; a review takes no
name added there). A test added in place of an older one says so in its pull
request, and the older one goes, or the pull request says why it stays.

After a change that makes the page fetch something new, record again from the
real hosts and commit the file. The run is live, one worker; what decides is the
replay of the whole suite against the new file at the end, and the old
recording is replaced only if that passes:

    cd tests/e2e && RECORD=1 npx playwright test

(`RECORDINGS=/some/path.json.gz` writes the new recording there instead.)

The page runs your JavaScript in that Chrome, so run a stranger's pull request
in CI, not on your own machine.

A pull request needs four checks to pass: `structure`, `syntax`, `rules` and
`page` (`.github/workflows/checks.yml`). `rules` and `page` are the two test
commands above; `structure` runs without a network or an install:

    node scripts/check-structure.mjs

`structure` also checks the README's Privacy tables against the code: every host
the page fetches and every key it stores must be listed there.

`page` also fails if the page goes over its budget (`tests/e2e/data/budget.json`)
or a file's coverage under `node --test` falls (`tests/e2e/data/coverage.json`); the message says
which measure and which file. The browser tests run on two machines, `e2e (1/2)` and `e2e (2/2)`. Another job,
`warn`, is not required: it runs the tests tagged `@timing` (they count frames, which a busy runner
moves) and `@quarantine` (one that fails for the machine, not the page, until it is fixed); red there
blocks nothing, and its summary says what failed. `@advisory` is a test that only warns by design: the axe accessibility scan of four screens (`tests/e2e/axe.spec.mjs`), whose violations the summary lists; it becomes a blocking check only by the owner's decision, with its list at zero. The coverage job's summary has the table per
file with both suites joined, but only the `node --test` numbers have a floor: the browser's move a
little between runs of one commit, the node tests' do not. `npm run coverage` in `tests/e2e` measures
it locally, running both test suites and comparing with `data/coverage.json`; `npm run coverage:write`
runs only the node tests and rewrites that file with their numbers.

## Words used in the code

The comments in `site/js/` and `worker/` lean on a few words in a narrow sense of their own:

- **copy**: the Worker's stored copy of each match's newest game data, served at `/api/latest`.
- **body**: one match's full game data, as the game's API gives it; the copy holds it without
  its finished skirmishes, which `/api/history` gives back (`latestJoin` in `js/api.js`). The
  **summary** is what `/api/latest/summary` serves: the same, without the bodies.
- **first sight**: the moment this page first saw a match's score, used as its `at` until a
  copy or the kill history dates it better (`js/api.js`).
- **peek**: the page's light, repeated read of the summary while the tab is visible, which
  loads more only when a match is ahead (`js/standings.js`).
- **in hand**: already in the page's memory (a summary, a body), so using it costs no request.
- **push**: two things: what a script or reader sends the Worker, signed; and what the
  Worker sends the page over `/api/ws` when a newer copy lands.
- **source**: who feeds the Worker (the kills script, the notice script, the readers); the
  database remembers when each last reported.
- **entrance**: the Worker's route that takes a source's push in and checks it (`/api/ingest/...`).
- **door**: any way in to the database; `worker/wrangler.jsonc` keeps a second one shut.

## Style

Match whatever is around you. The one habit worth knowing: comments explain
**why**, right next to the code that needed the reason. What the code does is
already in the code.

## Pull requests

One concern each. A fix and a redesign on the same branch means neither can be
taken without the other, and the small one ends up waiting on the big one.

A change in what the page does brings its test in the same pull request: a
rule in `tests/unit/`, or a browser test in `tests/e2e/`. A bug fix brings a test
that fails before the fix and passes after it.

If a change is visible on the page, say what it looks like — a screenshot
saves a round trip.
