# Contributing

Issues and pull requests are both welcome. This file is the half the README
leaves out on purpose: the README is for people using the tool, this is for
people opening the code.

## The shape of it

Plain static files. **No build step, no dependencies, no package manager,
nothing pulled from a CDN.** That is not something waiting to be fixed, it is
the point — the page works because there is nothing between the browser and
the files, and it will still work in five years for the same reason. The one
script from elsewhere is Cloudflare's visit counter, and the page does not
need it to work. `worker/`, the only code that runs on a server, follows the
same rule: one file, no dependencies, nothing to install.

So a pull request that adds a library, a bundler or a framework will not be
merged, however good the library is. If something really does need one, open
an issue first and say what for.

## Three things that will bite you

**The scripts are not modules.** They share one global scope, so the order in
`index.html` decides everything: `config.js` and `dom.js` come first because
everything reads them, and `boot.js` comes last because it starts the page. A
new file goes into that list at the right position, not at the end by default.

**The Content Security Policy is strict.** It sits at the top of `index.html`
and names every host the page talks to. Anything fetched from a host that is
not on that list is blocked by the browser — quietly, with the page looking
perfectly fine and the feature simply not happening. Adding a host is a
decision, not a side effect: if a change needs one, say so in the pull request
and say why.

**What comes back from the API or the spreadsheet is text, never markup.**
Guild names are written by other people and end up on the page. They go in as
text content. Passing a value from a response to `innerHTML` is the one change
that turns this tool into a way to attack the person using it.

## Running it

Serve it over http rather than double-clicking the file — the Content Security
Policy does not behave the same on a `file://` URL:

    python -m http.server 8000 --directory site

Then open `http://localhost:8000`. No API key, no account, nothing to set up.

## Style

Match whatever is around you. The one habit worth knowing: comments explain
**why**, right next to the code that needed the reason. What the code does is
already in the code.

## Pull requests

One concern each. A fix and a redesign on the same branch means neither can be
taken without the other, and the small one ends up waiting on the big one.

If a change is visible on the page, say what it looks like — a screenshot
saves a round trip.
