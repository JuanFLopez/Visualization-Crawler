/**
 * Helpers that run INSIDE the page, installed before the visualization's own
 * code. They are the browser half of the crawler; the Node half is lib/crawl/.
 *   actionability.js  can a real user touch this element now?
 *   discovery.js      which elements are candidates, and what to call them
 *   pointer.js        the simulated pointer
 *
 * THE PAGE <-> NODE CONTRACT. The browser half is split across instrument.js and
 * the three scripts here, and the Node half reaches it only through globals on
 * `window` (and a few attributes on the DOM):
 *
 *   provided by instrument.js
 *     data-crawler-clickable / -hoverable / -id / -moves   attributes put on every element that gets a listener
 *     __crawlerState()          hash of the DOM fingerprint = the state key (read by lib/crawl/session.js)
 *     __crawlerStateDebug()     the same, unhashed (diagnose.js)
 *     __crawlerActivity()       { pendingRequests, msSinceFrame } to wait until the page is quiet (settle.js)
 *     __crawlerEffects(base)    snapshot of everything visible, to see what a hover changed (hoverProbe.js)
 *     __crawlerSelfKey          snapshot key of the element the pointer is over (left by __crawlerEffects)
 *   provided by actionability.js
 *     __crawlerMeasure(node, far)   { actionable, visibleFrac, point }, used by discovery.js and pointer.js
 *     __crawlerIsActionable(node)   just the boolean (diagnose.js)
 *   provided by discovery.js
 *     __crawlerScanCss()            elements that receive a stylesheet :hover; sets __crawlerCssHover / __crawlerCssBlocked
 *     __crawlerCandidates(sel)      every actionable candidate, as Candidate objects (lib/crawl/session.js)
 *     __crawlerMarks(sel, limit)    the D3 marks inside a delegated-listener container (hoverProbe.js)
 *   provided by pointer.js
 *     __crawlerHover(sel, where)    put the simulated pointer over an element; false if it cannot be reached
 *     __crawlerUnhover()            take it off; sets / clears __crawlerPointerNode
 *   injected from lib/cssHover.js (see installPageHelpers)
 *     __crawlerHoverTargets, __crawlerIsVisualProperty   the :hover rule parser
 *   set by Node before the page loads (run.js, diagnose.js)
 *     __crawlerContainerSelector    restrict detection and state to one container
 *     __crawlerIncludeLinks         also treat <a> / [href] as interactive
 *   read from the visualization itself
 *     __testState                   a state the author defined by hand; takes priority over the fingerprint
 *
 * Because Playwright serializes each function with toString(), every function
 * here must be self-contained: no require, no variable from the Node module.
 */

const { hoverTargets, isVisualProperty } = require('../cssHover');
const { installActionability } = require('./actionability');
const { installDiscovery } = require('./discovery');
const { installPointer } = require('./pointer');

/**
 * Installs the page helpers as init scripts of `page`, so they exist before the
 * visualization's own code runs; call it before adding any other init script.
 * @param {import('playwright').Page} page
 */
async function installPageHelpers(page) {
  await page.addInitScript(installActionability);
  await page.addInitScript(installDiscovery);
  await page.addInitScript(installPointer);
  // the :hover rule parser is the same one the tests use (lib/cssHover.js)
  await page.addInitScript({
    content: `window.__crawlerHoverTargets = ${hoverTargets.toString()}; window.__crawlerIsVisualProperty = ${isVisualProperty.toString()};`,
  });
}

/**
 * Generic "actionable now" filter for a loose locator (used by diagnose.js).
 * Needs installPageHelpers to have run on the page.
 * @param {import('playwright').Locator} locator
 * @returns {Promise<boolean>}
 */
function isActionable(locator) {
  return locator.evaluate((node) => window.__crawlerIsActionable(node));
}

module.exports = { installPageHelpers, isActionable };
