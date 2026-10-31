#!/usr/bin/env python3
"""Structural checks for the mistakes that fail silently in a site with no build.

Nothing in this file is shipped. Cloudflare publishes site/ and nothing
else, and this lives under .github/; it runs only in CI. It exists because the mistakes this project can actually make - a script missing from
index.html, a host missing from the Content Security Policy - fail *silently*
in production: the page looks completely fine and the feature simply does not
happen. No error, no test, nothing to notice until somebody reports it.

Run it by hand any time:  python .github/scripts/check-structure.py
"""

import datetime
import io
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# The folder Cloudflare publishes: every path below is relative to it.
SITE = os.path.join(ROOT, 'site')

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
    'docs.google.com': 'the three public spreadsheets',
    'render.guildwars2.com': 'guild emblem images',
    'static.cloudflareinsights.com': 'the Web Analytics beacon script',
    'cloudflareinsights.com': 'where the Web Analytics beacon reports',
}

MENTIONED = {
    'wvwrelink.com': 'canonical link and JSON-LD - the site naming itself',
    'schema.org': 'JSON-LD vocabulary, not a URL anything loads',
    'www.w3.org': 'SVG and XML namespaces',
    'wiki.guildwars2.com': 'a comment linking the published team names',
    'www.guildwars2.com': 'a comment link',
    'gw2mists.com': 'a comment link',
    'en.wikipedia.org': 'a comment link',
    'github.com': 'a comment link',
    'lucide.dev': 'a comment crediting an icon',
}


def read(rel):
    with io.open(os.path.join(SITE, rel), encoding='utf-8') as fh:
        return fh.read()


def files_in(directory, suffix):
    d = os.path.join(SITE, directory)
    return sorted(f for f in os.listdir(d) if f.endswith(suffix))


def script_tags(html):
    """Every <script> tag: its src, whether it is async, whether in <head>.

    Parsed rather than grepped: the JSON-LD block has no src at all, which a
    line-based grep trips over.
    """
    body = html.find('<body')
    out = []
    for m in re.finditer(r'<script\b[^>]*>', html):
        tag = m.group(0)
        src = re.search(r'\bsrc="([^"]+)"', tag)
        out.append({
            'src': src.group(1) if src else None,
            'async': re.search(r'\basync\b', tag) is not None,
            'head': m.start() < body,
        })
    return out


def csp_from_headers():
    """The Content-Security-Policy _headers sets for /*, or None."""
    rule = None
    for line in read('_headers').splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        if not line[0].isspace():
            rule = line.strip()
        elif rule == '/*':
            name, _, value = line.strip().partition(':')
            if name.strip().lower() == 'content-security-policy':
                return value.strip()
    return None


def check_hosts(problems):
    found = {}
    tree = ['index.html', '_headers'] \
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
            'requests it, add it to the Content Security Policy in _headers '
            'and to FETCHED in this file. If it is only mentioned in a comment '
            'or a namespace, add it to MENTIONED and leave the CSP alone.'
            % (host, where))

    # A header, not a <meta>: a <meta> policy holds back Chromium's preload
    # scanner and the scripts load one after another (_headers says more).
    if re.search(r'<meta[^>]*http-equiv="Content-Security-Policy"',
                 read('index.html'), re.I):
        problems.append(
            'index.html has a Content-Security-Policy <meta> tag again. The '
            'policy lives in _headers; a <meta> copy slows every load and is '
            'one more policy to keep in step.')

    policy = csp_from_headers()
    if not policy:
        problems.append(
            'No Content-Security-Policy under /* in _headers. That policy is '
            'what denies everything by default, so this is either a typo in '
            'the file or something much worse.')
        return

    # Cloudflare's limit per _headers line (developers.cloudflare.com/workers/
    # static-assets/headers/); the whole policy is one line and grows by host.
    longest = max(len(line) for line in read('_headers').splitlines())
    if longest > 2000:
        problems.append(
            'A line in _headers is %d characters; Cloudflare allows 2,000. '
            'The Content Security Policy is one line and grows with every '
            'host.' % longest)
    # With the scheme, so cloudflareinsights.com is not found inside
    # static.cloudflareinsights.com.
    for host in sorted(FETCHED):
        if 'https://' + host not in policy:
            problems.append(
                '%s is fetched (%s) but is not named in the Content Security '
                'Policy, so the browser blocks it - quietly, with the page '
                'looking fine.' % (host, FETCHED[host]))

    # The page's own /api is reached by path, with no host for the loop above
    # to find, and connect-src names hosts only: without 'self' there the
    # browser blocks it and every read quietly falls back to the sheets.
    own = sorted(rel for rel in tree if rel.startswith('js/')
                 and re.search(r"'/api/", read(rel)))
    connect = re.search(r'connect-src([^;]*)', policy)
    if own and not (connect and "'self'" in connect.group(1).split()):
        problems.append(
            "%s reads this site's own /api, but connect-src in the Content "
            "Security Policy does not say 'self', so the browser blocks it."
            % ', '.join(own))


def check_scripts(problems):
    tags = script_tags(read('index.html'))
    referenced = [t['src'] for t in tags if t['src']]

    # A script from another host is check_hosts' business, not a file here.
    for src in referenced:
        if src.startswith('https://'):
            continue
        if not os.path.exists(os.path.join(SITE, src)):
            problems.append(
                'index.html loads %s, which does not exist. The browser 404s '
                'it and carries on without whatever was in it.' % src)

    # A script loaded later by another one (js/maps.js, by js/maps-early.js)
    # is named there as a quoted path; it runs after everything in index.html.
    late = set()
    for src in referenced:
        if src.startswith('js/') and os.path.exists(os.path.join(SITE, src)):
            late.update(re.findall(r"'(js/[\w.-]+\.js)'", read(src)))
    for src in sorted(late):
        if not os.path.exists(os.path.join(SITE, src)):
            problems.append(
                'A script loads %s later, but it does not exist. The browser '
                '404s it and whatever needed it never works.' % src)
    for name in files_in('js', '.js'):
        if 'js/' + name not in referenced and 'js/' + name not in late:
            problems.append(
                'js/%s exists but nothing in index.html loads it. Either it '
                'belongs in the ordered list, or it is dead and should go.'
                % name)

    # The scripts are not modules and share one global scope, so this order is
    # load-bearing rather than a convention: config.js and dom.js are read by
    # everything, and boot.js starts the page once the rest is defined.
    # A script in <head> (js/region.js) runs before config.js and reads
    # nothing from the others; the order is the <body>'s.
    ordered = [t['src'] for t in tags
               if t['src'] and not t['async'] and not t['head']]
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
        if not os.path.exists(os.path.join(SITE, href)):
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


def check_notice_position(problems):
    """#teamsNotice has to be the first element in the body.

    It is a sticky bar. sticky measures from where an element really sits in the
    document rather than from where it ends up painted, so moved down under the
    scenery it would not be at the top of a freshly loaded page at all - it
    would pin only once you had scrolled past where it lives, which is an
    announcement you have to go and find. Moved inside anything with overflow
    set it would not pin at all.

    Both failures are silent in the way this whole file is about: the page looks
    perfectly fine, the bar is simply somewhere useless, and the only days
    anybody could notice are the days a relink is happening.
    """
    html = read('index.html')
    body = re.search(r'<body[^>]*>', html)
    if not body:
        problems.append(
            'No <body> tag in index.html, so where the teams notice sits could '
            'not be checked. That is a much bigger problem than this check.')
        return

    # Comments and blank lines in front of it are fine. The first *element* is
    # not, whatever it is.
    rest = re.sub(r'<!--.*?-->', '', html[body.end():], flags=re.S).lstrip()
    first = re.match(r'<([a-zA-Z][^\s>/]*)([^>]*)>', rest)
    if not first or 'id="teamsNotice"' not in first.group(2):
        found = ('<%s>' % first.group(1)) if first else '(no element at all)'
        problems.append(
            'The first element in the body of index.html is %s, not the teams '
            'notice. #teamsNotice has to come first: it is position:sticky, and '
            'sticky measures from where an element really sits - anywhere '
            'further down and the bar is not at the top of a freshly loaded '
            'page, it only pins after you scroll past it. Inside anything with '
            'overflow set it does not pin at all. Neither failure produces an '
            'error.' % found)


def check_sitemap(problems):
    """Is sitemap.xml's lastmod a date at all, and not in the future?

    Not "is it current": lastmod means a significant change to the content,
    and whether a change was significant is a human call.
    What needs no judgement is a lastmod that is malformed or in the future,
    which a crawler may drop outright.
    """
    found = re.search(r'<lastmod>([^<]+)</lastmod>', read('sitemap.xml'))
    if not found:
        # Absent is fine: lastmod is optional in the protocol, and no date is
        # better than a date nobody trusts. Nothing to check.
        return

    stamp = found.group(1).strip()
    try:
        said = datetime.date(*time.strptime(stamp, '%Y-%m-%d')[:3])
    except (ValueError, TypeError):
        problems.append(
            'sitemap.xml has <lastmod>%s</lastmod>, which is not a YYYY-MM-DD '
            'date. A crawler can drop a sitemap it cannot parse, and it does '
            'not tell anybody.' % stamp)
        return
    if said > datetime.date.today():
        problems.append(
            'sitemap.xml claims the page last changed on %s, which is in the '
            'future. Nothing is served differently; the date is simply not '
            'believable, which is how the field stops counting.' % stamp)


def readme_table(header):
    """First-column cells of the README table whose header row starts with
    `header`, as the text inside each backtick pair."""
    with io.open(os.path.join(ROOT, 'README.md'), encoding='utf-8') as fh:
        lines = fh.read().splitlines()
    cells = []
    for i, line in enumerate(lines):
        if line.startswith('| ' + header + ' |'):
            for row in lines[i + 2:]:
                if not row.startswith('|'):
                    break
                cells.append(re.findall(r'`([^`]+)`', row.split('|')[1]))
            break
    return cells


def storage_keys(problems):
    """Keys js/ passes to localStorage or sessionStorage, constants resolved.

    A key that does not resolve to a fixed text is a problem of its own: the
    README table could not be compared against it.
    """
    bodies = dict((n, read('js/' + n)) for n in files_in('js', '.js'))
    keys = {'written': set(), 'read': set()}

    def fixed(arg):
        arg = arg.strip()
        quoted = re.fullmatch(r"""(['"`])([^'"`$\\]+)\1""", arg)
        if quoted:
            return quoted.group(2)
        if re.fullmatch(r'[A-Za-z_$][\w$]*', arg):
            for body in bodies.values():
                const = re.search(r'\b' + re.escape(arg)
                                  + r"""\s*=\s*(['"`])([^'"`$\\]+)\1\s*[;,\n]""",
                                  body)
                if const:
                    return const.group(2)
        return None

    uses = (
        (r'\b(?:local|session)Storage\s*\.\s*(get|set|remove)Item\(\s*'
         r'([^,)]*)', None),
        (r'\b(?:local|session)Storage\s*\[\s*([^\]]*)\]\s*(=(?!=))?', 'index'),
    )
    for name, body in sorted(bodies.items()):
        for m in re.finditer(uses[0][0], body):
            note(keys, problems, name, m.group(2), m.group(1) == 'set', fixed)
        for m in re.finditer(uses[1][0], body):
            note(keys, problems, name, m.group(1), m.group(2) is not None, fixed)
        for m in re.finditer(r'\b(?:local|session)Storage\.(?!(?:get|set|remove)'
                             r'Item\b|clear\b|key\b|length\b)\w+\s*=(?!=)', body):
            problems.append(
                'js/%s assigns a storage key by property (%s). Use setItem '
                'with a fixed key so the README key table can be compared.'
                % (name, m.group(0)))
    return keys


def note(keys, problems, name, arg, writes, fixed):
    key = fixed(arg)
    if key is None:
        problems.append(
            'js/%s passes %r as a storage key and this check cannot read it '
            'as a fixed text. Use a quoted string or a const with one, so '
            'the README key table can be compared.' % (name, arg.strip()))
        return
    keys['read'].add(key)
    if writes:
        keys['written'].add(key)


def check_readme(problems):
    """The Privacy tables in README.md name every fetched host and every key.

    A host in FETCHED must be in the host table, a key js/ writes must be in
    the key table, and the key table may name nothing js/ does not use.
    """
    listed = set()
    for cells in readme_table('Host'):
        for cell in cells:
            listed.add(cell.split('/')[0])
    for host in sorted(set(FETCHED) - listed):
        problems.append(
            'README.md Privacy host table does not list %s, which the page '
            'fetches (%s). The table is the promise to visitors.'
            % (host, FETCHED[host]))

    named = set(c for cells in readme_table('Key') for c in cells)
    keys = storage_keys(problems)
    for key in sorted(keys['written'] - named):
        problems.append(
            'js/ writes the localStorage key %s but the README.md Privacy key '
            'table does not list it.' % key)
    for key in sorted(named - keys['read'] - keys['written']):
        problems.append(
            'The README.md Privacy key table lists %s, which no file in js/ '
            'uses.' % key)


def sitemap_note():
    """What the sitemap says, for the summary - so a silent check leaves proof.

    check_sitemap passes quietly on anything it is allowed to accept, and a check
    that prints nothing when it is happy is one nobody can tell ran at all.
    """
    found = re.search(r'<lastmod>([^<]+)</lastmod>', read('sitemap.xml'))
    if not found:
        return ('sitemap.xml carries no <lastmod>, which is allowed - the tag is '
                'optional.')
    return ('sitemap.xml says the page last changed on %s; bump it only for a '
            'change to the content, the JSON-LD or the links.'
            % found.group(1).strip())


def job_timeout(rel, job):
    """The timeout-minutes of one job, read from the workflow's text."""
    path = os.path.join(ROOT, '.github', 'workflows', rel)
    with io.open(path, encoding='utf-8') as fh:
        lines = fh.read().splitlines()
    inside = False
    for line in lines:
        if re.match(r'  %s:\s*$' % re.escape(job), line):
            inside = True
        elif inside and re.match(r'  \S', line):
            break
        elif inside:
            m = re.match(r'    timeout-minutes:\s*(\d+)\s*$', line)
            if m:
                return int(m.group(1))
    return None


def check_sweep_timeout(problems):
    """The coverage sweep's run job must not time out before the suite does.

    It runs the same suite as the e2e job of checks.yml, so the two timeouts
    must be equal: a lower one cancels every round of the sweep.
    """
    found = {}
    for rel, job in (('checks.yml', 'e2e'), ('coverage-sweep.yml', 'run')):
        found[rel] = job_timeout(rel, job)
        if found[rel] is None:
            problems.append(
                'workflows/%s: no "timeout-minutes: N" found directly under '
                'the %s job.' % (rel, job))
    a, b = found['checks.yml'], found['coverage-sweep.yml']
    if None not in (a, b) and a != b:
        problems.append(
            'coverage-sweep.yml run has timeout-minutes %d but the e2e job of '
            'checks.yml has %d: the sweep runs the same suite and must have '
            'the same timeout.' % (b, a))


def main():
    problems = []
    for check in (check_hosts, check_scripts, check_styles, check_demo_hatch,
                  check_notice_position, check_sitemap, check_readme,
                  check_sweep_timeout):
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
    print('The teams notice is the first element in the body.')
    print('The sweep and the e2e job share one timeout.')
    print(sitemap_note())
    return 0


if __name__ == '__main__':
    sys.exit(main())
