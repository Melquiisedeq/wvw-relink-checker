// scripts/check-site.py: which images of the served HTML it goes looking for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../../scripts/check-site.py', import.meta.url).pathname;

test('images are the <img> and the icon links on this origin, each once, no other origin', () => {
  const html = `<link rel="icon" href="assets/favicon-192.png"><link rel="icon" href="favicon.ico">
    <link rel="stylesheet" href="css/base.css"><link rel="preconnect" href="https://render.guildwars2.com">
    <img src="assets/treb-arm.webp" alt=""><img class="x" src="assets/treb-arm.webp">
    <img src="https://example.com/a.png"><script src="js/a.js"></script>`;
  const out = execFileSync('python3', ['-I', '-c', `
import importlib.util, json, os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_site', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps(mod.image_paths(sys.stdin.read())))
`, SCRIPT], { input: html, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['assets/favicon-192.png', 'assets/treb-arm.webp', 'favicon.ico']);
});

test('main sends a HEAD for each image and goes red when one is not served', () => {
  const out = execFileSync('python3', ['-I', '-c', `
import importlib.util, io, json, os, sys, contextlib
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_site', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
HTML = '<link rel="canonical" href="x"><script src="js/boot.js"></script><img src="assets/a.webp">'
asked = []
def fake(url, method='GET'):
    asked.append(method + ' ' + url)
    if url.endswith('a.webp'):
        return None, None, 'HTTP 404 after 3 attempts', None
    return 200, HTML if url == mod.SITE else '', None, {'Content-Security-Policy': 'p'}
mod.fetch = fake
mod.csp_written = lambda: 'p'
mod.domain_checks = lambda problems, notes: None
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = mod.main()
print(json.dumps({'code': code, 'asked': asked, 'log': buf.getvalue()}))
`, SCRIPT], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(r.asked.includes('HEAD https://wvwrelink.com/assets/a.webp'), r.asked.join('\n'));
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /assets\/a\.webp/);
});
