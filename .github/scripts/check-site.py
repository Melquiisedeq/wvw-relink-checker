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

The Content Security Policy is a response header, so it is compared with the
line in site/_headers: a deploy that dropped or mangled that file serves the
page with no policy at all, and it looks exactly the same.

Two more facts about the domain, each a date or a status and no judgement:
the old GitHub Pages address stays gone (removing the custom domain did not
unpublish it, and it kept serving a copy of the repository for a day), and
the domain is not about to expire - it is renewed by hand, on purpose, so
this is what remembers.

Run it by hand any time:  python .github/scripts/check-site.py
"""

import datetime
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SITE = 'https://wvwrelink.com/'
HEADERS_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'site', '_headers')
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30
OLD_PAGES = 'https://melquiisedeq.github.io/wvw-relink-checker/'
RDAP = 'https://rdap.verisign.com/com/v1/domain/wvwrelink.com'
RENEW_WARN_DAYS = 60


def fetch(url):
    """GET and return (status, body, error, headers). Retries first."""
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'wvwrelink-health-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return (res.status, res.read().decode('utf-8', 'replace'),
                        None, res.headers)
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, None, '%s after %d attempts' % (last, ATTEMPTS), None


def status_of(url):
    """The HTTP status, 404 included, or None if nothing answered."""
    try:
        req = urllib.request.Request(
            url, headers={'User-Agent': 'wvwrelink-health-check'})
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            return res.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return None


def csp_written():
    """The policy site/_headers sets for /*, as the page should receive it."""
    rule = None
    with io.open(HEADERS_FILE, encoding='utf-8') as fh:
        for line in fh:
            if not line.strip() or line.startswith('#'):
                continue
            if not line[0].isspace():
                rule = line.strip()
            elif rule == '/*':
                name, _, value = line.strip().partition(':')
                if name.strip().lower() == 'content-security-policy':
                    return value.strip()
    return None


def domain_checks(problems, notes):
    status = status_of(OLD_PAGES)
    if status == 200:
        problems.append('%s answers 200: GitHub Pages is publishing the '
                        'repository again. Settings > Pages > Unpublish.'
                        % OLD_PAGES)
    else:
        notes.append('%-46s HTTP %s' % ('old GitHub Pages address', status))

    _, body, error, _ = fetch(RDAP)
    expires = None
    if not error:
        try:
            for event in json.loads(body).get('events', []):
                if event.get('eventAction') == 'expiration':
                    expires = datetime.datetime.fromisoformat(
                        event['eventDate'].replace('Z', '+00:00'))
        except (ValueError, KeyError, TypeError):
            pass
    if expires is None:
        problems.append('Could not read when wvwrelink.com expires from %s '
                        '(%s).' % (RDAP, error or 'no expiration event'))
        return
    left = (expires - datetime.datetime.now(datetime.timezone.utc)).days
    if left < RENEW_WARN_DAYS:
        problems.append('wvwrelink.com expires on %s, in %d days, and '
                        'auto-renew is off on purpose. Renew it at Dynadot.'
                        % (expires.date(), left))
    else:
        notes.append('%-46s %s, %d days left' % ('domain expires',
                                                 expires.date(), left))


def main():
    problems, notes = [], []

    status, html, error, headers = fetch(SITE)
    if error:
        print('::error::%s did not answer (%s). The site is down, or DNS or '
              'the certificate is broken.' % (SITE, error))
        return 1

    notes.append('%-46s HTTP %s, %d KB' % (SITE, status, len(html) // 1024))

    # Enough to tell the real page from a placeholder, a parked domain, or a
    # half-finished deploy that happens to answer 200.
    for needle, what in (
            ('rel="canonical"', 'the canonical link'),
            ('js/boot.js', 'the script that starts the page')):
        if needle not in html:
            problems.append('The served page does not contain %s. Something is '
                            'answering on the domain, but it is not this site '
                            'as it is written here.' % what)

    written = csp_written()
    served = headers.get('Content-Security-Policy')
    if not served:
        problems.append('The page is served with no Content-Security-Policy '
                        'header. Nothing denies anything by default; site/'
                        '_headers did not deploy, or its /* rule broke.')
    elif served.strip() != written:
        problems.append('The served Content-Security-Policy is not the one in '
                        'site/_headers. Served: %s' % served)
    else:
        notes.append('%-46s as written in _headers' % 'Content-Security-Policy')

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
        status, _, error, _ = fetch(SITE + path.lstrip('/'))
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

    domain_checks(problems, notes)

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
