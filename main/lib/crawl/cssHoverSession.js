/**
 * CSS :hover. A pointer simulated with events does not trigger it, so it is
 * FORCED through the DevTools protocol (CSS.forcePseudoState) on the element
 * and all its ancestors, as a real pointer would, without moving any mouse (so
 * no hidden position is left behind). Two verified facts matter here:
 *  - DOM.getDocument is requested ONCE per document: requesting it again
 *    invalidates the nodeIds, the forced state is orphaned and can no longer
 *    be cleared.
 *  - So clearing uses the nodeIds saved when forcing, not a fresh lookup.
 * It only runs on pages with :hover rules (window.__crawlerCssHover); on the
 * rest not even the session is opened.
 *
 * Used by gestures.js (the hover gesture) and session.js (a page load resets it).
 */

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

// A fresh page load wipes everything forced, and the nodeIds.
function resetCssHover(page) {
  const session = sessions.get(page);
  if (session) { session.rootId = null; session.forced = []; }
}

module.exports = { forceCssHover, clearCssHover, resetCssHover };
