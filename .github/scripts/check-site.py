#!/usr/bin/env python3
"""Is the published site actually serving everything it asks for?

check-structure.py reads the repository. This reads wvwrelink.com. The two are
not the same question: the repository can be perfectly consistent while a file
failed to deploy, and then the page loads, looks right, and one feature is
missing with nothing in the logs anywhere.

So the list of files is taken from the *served* HTML, not from the repository,
and every one of them is fetched. A 404 on js/maps.js is the whole maps panel
gone, and the only place it shows is the console of whoever happened to open
the site.

Run it by hand any time:  python .github/scripts/check-site.py
"""

import re
import sys
import time
import urllib.error
import urllib.request

SITE = 'https://wvwrelink.com/'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30


def fetch(url):
    """GET and return (status, body, error). Retries before giving up."""
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'wvwrelink-health-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return res.status, res.read().decode('utf-8', 'replace'), None
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, None, '%s after %d attempts' % (last, ATTEMPTS)


def main():
    problems, notes = [], []

    status, html, error = fetch(SITE)
    if error:
        print('::error::%s did not answer (%s). The site is down, or DNS or '
              'the certificate is broken.' % (SITE, error))
        return 1

    notes.append('%-46s HTTP %s, %d KB' % (SITE, status, len(html) // 1024))

    # Enough to tell the real page from a placeholder, a parked domain, or a
    # half-finished deploy that happens to answer 200.
    for needle, what in (
            ('Content-Security-Policy', 'the Content Security Policy'),
            ('rel="canonical"', 'the canonical link'),
            ('js/boot.js', 'the script that starts the page')):
        if needle not in html:
            problems.append('The served page does not contain %s. Something is '
                            'answering on the domain, but it is not this site '
                            'as it is written here.' % what)

    # From the served HTML, not from the repository: the point is to catch a
    # file the deploy left behind.
    assets = re.findall(r'<script\b[^>]*\bsrc="([^":]+)"', html) \
        + re.findall(r'<link\b[^>]*href="([^":]+\.css)"', html)

    if not assets:
        problems.append('No scripts or stylesheets found in the served HTML at '
                        'all. Either the page is not what we think it is, or '
                        'it was rewritten on the way out.')
        assets = []

    missing = []
    for path in assets:
        status, _, error = fetch(SITE + path.lstrip('/'))
        if error:
            missing.append('%s (%s)' % (path, error))

    if missing:
        problems.append('The page asks for %d file(s) the site does not serve: '
                        '%s. The page still loads and whatever was in them '
                        'simply does not happen.'
                        % (len(missing), ', '.join(missing)))
    else:
        notes.append('%-46s all %d served' % ('scripts and stylesheets',
                                              len(assets)))

    for note in notes:
        print(note)
    print('')

    if problems:
        for problem in problems:
            print('::error::%s' % problem)
        print('')
        print('%d problem(s).' % len(problems))
        return 1

    print('The site answers, and serves every file its own HTML asks for.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
