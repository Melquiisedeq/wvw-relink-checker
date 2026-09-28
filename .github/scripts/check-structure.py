#!/usr/bin/env python3
"""Structural checks for a site that has no tests and cannot easily have any.

Nothing in this file is shipped. It lives under .github/, which Pages never
serves, and it runs only in CI. It exists because the mistakes this project
can actually make - a script missing from index.html, a host missing from the
Content Security Policy - fail *silently* in production: the page looks
completely fine and the feature simply does not happen. No error, no test,
nothing to notice until somebody reports it.

Run it by hand any time:  python .github/scripts/check-structure.py
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Every host that appears anywhere in the served files, and which kind it is.
#
#   FETCHED    the browser makes a request to it, so it must be in the CSP
#   MENTIONED  it only ever appears in a comment, an XML namespace, a licence
#              header or page metadata - no request, so no CSP entry
#
# A host in neither list fails. That is the whole point: a new host is a
# decision about the CSP, and this is where the decision gets noticed, rather
# than being discovered later by a feature quietly not working.
FETCHED = {
    'api.guildwars2.com': 'guild search, matches, objectives, timers',
    'docs.google.com': 'the two public spreadsheets',
    'render.guildwars2.com': 'guild emblem images',
    'melquiisedeq.goatcounter.com': 'one page view per visit',
}

MENTIONED = {
    'wvwrelink.com': 'canonical link and JSON-LD - the site naming itself',
    'schema.org': 'JSON-LD vocabulary, not a URL anything loads',
    'www.w3.org': 'SVG and XML namespaces',
    'opensource.org': 'the ISC licence header inside the GoatCounter script',
    'www.goatcounter.com': 'a comment saying where count.js came from',
    'wiki.guildwars2.com': 'a comment linking the published team names',
    'www.guildwars2.com': 'a comment link',
    'gw2mists.com': 'a comment link',
    'en.wikipedia.org': 'a comment link',
    'github.com': 'a comment link',
    'lucide.dev': 'a comment crediting an icon',
}


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        return fh.read()


def files_in(directory, suffix):
    d = os.path.join(ROOT, directory)
    return sorted(f for f in os.listdir(d) if f.endswith(suffix))


def script_tags(html):
    """Every <script> tag, with its src and whether it is async.

    Parsed rather than grepped, for two reasons: the GoatCounter tag spans two
    lines, and the JSON-LD block has no src at all. A line-based grep reports
    the first as an orphan file and trips over the second.
    """
    out = []
    for m in re.finditer(r'<script\b[^>]*>', html):
        tag = m.group(0)
        src = re.search(r'\bsrc="([^"]+)"', tag)
        out.append({
            'src': src.group(1) if src else None,
            'async': re.search(r'\basync\b', tag) is not None,
        })
    return out


def check_hosts(problems):
    found = {}
    tree = ['index.html'] \
        + ['js/' + f for f in files_in('js', '.js')] \
        + ['css/' + f for f in files_in('css', '.css')]
    for rel in tree:
        for m in re.finditer(r'https?://([A-Za-z0-9.-]+)', read(rel)):
            found.setdefault(m.group(1), set()).add(rel)

    for host in sorted(found):
        if host in FETCHED or host in MENTIONED:
            continue
        where = ', '.join(sorted(found[host]))
        problems.append(
            '%s is a host this check has never seen, in %s. If the browser '
            'requests it, add it to the Content Security Policy in index.html '
            'and to FETCHED in this file. If it is only mentioned in a comment '
            'or a namespace, add it to MENTIONED and leave the CSP alone.'
            % (host, where))

    csp = re.search(r'Content-Security-Policy"\s*content="([^"]+)"',
                    read('index.html'), re.S)
    if not csp:
        problems.append(
            'No Content-Security-Policy meta tag found in index.html. That '
            'policy is what denies everything by default, so this is either a '
            'typo in the tag or something much worse.')
        return

    policy = csp.group(1)
    for host in sorted(FETCHED):
        if host not in policy:
            problems.append(
                '%s is fetched (%s) but is not named in the Content Security '
                'Policy, so the browser blocks it - quietly, with the page '
                'looking fine.' % (host, FETCHED[host]))


def check_scripts(problems):
    tags = script_tags(read('index.html'))
    referenced = [t['src'] for t in tags if t['src']]

    for src in referenced:
        if not os.path.exists(os.path.join(ROOT, src)):
            problems.append(
                'index.html loads %s, which does not exist. The browser 404s '
                'it and carries on without whatever was in it.' % src)

    for name in files_in('js', '.js'):
        if 'js/' + name not in referenced:
            problems.append(
                'js/%s exists but nothing in index.html loads it. Either it '
                'belongs in the ordered list, or it is dead and should go.'
                % name)

    # The scripts are not modules and share one global scope, so this order is
    # load-bearing rather than a convention: config.js and dom.js are read by
    # everything, and boot.js starts the page once the rest is defined.
    ordered = [t['src'] for t in tags if t['src'] and not t['async']]
    if ordered[:2] != ['js/config.js', 'js/dom.js']:
        problems.append(
            'The first two scripts in index.html are %s. They have to be '
            'js/config.js then js/dom.js - everything else reads them at load.'
            % (ordered[:2] or 'missing'))
    if ordered and ordered[-1] != 'js/boot.js':
        problems.append(
            'The last script loaded in order is %s, not js/boot.js. boot.js '
            'starts the page, so anything after it runs against a page that '
            'has already started.' % ordered[-1])


def check_styles(problems):
    referenced = re.findall(r'<link\b[^>]*href="([^"]+\.css)"',
                            read('index.html'))

    for href in referenced:
        if not os.path.exists(os.path.join(ROOT, href)):
            problems.append('index.html links %s, which does not exist.' % href)

    for name in files_in('css', '.css'):
        if 'css/' + name not in referenced:
            problems.append(
                'css/%s exists but index.html does not link it.' % name)


def check_demo_hatch(problems):
    """The banner demo hatch must never be committed.

    It makes the countdowns report any time you ask for, which is the one
    change that turns this site into a way to mislead somebody: a crafted link
    would show a relink that is not happening, with the real domain in the
    address bar. It lives in a patch outside the repository on purpose.
    """
    for name in files_in('js', '.js'):
        body = read('js/' + name)
        if 'TIMER_OVERRIDE' in body or re.search(r'\bdemo\b', body):
            problems.append(
                'js/%s mentions the banner demo hatch. That hatch stays in the '
                'patch outside this repository: committed, it lets anyone send '
                'a link that shows a relink which is not happening.' % name)


def main():
    problems = []
    for check in (check_hosts, check_scripts, check_styles, check_demo_hatch):
        check(problems)

    if problems:
        for problem in problems:
            print('::error::%s' % problem)
        print('')
        print('%d problem(s).' % len(problems))
        return 1

    print('%d scripts and %d stylesheets: all present, all referenced, and the '
          'load order holds.' % (len(files_in('js', '.js')),
                                 len(files_in('css', '.css'))))
    print('%d hosts in the tree: %d fetched and named in the CSP, %d mentioned '
          'only.' % (len(FETCHED) + len(MENTIONED), len(FETCHED),
                     len(MENTIONED)))
    print('No demo hatch in js/.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
