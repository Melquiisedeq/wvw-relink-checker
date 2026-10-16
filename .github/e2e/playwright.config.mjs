// Playwright Test for the page in site/. The site has no dependencies; these
// tests are the repository's only one, kept here, away from what is published.
//
//   cd .github/e2e && npm ci --ignore-scripts && npx playwright test
//
// No browser is downloaded. CHROME names the executable to drive; without it,
// the cloud sandbox's /opt/pw-browsers/chromium when it exists, else the
// installed Google Chrome (channel 'chrome', which is what CI uses).
import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const CI = !!process.env.CI;
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const executable = process.env.CHROME || (!CI && existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : '');

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: CI,
  // Three. Measured 10/10/2026, 4-core cloud container, Chromium 141, the two
  // smoke tests, three runs each of `npx playwright test`: 2 workers 3.7-4.0 s,
  // 3 workers 3.7-3.9 s, 4 workers 4.0-4.1 s - noise, since two tests never
  // fill more than two. Re-measure when the suite grows.
  // One when recording: the live reads happen once, in order (support/record.mjs).
  workers: process.env.RECORD ? 1 : 3,
  globalSetup: './support/record.mjs',
  // Only on CI, and only the test that failed; a pass on the retry is a
  // warning there (support/summary.mjs), never silence.
  retries: CI ? 1 : 0,
  reporter: [
    ['dot'],
    ['json', { outputFile: 'test-results/results.json' }],
    ['./support/summary.mjs'],
  ],
  use: {
    trace: 'on-first-retry',
    ...(executable ? { launchOptions: { executablePath: executable } } : { channel: 'chrome' }),
  },
});
