/**
 * The browser page the crawl drives: how it is set up, how its state is read,
 * and how gestures are performed on it.
 *
 * VIRTUAL TIME (the default, with no settleMs): the page clock is replaced
 * with a fake one (Playwright's page.clock) and after every gesture it is
 * advanced until the animation ends (see settle.js). A 750 ms D3 transition
 * resolves in a few real milliseconds, independent of the machine's speed.
 *
 * AUTOMATIC DETECTION (the default, nothing instrumented by hand): the state
 * is `window.__crawlerState()` (a DOM fingerprint from instrument.js). A
 * `window.__testState` defined by the user takes priority (more precise
 * manual instrumentation).
 *
 * Everything the other crawl modules do to the browser goes through the
 * session object, so they never touch Playwright directly (except
 * hoverProbe.js, which reads the effects snapshot through session.page).
 */

const { installPageHelpers } = require('../page');
const { gesture, resetCssHover, PERFORM } = require('./gestures');
const { settle } = require('./settle');
const { selectorFor } = require('./naming');

/**
 * @param {import('playwright').Browser} browser
 * @param {Object} opts
 * @param {string} opts.fixtureUrl
 * @param {string[]} opts.initScripts - code injected before the visualization's own (instrument.js, ...)
 * @param {(raw: any) => string} opts.stateKeyFn - raw state -> state key
 * @param {boolean} opts.virtualTime - fake page clock
 * @returns {Promise<{
 *   page: import('playwright').Page,
 *   errors: string[],                     // exceptions thrown by the page since the last gesture or load
 *   usedManualState: boolean,             // true once a window.__testState was read
 *   readState: () => Promise<string>,
 *   settle: (wait: number|null) => Promise<void>,
 *   perform: (gesture: import('./gestures').Gesture, wait: number|null, opts?: Object) => Promise<*>,
 *   initialLoad: (wait: number|null) => Promise<void>,
 *   hasEffectsSnapshot: () => Promise<boolean>,
 *   discoverCandidates: (selectors: Object, nameFor: Function) => Promise<Array>,
 * }>}
 */
async function createSession(browser, { fixtureUrl, initScripts, stateKeyFn, virtualTime }) {
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  if (virtualTime) await page.clock.install();
  await installPageHelpers(page);
  for (const src of initScripts) await page.addInitScript({ content: src });

  const session = {
    page,
    errors: [], // exceptions the page threw since the last gesture or load
    usedManualState: false,

    async readState() {
      const state = await page.evaluate(() => {
        try {
          if (typeof window.__testState !== 'undefined') return { raw: window.__testState, manual: true };
          if (typeof window.__crawlerState === 'function') return { raw: window.__crawlerState(), manual: false };
          return null;
        } catch (e) {
          return { raw: `unreadable state: ${e.message}`, unreadable: true };
        }
      });
      if (state === null) {
        throw new Error(
          'could not read the state: define window.__testState in your code, ' +
          'or pass instrument.js in initScripts for automatic detection.'
        );
      }
      if (state.unreadable) throw new Error(state.raw);
      if (state.manual) session.usedManualState = true;
      return stateKeyFn(state.raw);
    },

    settle: (wait) => settle(page, wait),

    // Performs a gesture and waits for the page to settle. Returns whatever the
    // gesture returns (for hover, false when the element could no longer be
    // touched). After a click the pointer is left outside: the page may arrive
    // with it over something (a hover that opened a menu), and the state that is
    // read has to be the click's, not the click's plus a lingering highlight a
    // real user would not see.
    async perform(g, wait, opts) {
      session.errors = [];
      const done = await PERFORM[g.kind](page, g.sel, opts);
      await settle(page, wait);
      if (g.kind === 'click' && (await PERFORM.unhover(page))) await settle(page, wait);
      return done;
    },

    async initialLoad(wait) {
      session.errors = [];
      await page.goto(fixtureUrl);
      resetCssHover(page);
      await settle(page, wait);
    },

    // Without instrument.js (manual state with window.__testState) there is no
    // way to see whether a hover changed anything.
    hasEffectsSnapshot: () => page.evaluate(() => typeof window.__crawlerEffects === 'function'),

    // The actionable candidates of the current state, already named:
    // [[action, gesture, info], ...]. Clicks first and hovers after (one element
    // can be in both), so the order in which clicks are explored does not depend
    // on whether there are hovers. `selectors`: { click, hover, container, css }.
    async discoverCandidates(selectors, nameFor) {
      const infos = await page.evaluate((sel) => window.__crawlerCandidates(sel), selectors);
      const found = [];
      for (const kind of ['click', 'hover']) {
        for (const info of infos) {
          if (!info.kinds.includes(kind)) continue;
          const g = gesture(kind, selectorFor(info));
          found.push([nameFor(info, g), g, info]);
        }
      }
      return found;
    },
  };

  page.on('pageerror', (e) => session.errors.push(String(e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  return session;
}

module.exports = { createSession };
