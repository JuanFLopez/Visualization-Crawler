/**
 * Waiting for the page to settle after a gesture or a load.
 *
 * In virtual time (when no fixed settleMs is passed) the clock is jumped
 * CHUNK_MS at a time and the page counts as settled when no requests are in
 * flight and no animation frame was requested in the last QUIET_MS (virtual).
 * Each jump is fastForward, not runFor: it fires every due timer ONCE instead
 * of replaying the ~60 intermediate frames per second. A D3 transition reaches
 * its final state in 2-3 frames, which is all the fingerprint looks at. A
 * tick-based simulation (d3-force) advances one tick per jump, hence the cap is
 * on jumps and not on time. The network does run in real time: it is polled
 * every POLL_MS.
 */

const { PERFORM } = require('./gestures');

const POLL_MS = 20; // real ms between checks while requests are in flight
const CHUNK_MS = 1000; // virtual ms the clock jumps at a time
const QUIET_MS = 100; // virtual ms without an animation frame that count as quiet
const MAX_CHUNKS = 1000; // jumps before giving up: 1000 x CHUNK_MS = 1000 virtual seconds
const NETWORK_MAX_MS = 15000; // real ms to wait for requests that do not return

/** `code` of the error thrown when the page never goes quiet; a hover probe tells it apart and ignores that hover. */
const NO_SETTLE = 'NO_SETTLE';

/**
 * Page activity from instrument.js (window.__crawlerActivity); without it nothing is awaited.
 * @returns {Promise<{pendingRequests: number, msSinceFrame: number}>}
 *   requests in flight, and virtual ms since the page last asked for an animation frame
 */
function readActivity(page) {
  return page.evaluate(() => (typeof window.__crawlerActivity === 'function'
    ? window.__crawlerActivity()
    : { pendingRequests: 0, msSinceFrame: Infinity }));
}

/**
 * Advances the page's fake clock until it goes quiet.
 * @param {import('playwright').Page} page - needs page.clock.install() to have been called
 * @throws {Error} when requests never return (NETWORK_MAX_MS), or code NO_SETTLE when it keeps animating (MAX_CHUNKS)
 */
async function virtualSettle(page) {
  const t0 = Date.now();
  let chunks = 0;
  for (;;) {
    const a = await readActivity(page);
    if (a.pendingRequests > 0) {
      if (Date.now() - t0 > NETWORK_MAX_MS) {
        throw new Error(`some requests never return after ${NETWORK_MAX_MS}ms (is an external resource down?)`);
      }
      await page.waitForTimeout(POLL_MS);
      continue;
    }
    if (chunks > 0 && a.msSinceFrame >= QUIET_MS) return;
    if (chunks >= MAX_CHUNKS) {
      const err = new Error(
        `the page kept animating for ${MAX_CHUNKS * CHUNK_MS / 1000}s (virtual) after an interaction. This points ` +
        `to a continuous animation (something with requestAnimationFrame running indefinitely) rather than to ` +
        `"it needs to wait a little longer" -- in that case automatic state detection is not the right ` +
        `tool: instrument window.__testState by hand, capturing only what is logically relevant ` +
        `(or pass a fixed --settleMs to force a real-time run).`
      );
      err.code = NO_SETTLE;
      throw err;
    }
    await page.clock.fastForward(CHUNK_MS);
    chunks++;
  }
}

/**
 * Waits `wait` ms of real time, or for the page to go quiet in virtual time when `wait` is null.
 * @param {import('playwright').Page} page
 * @param {number|null} wait - a fixed settleMs, or null for virtual time
 */
function settle(page, wait) {
  return wait == null ? virtualSettle(page) : page.waitForTimeout(wait);
}

/**
 * Clicks `sel` and measures when the state stops changing: it reads every
 * `pollMs` and counts the page as settled once `quietMs` pass with no change.
 * Returns the instant (ms since the click) of the last change observed, or
 * null when it is still changing on reaching `maxMs`.
 */
async function measureSettle(page, sel, readFn, { pollMs = 50, quietMs = 400, maxMs = 6000, onChange = null } = {}) {
  let prev = await readFn();
  await PERFORM.click(page, sel);
  const t0 = Date.now();
  let lastChange = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(pollMs);
    const cur = await readFn();
    const now = Date.now() - t0;
    if (cur !== prev) {
      lastChange = now;
      prev = cur;
      if (onChange) onChange(now);
    } else if (now - lastChange >= quietMs) {
      return lastChange;
    }
  }
  return null;
}

module.exports = { NO_SETTLE, settle, measureSettle };
