// The page through axe-core on four screens, for contrast, accessible names,
// valid aria and unique ids (RULES). Tagged @advisory: it warns
// (the warn job lists what it found in its summary) and blocks nothing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './support/fixtures.mjs';
import { check, firstTier, load, openMap, phone } from './support/steps.mjs';

const RULES = ['color-contrast', 'button-name', 'link-name', 'input-button-name', 'label', 'aria-allowed-attr',
  'aria-required-attr', 'aria-valid-attr', 'aria-valid-attr-value', 'aria-roles', 'aria-required-children',
  'aria-required-parent', 'aria-command-name', 'aria-input-field-name', 'aria-toggle-field-name',
  'aria-hidden-focus', 'duplicate-id', 'duplicate-id-aria', 'duplicate-id-active'];

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 60 * 1000 });

const scan = page => new AxeBuilder({ page }).withRules(RULES).analyze();

const nodes = list => list.map(v => `${v.id} x${v.nodes.length}`).join(', ') || 'none';
const rows = violations => violations.map(v => `| ${v.id} | ${v.impact} | \`${v.nodes[0].target.join(' ')}\` | ${v.nodes.length} |`);
const undecided = list => list.map(v => `${v.id} x${v.nodes.length} (${[...new Set(v.nodes.map(n => n.any[0]?.data?.messageKey))].join('/')})`).join(', ') || 'none';

// One file per screen (workers run apart), which the warn job cats into its summary: rule, impact, selector, nodes.
function report(screen, { violations, incomplete }) {
  const dir = test.info().project.outputDir;
  mkdirSync(dir, { recursive: true });
  const table = violations.length ? ['| rule | impact | first selector | nodes |', '|---|---|---|---|', ...rows(violations)].join('\n') : 'no violations';
  writeFileSync(join(dir, `axe-${screen.replace(/\W+/g, '-')}.md`), `#### ${screen}\n${table}\n\nAxe could not decide (needs a person): ${undecided(incomplete)}\n\n`);
  console.log(`axe ${screen}: ${nodes(violations)}; undecided: ${undecided(incomplete)}`);
}

test.describe('axe', { tag: '@advisory' }, () => {
  test('the page at rest', async ({ page, wvw }) => {
    await load(page, wvw);
    const result = await scan(page);
    const { violations } = result;
    report('at rest', result);
    expect(violations, 'axe violations at rest').toEqual([]);
  });

  test('after a search', async ({ page, wvw }) => {
    await load(page, wvw);
    await check(page, wvw, wvw.guilds[0]);
    const result = await scan(page);
    const { violations } = result;
    report('after a search', result);
    expect(violations, 'axe violations after a search').toEqual([]);
  });

  test('with a map open', async ({ page, wvw }) => {
    await load(page, wvw);
    const { button } = await firstTier(page);
    await openMap(page, wvw, button);
    const result = await scan(page);
    const { violations } = result;
    report('map open', result);
    expect(violations, 'axe violations with a map open').toEqual([]);
  });

  test('on a narrow phone', async ({ page, wvw }) => {
    await load(page, wvw);
    await phone(page, 320);
    const result = await scan(page);
    const { violations } = result;
    report('phone 320', result);
    expect(violations, 'axe violations on a narrow phone').toEqual([]);
  });

  test('a button without a name is found', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.evaluate(() => { document.body.append(document.createElement('button')); });
    const { violations } = await scan(page);
    expect(violations.map(v => v.id), 'the planted nameless button').toContain('button-name');
    console.log(`axe planted: ${rows(violations).join('\n')}`);
  });
});
