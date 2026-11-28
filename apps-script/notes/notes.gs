/**
 * The game's update notes, for wvwrelink.com.
 * ---------------------------------------------------------------------------
 * A STANDALONE project (script.google.com > New project), bound to no file, with a
 * time-driven trigger on notesTick() every 6 hours. Its one scope, external requests, is
 * pinned in appsscript.json (check-structure.mjs).
 *
 * Every 6 hours it reads the wiki's Game_updates page, which shows its five newest update pages,
 * takes the lines about World vs. World, and sends them to wvwrelink.com/api, signed. The
 * Worker takes nothing on trust: it checks every field again before it publishes a line.
 * Once, by hand, notesSeed() adds the pages the index no longer lists: the month pages the index
 * links (Game_updates/November_2026) hold every update of their month.
 *
 * Why this script and not the Worker: the wiki refuses requests from Cloudflare's network.
 * Only /wiki/ is read (the wiki's robots.txt), under a User-Agent that says who we are.
 *
 * Exactly four names are global, three only because they are run by name:
 *
 *   notesTick    the function the trigger calls
 *   notesSecret  the function you run once, by hand
 *   notesSeed    the function you run once more, by hand, after notesSecret
 *   Notes_       everything else, private inside it
 * ---------------------------------------------------------------------------
 */

/** The function the trigger calls. Every 6 hours. */
function notesTick() {
  Notes_.tick();
}

/**
 * Run once by hand. Creates the secret the messages to wvwrelink.com/api are
 * signed with and logs it this once, to be pasted into the Worker's
 * INGEST_NOTES secret and nowhere else. Until it exists nothing is sent.
 * To change it: delete the "ingest" script property, run this again, paste.
 */
function notesSecret() {
  Notes_.secret();
}

/**
 * Run once by hand, after notesSecret() and the secret is in the Worker: sends the index's pages
 * together with the older update pages of the last SEED_DAYS days, which the index no longer lists
 * and notesTick() will never read. Safe to run again.
 */
function notesSeed() {
  Notes_.seed();
}


var Notes_ = (function () {
  'use strict';

  var WIKI = 'https://wiki.guildwars2.com';
  var INDEX = WIKI + '/wiki/Game_updates';
  var USER_AGENT = 'wvwrelink-notes (+https://wvwrelink.com)';
  var INGEST = 'https://wvwrelink.com';
  var INGEST_PATH = '/api/ingest/notes';
  // Each request is tried this many times, waiting longer each time; the next run is 6 hours on.
  var TRIES = 3;
  var WAIT_MS = 3000;
  // The Worker cuts each line to 300 characters itself, after it has read the whole line (whether it
  // is about WvW, its type); it refuses one over MAX_LINE, and keeps MAX_PER_NOTE lines of a note.
  var MAX_LINE = 2000;
  var MAX_PER_NOTE = 60;
  // The text under an update's heading before its first section, enough for the Worker to tell a
  // release from a hotfix by.
  var MAX_LEAD = 200;
  // The Worker refuses a message over 64 KB.
  var MAX_BODY = 60000;
  // The Worker refuses a message of more notes than this.
  var MAX_NOTES = 20;
  var SEED_DAYS = 60;
  var PAGE_SKEW_DAYS = 3;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  var UPDATE_RE = /^(?:Update(?: [2-9])?|Late Notes) - ([A-Z][a-z]+) (\d{1,2}), (20\d\d)$/;
  var PAGE_HREF_RE = /^\/wiki\/Game_updates\/(20\d\d-\d\d-\d\d)$/;
  var MONTH_HREF_RE = /^\/wiki\/Game_updates\/([A-Z][a-z]+)_(20\d\d)$/;
  var WVW_RE = /\bWvW\b|World vs\. World|World vs|War Score|Borderlands|Eternal Battlegrounds|skirmish|dolyak|\bsiege\b|Stonemist|\bkeeps?\b|\bsentry\b|Obsidian Sanctum|Edge of the Mists|\brelink/;
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };


  function decode(s) {
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, function (all, e) {
      if (e.charAt(0) !== '#') return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : all;
      var cp = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '';
    });
  }

  function attrs(tag) {
    var out = {};
    var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    var m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[2]);
    return out;
  }

  /**
   * Every list item of the page's article, with the headings above it: the wiki's
   * structure, read as text. {rows: [{h2, h3, sub, text, link, icon, toc, parent}], pages: [names], months: [hrefs],
   * leads: {h2: text}}: sub is the deepest heading under the h3 (the elite specialization, else the
   * profession); a lead, the text after an h2 and before the next heading, outside the lists.
   * Text only: tags are dropped, entities decoded; the article ends at the parser's report.
   */
  function parse(html) {
    var on = false, stop = false, inh = null, hbuf = '';
    var hl = {}, lis = [], rows = [], pages = [], months = [], leads = {}, lead = null;
    var at = 0;
    function data(d) {
      if (!on || stop) return;
      d = decode(d);
      if (inh) hbuf += d;
      if (lis.length) lis[lis.length - 1].text += d;
      else if (lead !== null && !inh && leads[lead].length < MAX_LEAD * 2) leads[lead] += d;
    }
    while (at < html.length && !stop) {
      var lt = html.indexOf('<', at);
      if (lt < 0) { data(html.slice(at)); break; }
      if (lt > at) data(html.slice(at, lt));
      if (html.substr(lt, 4) === '<!--') {
        var endc = html.indexOf('-->', lt + 4);
        if (endc < 0) break;
        if (on && html.slice(lt + 4, endc).indexOf('NewPP') >= 0) stop = true;
        at = endc + 3;
        continue;
      }
      var gt = html.indexOf('>', lt);
      if (gt < 0) break;
      var tag = html.slice(lt + 1, gt);
      at = gt + 1;
      var close = tag.charAt(0) === '/';
      var name = (/^\/?([a-zA-Z0-9]+)/.exec(tag) || [])[1];
      if (!name) continue;
      name = name.toLowerCase();
      if (close) {
        if (!on) continue;
        if (name === inh) {
          hl[inh] = hbuf.trim();
          for (var l = Number(inh.charAt(1)) + 1; l <= 5; l++) delete hl['h' + l];
          // An h2 repeated on the page keeps the first lead with text.
          if (inh === 'h2' && !(Object.prototype.hasOwnProperty.call(leads, hl.h2) && leadText(leads[hl.h2]))) {
            lead = hl.h2;
            leads[lead] = '';
          }
          inh = null;
        } else if (name === 'li' && lis.length) {
          var c = lis.pop();
          c.text = c.text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
          rows.push(c);
        }
        continue;
      }
      // Their content is not markup: skipped whole, up to their end tag.
      if (name === 'style' || name === 'script') {
        var end = html.indexOf('</' + name, at);
        if (end < 0) break;
        at = end;
        continue;
      }
      var a = attrs(tag);
      if (name === 'a' && a.href && PAGE_HREF_RE.test(a.href)) pages.push(PAGE_HREF_RE.exec(a.href)[1]);
      if (name === 'a' && a.href && MONTH_HREF_RE.test(a.href) && months.indexOf(a.href) < 0) months.push(a.href);
      if ((a['class'] || '').indexOf('mw-parser-output') >= 0) on = true;
      if (!on || stop) continue;
      if (/^h[2-5]$/.test(name)) {
        lead = null;
        inh = name;
        hbuf = '';
      } else if (name === 'li') {
        if (lis.length) lis[lis.length - 1].parent = true;
        lis.push({ h2: hl.h2 || '', h3: hl.h3 || '', sub: hl.h5 || hl.h4 || '', text: '', link: null, icon: false, toc: false, parent: false });
      } else if (lis.length) {
        var cur = lis[lis.length - 1];
        if (name === 'a' && cur.link === null && a.href && a.href.indexOf('/wiki/') === 0) cur.link = a.href.slice(6);
        if (name === 'img') cur.icon = true;
        if ((a['class'] || '').indexOf('toc') >= 0) cur.toc = true;
      }
    }
    return { rows: rows, pages: pages, months: months, leads: leads };
  }

  // The section's own edit link, which a transcluded section shows after its heading, is not its text.
  function leadText(s) {
    return s.replace(/\s+/g, ' ').trim().replace(/^\[ ?edit ?\] ?/, '');
  }

  function dayOf(update) {
    var m = UPDATE_RE.exec(update);
    if (!m) return null;
    var mo = MONTHS.indexOf(m[1]);
    if (mo < 0) return null;
    return new Date(Date.UTC(Number(m[3]), mo, Number(m[2]))).toISOString().slice(0, 10);
  }

  // The page a day's notes sit on: the one of that date, else the nearest within a few days.
  function pageOf(day, pages) {
    var best = null, bestGap = Infinity;
    pages.forEach(function (p) {
      var gap = Math.abs(Date.parse(p + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 864e5;
      if (gap <= PAGE_SKEW_DAYS && gap < bestGap) { best = p; bestGap = gap; }
    });
    return best;
  }

  function cut(t) {
    var cps = Array.from(t);
    return cps.length <= MAX_LINE ? t : cps.slice(0, MAX_LINE - 1).join('') + '…';
  }

  function linkName(href) {
    if (href === null) return null;
    try {
      return decodeURIComponent(href).replace(/_/g, ' ').replace(/#.*$/, '');
    } catch (e) {
      return null;
    }
  }

  /**
   * The notes of a page: [{page, update, lead, lines: [{section, sub, text, link, icon}]}], one per
   * update (h2) in page order, each update's WvW lines. `pages`: the page names the notes may
   * sit on (the index's own list, or the one page read).
   */
  function notes(html, pages) {
    var p = parse(html);
    var list = pages || p.pages;
    var out = [], byUpdate = {};
    p.rows.forEach(function (r) {
      if (r.toc || r.parent || !r.text) return;
      if (r.h2 === 'Contents' || r.h2.indexOf('Preview') >= 0) return;
      if (r.h3.indexOf('Guild Wars 2 Wiki Notes') === 0) return;
      var day = dayOf(r.h2);
      if (!day) return;
      if (!byUpdate[r.h2]) {
        var page = pageOf(day, list);
        if (!page) return;
        var lead = Array.from(leadText(p.leads[r.h2] || '')).slice(0, MAX_LEAD).join('');
        byUpdate[r.h2] = { page: page, update: r.h2, lead: lead, lines: [] };
        out.push(byUpdate[r.h2]);
      }
      var n = byUpdate[r.h2];
      if (!(WVW_RE.test(r.text) || r.h3.indexOf('World vs') === 0)) return;
      if (n.lines.length >= MAX_PER_NOTE) return;
      n.lines.push({ section: r.h3, sub: r.sub, text: cut(r.text), link: linkName(r.link), icon: r.icon });
    });
    // An update with no WvW line is sent too: the Worker deletes an update the pages it was sent
    // no longer have, and keeps those of a page it was not sent only when that page is older than
    // every page sent (fit leaves out the oldest first).
    return out;
  }

  function hex(bytes) {
    return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }

  // A request tried up to TRIES times while it fails or answers 5xx (UrlFetchApp never retries).
  function fetchTried(url, opt) {
    var last = null;
    for (var i = 0; i < TRIES; i++) {
      if (i) Utilities.sleep(WAIT_MS * i);
      try {
        last = UrlFetchApp.fetch(url, opt);
        if (last.getResponseCode() < 500) return last;
      } catch (e) {
        last = e;
      }
    }
    return last;
  }

  // The message, at most MAX_NOTES notes and MAX_BODY bytes: the oldest pages leave first (they were
  // sent in earlier runs), each one whole, or the Worker would delete the updates left out of a page it was sent.
  function fit(list) {
    var body = JSON.stringify({ v: 1, notes: list });
    while (list.length > MAX_NOTES || Utilities.newBlob(body).getBytes().length > MAX_BODY) {
      var oldest = list[list.length - 1].page;
      var rest = list.filter(function (n) { return n.page !== oldest; });
      if (!rest.length) break;
      list = rest;
      body = JSON.stringify({ v: 1, notes: list });
    }
    return { list: list, body: body };
  }

  function ingestSecret() {
    var secret = PropertiesService.getScriptProperties().getProperty('ingest');
    if (!secret) Logger.log('No "ingest" property: run notesSecret() first.');
    return secret;
  }

  // A wiki page's HTML; thrown when the wiki does not give it, so the trigger's failure e-mail says so.
  function wikiPage(url) {
    var res = fetchTried(url, {
      headers: { 'User-Agent': USER_AGENT },
      muteHttpExceptions: true,
      followRedirects: false
    });
    if (!res || typeof res.getResponseCode !== 'function' || res.getResponseCode() !== 200) {
      throw new Error('wiki: ' + (res && res.getResponseCode ? 'HTTP ' + res.getResponseCode() : res));
    }
    return res.getContentText();
  }

  // One signed message to the Worker, the list cut to fit; the number of notes it carried.
  function send(list, secret) {
    var fitted = fit(list);
    var body = fitted.body;
    var t = Math.floor(Date.now() / 1000);
    var sig = hex(Utilities.computeHmacSha256Signature(
      Utilities.newBlob(t + '\n' + INGEST_PATH + '\n' + body).getBytes(),
      Utilities.newBlob(secret).getBytes()));
    var sent = fetchTried(INGEST + INGEST_PATH, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      headers: { 'x-wvw-time': String(t), 'x-wvw-sig': sig },
      muteHttpExceptions: true,
      followRedirects: false
    });
    var code = sent && sent.getResponseCode ? sent.getResponseCode() : String(sent);
    if (code !== 200) throw new Error('push: ' + code);
    return fitted.list.length;
  }

  function tick() {
    var secret = ingestSecret();
    if (!secret) return;
    var list = notes(wikiPage(INDEX));
    if (!list.length) throw new Error('wiki: no update found on ' + INDEX);
    Logger.log('sent ' + send(list, secret) + ' updates');
  }

  // The last day of a month page ('/wiki/Game_updates/November_2026'), 'yyyy-mm-dd', or null.
  function monthEnd(href) {
    var m = MONTH_HREF_RE.exec(href);
    var mo = m ? MONTHS.indexOf(m[1]) : -1;
    return mo < 0 ? null : new Date(Date.UTC(Number(m[2]), mo + 1, 0)).toISOString().slice(0, 10);
  }

  // The Worker keeps a page it was not sent only when it is older than every page sent, so the
  // seed sends the index's pages whole together with the older ones: one message, the oldest
  // pages cut by fit when the Worker's limits do not take them all.
  function seed() {
    var secret = ingestSecret();
    if (!secret) return;
    var indexHtml = wikiPage(INDEX);
    var list = notes(indexHtml);
    if (!list.length) throw new Error('wiki: no update found on ' + INDEX);
    var cutoff = new Date(Date.now() - SEED_DAYS * 864e5).toISOString().slice(0, 10);
    var have = {};
    list.forEach(function (n) { have[n.update] = true; });
    parse(indexHtml).months.forEach(function (href) {
      var end = monthEnd(href);
      if (end === null || end < cutoff) return;
      notes(wikiPage(WIKI + href)).forEach(function (n) {
        if (n.page < cutoff || have[n.update]) return;
        have[n.update] = true;
        list.push(n);
      });
    });
    // fit takes the oldest page from the end.
    list = list.map(function (n, i) { return { n: n, i: i }; })
      .sort(function (a, b) { return a.n.page < b.n.page ? 1 : a.n.page > b.n.page ? -1 : a.i - b.i; })
      .map(function (x) { return x.n; });
    Logger.log('seeded ' + send(list, secret) + ' updates, the index\'s and those since ' + cutoff);
  }

  function secret() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('ingest')) {
      Logger.log('A secret already exists. Delete the "ingest" script property '
        + 'first to replace it.');
      return;
    }
    // Four UUIDs, hashed into 512 bits.
    var bytes = [];
    for (var i = 0; i < 2; i++) {
      bytes = bytes.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
        Utilities.getUuid() + Utilities.getUuid() + Date.now()));
    }
    var value = hex(bytes);
    props.setProperty('ingest', value);
    Logger.log('Paste this into the Worker secret INGEST_NOTES, and nowhere else:');
    Logger.log(value);
  }


  return { tick: tick, secret: secret, seed: seed, notes: notes, fit: fit };
})();
