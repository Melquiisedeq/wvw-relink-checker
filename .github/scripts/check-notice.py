#!/usr/bin/env python3
"""Did the teams notice actually happen for the last relink?

The notice is meant to appear every month, in the days between the season
lockout closing and the relink landing. A month where it did not appear is a
bug, not weather - so this asserts the thing itself rather than any symptom of
it, and it runs on a schedule so the answer arrives by email instead of waiting
to be noticed.

How it can be asked at all: the relink tab of this project's sheet holds
"window:published" - the relink the notice last fired for, and when - and the
API holds teamAssignment, the relink coming next. In a healthy month those are
exactly one cycle apart: the notice fired for the last relink, and the next one
is about thirty days out. Two cycles apart means a relink went by with no
notice.

A missed window fails this check for twelve hours after the relink it lost and
then goes quiet - see MISSED_ALARM_SECONDS. Nothing about a month that already
ended is actionable, and an alarm repeating for four weeks is an alarm that
teaches you to filter the sender.

That question can only be answered once a month, though, and the answer arrives
six weeks after the fault. So the cell beside it, relink!A2, holds a heartbeat:
the trigger stamps the time there before it does anything else, on every run, in
and out of the window. A stale one says the trigger is not firing - and says it
the same day instead of after the window it was going to miss.

The two are deliberately different questions. The heartbeat asks whether the
script RUNS, which nothing else on earth can see: a deleted trigger, a locked
account, a lapsed authorisation and a project Google disabled all produce no
execution, no log and no email. A script that runs and then fails is already
loud, because Apps Script emails the owner on an uncaught exception. The gap
asks whether a run that happened actually produced the notice.

Everything the two of them catch, all of which is otherwise silent:

  - the Apps Script trigger stopped, deleted, or never firing       (heartbeat)
  - the Google account locked, or its authorisation lapsed          (heartbeat)
  - the spreadsheet unreachable or unwritable                       (heartbeat)
  - the threshold never tripping, because ArenaNet changed how it publishes
  - the assignment being published outside the window the trigger watches
  - the cell being overwritten by hand, or written in a shape the page rejects
  - the sheet not being shared, which only a reader can ever notice

It is the counterpart of check-sheets.py, which asks whether the kills history
is still being written. Same failure mode, same reason it needs asking: a
stopped trigger makes no noise at all.

Run it by hand any time:  python .github/scripts/check-notice.py
"""

import calendar
import io
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.guildwars2.com/v2'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Read out of js/config.js rather than repeated here. The page and this check
# have to be looking at the same cell, and a second copy of the URL is a second
# thing to keep in step.
SHEET_URL_LINE = re.compile(
    r'const RELINK_SHEET_URL\s*=\s*\n?\s*`([^`]+)`', re.M)
# Must match RELINK_STATE_RE in js/relink.js: what the page will accept is what
# counts as the notice having fired.
STATE_CELL = re.compile(r'^"?(\d{1,12}):(\d{1,12})"?$')

# One relink cycle is a month, so one is about thirty days and two about sixty.
# Forty-five sits between them with room on both sides.
MAX_GAP_SECONDS = 45 * 24 * 60 * 60

# The heartbeat: one epoch integer in A2, written by the trigger every 15
# minutes. Must match the strictness of the state cell for the same reason - the
# sheet is world-readable and anything else in there is not a timestamp.
HEARTBEAT_CELL = re.compile(r'^"?(\d{1,12})"?$')

# Twelve missed ticks. Deliberately not tighter, and the reason is that tighter
# buys nothing: this check runs every six hours, so what decides how fast a dead
# trigger is caught is that schedule and not this number. Under six hours they
# detect the same fault at the same moment - all a tight threshold adds is
# failing on ordinary Apps Script jitter and the occasional tick Google skips
# under quota. So: loose enough to never cry wolf, which is what makes the email
# worth opening.
MAX_SILENCE_SECONDS = 3 * 60 * 60

# How long a missed window keeps failing this check after the relink it lost.
#
# The fault is only *visible* once the relink has gone by - up to that moment
# "the table has not moved yet" is also the normal state of a healthy window. So
# it cannot be reported while it is still fixable, and once it can be reported
# there is nothing left to do about it: that month's notice is gone. What is
# left is telling somebody, and telling somebody does not improve with
# repetition.
#
# Left unbounded it would fail every six hours until the next window opens -
# about 27 days, 108 emails, all of them the same sentence about a month that
# ended. Twelve hours is two runs of this workflow: two, rather than one, so a
# single run that fails for an unrelated reason does not swallow the only
# notification there will be. After that the line stays in the log and the check
# goes quiet.
#
# It does not make anything silent that can still be acted on. A trigger that is
# actually dead keeps failing this check for as long as it is dead, through the
# heartbeat above, which is the part somebody can go and fix.
MISSED_ALARM_SECONDS = 12 * 60 * 60


def fetch(url):
    """GET and return (text, error). Retries before giving up."""
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'wvwrelink-notice-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return res.read().decode('utf-8', 'replace'), None
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, '%s after %d attempts' % (last, ATTEMPTS)


def iso(epoch):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(epoch))


def sheet_url():
    """The relink cell's CSV export, exactly as js/config.js builds it.

    Read out of config.js rather than repeated here: the page and this check
    have to be looking at the same cell, and a second copy of the URL is a
    second thing to keep in step. The template's own `${NAME}` is looked up
    rather than assumed, so renaming that constant fails loudly here instead of
    quietly checking the wrong sheet.
    """
    with io.open(os.path.join(ROOT, 'site', 'js', 'config.js'), encoding='utf-8') as fh:
        config = fh.read()
    found = SHEET_URL_LINE.search(config)
    if not found:
        return None
    url = found.group(1)
    for name in re.findall(r'\$\{([A-Z_]+)\}', url):
        value = re.search(
            r'const %s\s*=\s*\'([^\']+)\'' % re.escape(name), config)
        if not value:
            return None
        url = url.replace('${%s}' % name, value.group(1))
    return url


def next_relink():
    """The NA teamAssignment, in epoch seconds, or (None, error)."""
    body, error = fetch(API + '/wvw/timers/teamAssignment')
    if error:
        return None, error
    found = re.search(r'"na"\s*:\s*"([0-9TZ:-]+)"', body or '')
    if not found:
        return None, 'no readable na field'
    try:
        # timegm, not mktime: the timestamp is UTC and mktime would read it as
        # local time, shifting the answer by hours on any machine that is not
        # the runner.
        return calendar.timegm(
            time.strptime(found.group(1), '%Y-%m-%dT%H:%M:%SZ')), None
    except ValueError as exc:
        return None, str(exc)


def heartbeat_url(page_url):
    """The A2 of the same tab, derived from the URL the page itself uses.

    Derived rather than written out again: there is one spreadsheet id and one
    tab name in this project, and a second copy of either is a second thing that
    can drift. If the page's URL stops asking for a single cell this returns
    None and says so loudly, because that case is not "the heartbeat moved" - it
    is the page reading a range that now has two rows in it.
    """
    if 'range=A1:A1' not in page_url:
        return None
    return page_url.replace('range=A1:A1', 'range=A2:A2')


def check_heartbeat(page_url, now):
    """Is the trigger running at all? True means something is wrong.

    Reported rather than returned as a single verdict, and it does not stop the
    rest of the check: a dead trigger and a missed window are cause and effect,
    and seeing both in one email is what makes the cause obvious.
    """
    url = heartbeat_url(page_url)
    if url is None:
        print('::error::RELINK_SHEET_URL in js/config.js no longer asks for '
              'range=A1:A1, so the heartbeat cell beside it cannot be found. '
              'That range is not tidiness: without it the heartbeat row lands '
              'inside what the page reads, and the page refuses a body with two '
              'rows in it. Put it back, or teach this check where the heartbeat '
              'moved to.')
        return True

    body, error = fetch(url)
    if error:
        print('::error::The heartbeat cell did not answer (%s). The state cell '
              'beside it answered a moment ago, so this is something about that '
              'one cell rather than the sheet being down.' % error)
        return True

    found = HEARTBEAT_CELL.match((body or '').strip())
    if not found:
        shown = (body or '').strip()[:80] or '(empty)'
        print('::error::The heartbeat cell holds no timestamp. It holds: %s.'
              % shown)
        print('::error::If it is empty, the script in the Apps Script project '
              'is older than the heartbeat: paste the current '
              '_source/relink-notice.gs in and run relinkTick once by hand. If '
              'it holds something else, it was written over.')
        return True

    beat = int(found.group(1))
    age = now - beat
    print('last tick      %s, %d min ago' % (iso(beat), age // 60))
    if age <= MAX_SILENCE_SECONDS:
        return False

    print('')
    print('::error::The Apps Script trigger has not run for %d minutes and is '
          'supposed to run every 15. It stamps that cell before it does '
          'anything else, so this is not the API failing, not the threshold '
          'refusing to trip and not the sheet being unwritable - it is the '
          'trigger itself not firing. A deleted trigger, a locked account, an '
          'authorisation that lapsed, or a project Google disabled: none of '
          'those produce an execution, a log or an email, and this cell is the '
          'only place any of them shows. Open the Apps Script project for the '
          'account that owns the sheet and look at Triggers, then Executions.'
          % (age // 60))
    return True


def main():
    now = int(time.time())
    print('read at        %s' % iso(now))

    url = sheet_url()
    if url and 'PASTE' in url:
        print('::error::RELINK_SHEET_ID in js/config.js is still the '
              'placeholder, so the page has no cell to read and the notice can '
              'never appear. Paste the spreadsheet id there and into SHEET_ID '
              'in the Apps Script.')
        return 1
    if url is None:
        print('::error::RELINK_SHEET_URL or RELINK_SHEET_ID could not be read '
              'out of js/config.js, so this cannot tell which cell the page is '
              'looking at. One of the two was renamed; this check has to be '
              'taught the new name.')
        return 1

    assign_na, error = next_relink()
    if error:
        print('::error::The teamAssignment timer did not answer (%s), so there '
              'is nothing to measure the notice against. This is about the API, '
              'not about the notice.' % error)
        return 1
    print('next relink    %s' % iso(assign_na))

    body, error = fetch(url)
    if error:
        print('::error::The relink tab of the sheet did not answer (%s). The '
              'page reads that same cell, so while this is true the notice '
              'cannot appear at all.' % error)
        # 401 and 403 are not "the sheet is broken", they are "the sheet is not
        # published", and that is worth saying out loud: the Apps Script that
        # writes the cell runs as the sheet's owner and works perfectly either
        # way, so this is a failure only the reader ever sees. Which is to say:
        # it looks like nothing is wrong right up until the notice does not
        # appear.
        if 'HTTP 401' in error or 'HTTP 403' in error:
            print('::error::That is an authorisation failure, not a missing '
                  'cell: the spreadsheet is not shared. Set it to "anyone with '
                  'the link" as VIEWER - never Editor, since whoever can write '
                  'that cell decides what the page tells people about their '
                  'teams.')
        return 1

    found = STATE_CELL.match((body or '').strip())
    if not found:
        shown = (body or '').strip()[:80] or '(empty)'
        print('::error::The relink cell does not hold two integers separated by '
              'a colon. It holds: %s. The page refuses anything else, so while '
              'this is true the notice cannot appear.' % shown)
        # The gviz export does not 404 a tab that is not there - it serves the
        # first sheet instead. So the likeliest cause looks like data rather
        # than like an error, and it is worth naming before anybody goes
        # hunting through the Apps Script.
        print('::error::If that looks like the kills history, the tab named in '
              'RELINK_SHEET_URL does not exist under that name: the CSV export '
              'answers with the first sheet rather than failing. Otherwise '
              'check what the Apps Script trigger is writing.')
        return 1

    window, published = int(found.group(1)), int(found.group(2))
    if published:
        print('last notice    %s, for the relink of %s'
              % (iso(published), iso(window)))
    else:
        # "nothing yet", not "never": the cell holds only the window it is about,
        # so a new window resets this to 0 and the earlier months are not in it.
        print('last notice    nothing for this window yet')

    # Asked after the state cell so that the sharing diagnosis above gets first
    # word on an unreachable sheet, and before the reasoning below so that a
    # dead trigger is named before the month it is about to cost.
    beat_bad = check_heartbeat(url, now)

    # Nothing has fired yet, which is the honest state of a freshly shipped
    # feature. There is no earlier timestamp to measure from, so the only thing
    # that can be said is whether a relink has gone by: `window` is written by
    # the trigger the first time it runs inside a window, so a zero published
    # with a window already in the past means that window produced nothing.
    if not published:
        if window and window < now:
            missed_for = now - window
            if missed_for <= MISSED_ALARM_SECONDS:
                print('')
                print('::error::The relink of %s has gone by and the notice '
                      'never fired for it. This is a bug, not a quiet month: '
                      'the trigger was watching, so either the threshold never '
                      'tripped or the assignment was published outside the '
                      'window it watches. Check the Apps Script executions for '
                      'that account.' % iso(window))
                return 1
            # Past the alarm window. Said plainly and without failing: the month
            # is gone, nothing about it is actionable now, and the next window
            # rewrites this cell and starts the feature over. See
            # MISSED_ALARM_SECONDS.
            print('')
            print('The relink of %s went by with no notice, %d days ago - '
                  'reported at the time, and nothing can be done about that '
                  'month now. The next window starts clean.'
                  % (iso(window), missed_for // 86400))
            return 1 if beat_bad else 0
        print('')
        # Deliberately not "the notice has never fired". The cell only ever holds
        # the window it is currently about, so once a new window opens the
        # trigger resets published to 0 and every earlier month is gone from it.
        # Saying "never" would therefore be wrong from the second month onward,
        # every month, for the four days a window is open.
        if window:
            print('Nothing published for the relink of %s yet, which is the '
                  'normal state until the table moves. No relink has gone by '
                  'unannounced.' % iso(window))
        else:
            print('No window is being watched yet - run relinkSetup() once.')
        return 1 if beat_bad else 0

    gap = assign_na - window
    print('')
    print('%d days between the notice last firing and the next relink.'
          % (gap // 86400))

    if gap > MAX_GAP_SECONDS:
        print('::error::A relink has gone by without the teams notice '
              'appearing. It last fired for the relink of %s and the next is '
              '%s - that is %d days, so at least one whole window was missed. '
              'This is a bug, not a quiet month. Start at the Apps Script '
              'executions for the account that owns the sheet: a stopped '
              'trigger is the most likely cause and it stops silently.'
              % (iso(window), iso(assign_na), gap // 86400))
        return 1

    print('The notice fired for the most recent relink.')
    return 1 if beat_bad else 0


if __name__ == '__main__':
    sys.exit(main())
