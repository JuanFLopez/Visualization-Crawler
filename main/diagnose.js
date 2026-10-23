/**
 * Diagnoses why the crawler cannot converge on a visualization:
 *   phase 1  reloads the page several times without clicking anything and
 *            compares the state fingerprints (is the starting state stable?);
 *   phase 2  clicks the first candidate that changes something and measures
 *            how long the page takes to settle (or whether it never does).
 *
 * Run it when a crawl fails with "the initial state is not stable between
 * reloads" or "the page kept animating": phase 1 shows exactly which attribute
 * differs between two loads, and phase 2 tells a slow transition (use a larger
 * settle time) from an animation that never ends (instrument window.__testState
 * by hand). It runs in REAL time, unlike the crawler, and uses the same page
 * helpers and instrument.js, so what it sees is what the crawler sees.
 *
 * Usage: node diagnose.js <folder-with-index.html> [waitMs=500] [rounds=5] [--containerSelector <css>]
 *   waitMs  real ms to wait after every load        rounds  how many times phase 1 reloads
 */
const fs = require('fs');
const path = require('path');
const { installPageHelpers, isActionable } = require('./lib/page');
const { measureSettle } = require('./lib/crawl/settle');
const { startServer } = require('./lib/server');
const { resolveChromePath, launchBrowser } = require('./lib/browser');

const VIEWPORT = { width: 700, height: 700 };

/**
 * First point where two readings differ (';' separates one element per
 * fragment), with context, so thousands of characters need not be read by hand.
 * @param {string} a - a fingerprint from window.__crawlerStateDebug()
 * @param {string} b
 * @returns {{index: number, a: string, b: string}|null} the element number and both versions; null if equal
 */
function firstDifference(a, b) {
  const partsA = a.split(';');
  const partsB = b.split(';');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    if (partsA[i] !== partsB[i]) {
      return { index: i, a: partsA[i] ?? '(does not exist)', b: partsB[i] ?? '(does not exist)' };
    }
  }
  return null;
}

/**
 * Phase 1: reload without touching anything and compare the fingerprints.
 * @param {import('playwright').Browser} browser
 * @param {string} url - of the visualization's index.html
 * @param {string[]} initScripts - instrument.js and the options
 * @param {{waitMs: number, rounds: number}} opts
 */
async function checkInitialStability(browser, url, initScripts, { waitMs, rounds }) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  for (const src of initScripts) await page.addInitScript({ content: src });

  const bufs = [];
  for (let i = 0; i < rounds; i++) {
    await page.goto(url);
    await page.waitForTimeout(waitMs);
    const buf = await page.evaluate(() => window.__crawlerStateDebug());
    bufs.push(buf);
    console.log(`round ${i + 1}: ${buf.length} fingerprint characters`);
  }
  await page.close();

  console.log('');
  if (bufs.every((b) => b === bufs[0])) {
    console.log('STABLE on the initial load: the', rounds, 'readings without clicking anything are identical.');
    return;
  }
  console.log('UNSTABLE already on the initial load: the fingerprint changes between reloads WITHOUT CLICKING ANYTHING.');
  console.log('This confirms the problem is not the crawler -- not even the starting state');
  console.log('repeats, so no crawling strategy can converge.\n');

  for (let i = 1; i < bufs.length; i++) {
    const diff = firstDifference(bufs[0], bufs[i]);
    if (diff) {
      console.log(`First difference between round 1 and round ${i + 1} (element #${diff.index}):`);
      console.log('  round 1:', diff.a);
      console.log(`  round ${i + 1}:`, diff.b);
      console.log('');
    }
  }
}

/**
 * Phase 2: the initial load may be stable, yet what matters usually happens
 * AFTER a click (a D3 transition, a force simulation that starts there). The
 * first candidate that changes something is clicked once and the fingerprint is
 * measured over time, to see whether two consecutive readings ever match (it
 * "settles") or never do. Up to 10 candidates are tried, since the first may be
 * a no-op or may break the page.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string[]} initScripts
 * @param {{waitMs: number, containerSelector: string|null}} opts
 */
async function checkSettling(browser, url, initScripts, { waitMs, containerSelector }) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await installPageHelpers(page);
  for (const src of initScripts) await page.addInitScript({ content: src });
  let pageErrors = 0;
  page.on('pageerror', () => pageErrors++);

  await page.goto(url);
  await page.waitForTimeout(waitMs);

  const clickableSelector = containerSelector
    ? `${containerSelector} [data-crawler-clickable]`
    : '[data-crawler-clickable]';
  const all = await page.locator(clickableSelector).all();
  const actionable = [];
  for (const el of all) if (await isActionable(el)) actionable.push(el);
  console.log(`clickable elements detected: ${all.length} (${actionable.length} interactable now)`);

  if (actionable.length === 0) {
    console.log('No interactable clickable element was detected (did automatic detection find no click listeners?). Skipping phase 2.');
  } else {
    // The first candidate may be a no-op (or may break: the root rect of an
    // icicle in the root state), so try until one changes something.
    const maxMs = 6000;
    const maxTries = Math.min(actionable.length, 10);
    let settledAt = 0;
    for (let i = 0; i < maxTries && settledAt === 0; i++) {
      const id = await actionable[i].getAttribute('data-crawler-id');
      const errorsBefore = pageErrors;
      settledAt = await measureSettle(
        page,
        `[data-crawler-id="${id}"]`,
        () => page.evaluate(() => window.__crawlerState()),
        { maxMs, onChange: (ms) => console.log(`  +${ms}ms: CHANGED`) }
      );
      if (settledAt === 0) {
        const why = pageErrors > errorsBefore ? 'threw an error on the page' : 'changed nothing observable';
        console.log(`candidate ${id}: ${why}, trying the next one...`);
      }
    }

    console.log('');
    if (settledAt === 0) {
      console.log(`None of the first ${maxTries} candidates changed anything observable.`);
    } else if (settledAt !== null) {
      console.log(`It settles at ~${settledAt}ms (last change observed). crawler.js does not need this number`);
      console.log(`(it uses virtual time); if you want a fixed real-time pause, use something above it, e.g. --settleMs ${Math.round(settledAt * 1.5) + 200}.`);
    } else {
      console.log('It NEVER settled within the', maxMs, 'ms we tried.');
      console.log('This points to a continuous animation/simulation (d3-force, something with requestAnimationFrame');
      console.log('running indefinitely) rather than "it needs to wait a little longer". In that case the automatic');
      console.log('fingerprint based on DOM attributes is not the right tool: you need a manual');
      console.log('window.__testState that captures ONLY what logically matters (what is');
      console.log('selected/expanded), ignoring pixel positions that never repeat exactly.');
    }
  }

  await page.close();
}

(async () => {
  const args = process.argv.slice(2);
  const csIdx = args.indexOf('--containerSelector');
  const containerSelector = csIdx >= 0 ? args.splice(csIdx, 2)[1] : null;
  const vizDir = args[0];
  const waitMs = parseInt(args[1], 10) || 500;
  const rounds = parseInt(args[2], 10) || 5;

  if (!vizDir) {
    console.error('Usage: node diagnose.js <folder-with-index.html> [waitMs=500] [rounds=5] [--containerSelector <css>]');
    process.exit(1);
  }

  const resolvedDir = path.resolve(vizDir);
  const initScripts = [];
  if (containerSelector) {
    initScripts.push(`window.__crawlerContainerSelector = ${JSON.stringify(containerSelector)};`);
  }
  initScripts.push(fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8'));

  const server = await startServer(resolvedDir);
  const browser = await launchBrowser(await resolveChromePath());
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  try {
    console.log(`reloading ${resolvedDir} ${rounds} times, waiting ${waitMs}ms each time, clicking nothing...\n`);
    await checkInitialStability(browser, url, initScripts, { waitMs, rounds });

    console.log('\n--- Phase 2: does it settle after a click? ---\n');
    await checkSettling(browser, url, initScripts, { waitMs, containerSelector });
  } finally {
    await browser.close();
    server.close();
  }
})();
