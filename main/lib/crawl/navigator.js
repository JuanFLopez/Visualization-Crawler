/**
 * Getting the page back to a known state. TWO NAVIGATION MODES:
 *
 *  - FAST (with `backSelector`): assumes hierarchy semantics with a
 *    deterministic "go up one level" action (zoom in / out, breadcrumbs).
 *    It navigates through the common ancestor (up to the common parent, then
 *    down the rest of the path) and never reloads the page during the crawl.
 *    The user has to provide it by hand through the visualization's config.js
 *    (see "Configuration" in the README).
 *
 *  - GENERIC (no `backSelector`, the default): assumes nothing about the
 *    semantics. To get back to a state it uses transitions already observed
 *    when there are any; otherwise it reloads the page and replays the whole
 *    path from the root. It works with any visualization, including ones
 *    with no fixed "back".
 *
 * The navigator also owns `current`, the state the page is believed to be in,
 * which expand.js and hoverProbe.js keep up to date whenever they move the
 * page themselves.
 */

const { ERROR_STATE } = require('../constants');
const { click, gestureKey } = require('./gestures');
const { knownRoute } = require('./graph');

/**
 * @param {Object} p
 * @param {ReturnType<import('./session').createSession>} p.session
 * @param {Map<string, Object>} p.graph
 * @param {string|null} p.backSelector
 * @param {string} p.current - the state the page is in now
 * @returns {{ current: string|null, navigateTo: Function, replay: Function }}
 *   current: the state the page is in; null = unknown, ERROR_STATE = a click broke it.
 *   Whoever moves the page by hand must keep it up to date.
 */
function createNavigator({ session, graph, backSelector, current }) {
  const nav = {
    current,

    /**
     * Moves the page to the state `target` and updates `current`.
     * @param {string} target - a state of the graph
     * @param {number|null} wait - settle time after each gesture (null = virtual time)
     * @throws {Error} for an unknown state, or when a hover of the path can no longer be replayed
     */
    async navigateTo(target, wait) {
      if (nav.current === target) return;

      const targetNode = graph.get(target);
      if (!targetNode) throw new Error(`unknown state: ${target}`);

      if (backSelector && nav.current !== ERROR_STATE && graph.has(nav.current)) {
        const curPath = graph.get(nav.current).path;
        const tgtPath = targetNode.path;
        let i = 0;
        while (i < curPath.length && i < tgtPath.length && gestureKey(curPath[i]) === gestureKey(tgtPath[i])) i++;
        const upSteps = curPath.length - i;
        const downGestures = tgtPath.slice(i);

        for (let k = 0; k < upSteps; k++) await session.perform(click(backSelector), wait);
        await nav.replay(downGestures, wait);
        nav.current = target;
        return;
      }

      // generic mode
      if (nav.current && nav.current !== ERROR_STATE) {
        const route = knownRoute(graph, nav.current, target);
        if (route && route.length <= targetNode.path.length) {
          const replayed = await nav.replay(route, wait, { strict: false });
          if (replayed && session.errors.length === 0 && (await session.readState()) === target) {
            nav.current = target;
            return;
          }
        }
      }
      await session.initialLoad(wait);
      await nav.replay(targetNode.path, wait);
      nav.current = target;
    },

    /**
     * Replays known gestures. A hover that can no longer be done (the element
     * stopped being actionable) means the page does not behave as it did when the
     * path was discovered: with `strict` it aborts, otherwise it returns false so
     * the caller can try another path.
     * @param {import('./gestures').Gesture[]} gestures
     * @param {{strict?: boolean}} [opts]
     * @returns {Promise<boolean>} false when a hover could not be replayed (only if not strict)
     */
    async replay(gestures, wait, { strict = true } = {}) {
      for (const gesture of gestures) {
        if ((await session.perform(gesture, wait)) !== false || gesture.kind !== 'hover') continue;
        if (strict) throw new Error(`could not replay the hover on ${gesture.sel}: the element is no longer interactable`);
        return false;
      }
      return true;
    },
  };
  return nav;
}

module.exports = { createNavigator };
