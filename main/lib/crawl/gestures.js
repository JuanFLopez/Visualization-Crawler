/**
 * Gestures. An ACTION (an alphabet symbol, "Click_vis") is performed with a
 * GESTURE: the kind of interaction and the selector of the element it is done
 * on. Keeping the kind is what lets navigation between states just replay
 * gestures without knowing what sort they are.
 *
 * Gestures are stored in the graph (lib/crawl/graph.js), so they stay plain
 * serializable objects.
 *
 * @typedef {Object} Gesture
 * @property {'click'|'hover'|'unhover'} kind
 * @property {string} sel - CSS selector of the element; ignored by `unhover`, because the pointer knows where it is
 */

const { forceCssHover, clearCssHover } = require('./cssHoverSession');

/**
 * @param {'click'|'hover'|'unhover'} kind
 * @param {string} sel
 * @returns {Gesture}
 */
const gesture = (kind, sel) => ({ kind, sel });
// shorthands for the three kinds
const click = (sel) => gesture('click', sel);
const hover = (sel) => gesture('hover', sel);
const unhover = (sel) => gesture('unhover', sel);

/** A string that identifies a gesture, for Maps and Sets: "click:[data-crawler-id=\"c3\"]". */
const gestureKey = (g) => `${g.kind}:${g.sel}`;

/**
 * How each kind of gesture is performed on the element `sel`; every function takes the Playwright page first.
 *  - click: dispatches a synthetic click event (the real mouse is never used).
 *  - hover: puts the simulated pointer over the element (see lib/page/pointer.js) and, on a page with CSS :hover
 *    rules, forces the :hover state through the DevTools protocol (see cssHoverSession.js). Returns false when the
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

module.exports = { gesture, click, hover, unhover, gestureKey, PERFORM };
