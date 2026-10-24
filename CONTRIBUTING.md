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
same rule: one file, no dependencies, nothing to install. The browser tests in
`.github/e2e/` are the one place with dependencies, Playwright Test and
monocart-coverage-reports, and nothing in `site/` or `worker/` may import from there.

So a pull request that adds a library, a bundler or a framework will not be
merged, however good the library is. If something really does need one, open
an issue first and say what for.

```
site/          everything the browser downloads; Cloudflare serves it as it is
  index.html   markup and the ordered list of scripts
  css/         one stylesheet per concern
  js/          one file per concern, loaded in order; boot.js runs last
  assets/      map renders, game icons, and the link-preview card
  _headers     response headers, the CSP among them
worker/        wvwrelink.com/api: takes each script's signed results into a
               Cloudflare D1 database, says when each last reported
               (/api/health), and serves the page its reads (/api/kills,
               /api/relink, /api/latest,
               /api/latest/summary)
apps-script/   the two Google Apps Script projects behind the spreadsheets:
               the teams notice and the kills history; the copies they are
               pasted from
supabase/      the two readers, one per API server pool, that push the newest
               match bodies to the Worker every minute
tests/         the Worker's and the Supabase readers' rules, and the page's
               rules with its scripts in a node:vm; run by node --test
.github/       the checks and the workflows that run them; e2e/ holds the
               browser tests (Playwright Test, monocart-coverage-reports)
wrangler.jsonc the root Worker: serves site/ as static assets, no code
CONTRIBUTING.md  SECURITY.md  LICENSE
```

## Four things that will bite you

**The scripts are not modules.** They share one global scope, so the order in
`index.html` decides everything: `config.js` and `dom.js` come first because
everything reads them, and `boot.js` comes last because it starts the page. A
new file goes into that list at the right position, not at the end by default.

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
text content. Passing a value from a response to `innerHTML` is the one change
that turns this tool into a way to attack the person using it.

## Running it

Serve it over http rather than double-clicking the file — the Content Security
Policy does not behave the same on a `file://` URL:

    python -m http.server 8000 --directory site

Then open `http://localhost:8000`. No API key, no account, nothing to set up.

The Worker behind `wvwrelink.com/api` has tests, and so do the page's rules
(its scripts loaded into a `node:vm`, no browser), with nothing to install
(Node 22.13 or later):

    node --test "tests/*.test.mjs"

The page itself has browser tests that open it in a real Chrome. They use
Playwright Test, pinned in `.github/e2e/package-lock.json` (Node 22 and one
installed Chrome or Chromium; no browser is downloaded):

    cd .github/e2e && npm ci --ignore-scripts && npx playwright test

They drive your installed Google Chrome, or the executable `CHROME` names
(`CHROME=/usr/bin/chromium npx playwright test`); CI uses its own Google
Chrome. They serve `site/` with its real headers (`SITE_DIR` serves another
folder) and answer the API and the sheets from a recording in
`.github/e2e/recordings.json.gz`, so they run offline, and start the page's
clock at the recording's instant. The tests walk the page as a visitor would: a
guild search, every tier map and each of its tabs, the popovers, the NA/EU
swap, a second load with `/api` answering 503. A test fails on an exception, a
console error, a Content Security Policy violation, or a URL that was not
recorded (the message names it). A skipped test fails the run; on CI a test
that passes only on its retry is a warning.

After a change that makes the page fetch something new, record again from the
real hosts and commit the file. The run is live, one worker; what decides is the
replay of the whole suite against the new file at the end, and the old
recording is replaced only if that passes:

    cd .github/e2e && RECORD=1 npx playwright test

(`RECORDINGS=/some/path.json.gz` writes the new recording there instead.)

The page runs your JavaScript in that Chrome, so run a stranger's pull request
in CI, not on your own machine.

A pull request needs four checks to pass: `structure`, `syntax`, `rules` and
`page` (`.github/workflows/checks.yml`). `rules` and `page` are the two test
commands above; `structure` runs without a network or an install:

    python3 .github/scripts/check-structure.py

`page` also fails if the page goes over its budget (`.github/e2e/budget.json`)
or a file's test coverage falls (`.github/e2e/coverage.json`); the message says
which measure and which file. `npm run coverage` in `.github/e2e` measures
it locally, running both test suites and comparing with `coverage.json`.

## Style

Match whatever is around you. The one habit worth knowing: comments explain
**why**, right next to the code that needed the reason. What the code does is
already in the code.

## Pull requests

One concern each. A fix and a redesign on the same branch means neither can be
taken without the other, and the small one ends up waiting on the big one.

A change in what the page does brings its test in the same pull request: a
rule in `tests/`, or a browser test in `.github/e2e/`. A bug fix brings a test
that fails before the fix and passes after it.

If a change is visible on the page, say what it looks like — a screenshot
saves a round trip.
