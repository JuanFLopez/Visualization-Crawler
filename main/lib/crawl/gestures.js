/**
 * Gestures, and how they are performed on the page. An ACTION (an alphabet
 * symbol, "Click_vis") is performed with a GESTURE: the kind of interaction and
 * the selector of the element it is done on. Keeping the kind is what lets
 * navigation between states just replay gestures without knowing what sort
 * they are.
 *
 * Gestures are stored in the graph (lib/crawl/graph.js), so they stay plain
 * serializable objects.
 *
 * @typedef {Object} Gesture
 * @property {'click'|'hover'|'unhover'} kind
 * @property {string} sel - CSS selector of the element; ignored by `unhover`, because the pointer knows where it is
 */

// CSS :hover. A pointer simulated with events does not trigger it, so it is
// FORCED through the DevTools protocol (CSS.forcePseudoState) on the element
// and all its ancestors, as a real pointer would, without moving any mouse (so
// no hidden position is left behind). Two verified facts matter here:
//  - DOM.getDocument is requested ONCE per document: requesting it again
//    invalidates the nodeIds, the forced state is orphaned and can no longer
//    be cleared.
//  - So clearing uses the nodeIds saved when forcing, not a fresh lookup.
// It only runs on pages with :hover rules (window.__crawlerCssHover); on the
// rest not even the session is opened.

const sessions = new WeakMap(); // page -> { cdp, rootId, forced: nodeId[] } | false (no CDP)

/**
 * The DevTools session of `page`, opened the first time it is needed.
 * @param {import('playwright').Page} page
 * @returns {Promise<{cdp: Object, rootId: number|null, forced: number[]}|false>} false when CDP is not available
 */
async function cssHoverSession(page) {
  if (sessions.has(page)) return sessions.get(page);
  let session = false;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    session = { cdp, rootId: null, forced: [] };
    cdp.on('DOM.documentUpdated', () => { session.rootId = null; session.forced = []; });
  } catch (e) {
    session = false;
  }
  sessions.set(page, session);
  return session;
}

/**
 * Forces :hover on the nodes __crawlerHover marked (data-crawler-hover): the element and all its ancestors.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} false when DevTools is not available (the :hover rules then stay unseen)
 */
async function forceCssHover(page) {
  const session = await cssHoverSession(page);
  if (!session) return false;
  const marked = async () => {
    if (session.rootId == null) session.rootId = (await session.cdp.send('DOM.getDocument', { depth: 0 })).root.nodeId;
    return session.cdp.send('DOM.querySelectorAll', { nodeId: session.rootId, selector: '[data-crawler-hover]' });
  };
  let nodeIds;
  try {
    ({ nodeIds } = await marked());
  } catch (e) {
    session.rootId = null; // the document changed silently: ask again (nothing is forced yet)
    ({ nodeIds } = await marked());
  }
  for (const nodeId of nodeIds) await session.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  session.forced = nodeIds;
  return true;
}

/** Un-forces what forceCssHover forced, using the nodeIds saved then (see the note above). */
async function clearCssHover(page) {
  const session = sessions.get(page);
  if (!session || session.forced.length === 0) return;
  for (const nodeId of session.forced) {
    await session.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); // the node may be gone
  }
  session.forced = [];
}

/** A fresh page load wipes everything forced, and the nodeIds (called by session.js after every load). */
function resetCssHover(page) {
  const session = sessions.get(page);
  if (session) { session.rootId = null; session.forced = []; }
}

/**
 * @param {'click'|'hover'|'unhover'} kind
 * @returns {Gesture}
 */
const gesture = (kind, sel) => ({ kind, sel });
const click =(sel) => gesture('click', sel);
const hover = (sel) => gesture('hover', sel);
const unhover = (sel) => gesture('unhover', sel);

/** A string that identifies a gesture, for Maps and Sets: "click:[data-crawler-id=\"c3\"]". */
const gestureKey = (g) => `${g.kind}:${g.sel}`;

/**
 * How each kind of gesture is performed on the element `sel`; every function takes the Playwright page first.
 *  - click: dispatches a synthetic click event (the real mouse is never used).
 *  - hover: puts the simulated pointer over the element (see lib/page/pointer.js) and, on a page with CSS :hover
 *    rules, forces the :hover state through the DevTools protocol (see the top of this file). Returns false when the
 *    element can no longer be interacted with. Accepts { where: 'edge' } to aim away from the center.
 *  - unhover: takes the pointer off; false when it was not over anything.
 */
const PERFORM = {
  click: (page, sel) => page.$eval(sel, (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }),
  hover: async (page, sel, opts) => {
    await clearCssHover(page); // in case the pointer was somewhere else
    // when replaying a path this may be the first hover of the load, so the :hover rules are scanned first
    const ok = await page.evaluate(([s, where]) => {
      window.__crawlerScanCss();
      return window.__crawlerHover(s, where);
    }, [sel, opts && opts.where]);
    if (ok && (await page.evaluate(() => window.__crawlerCssHover === true))) await forceCssHover(page);
    return ok;
  },
  unhover: async (page) => {
    await clearCssHover(page);
    return page.evaluate(() => window.__crawlerUnhover());
  },
};

module.exports = { gesture, click, hover, unhover, gestureKey, resetCssHover, PERFORM };
