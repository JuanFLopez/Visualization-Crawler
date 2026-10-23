/**
 * The graph of discovered states: a Map from state key to node (see GraphNode).
 * It is built while crawling (expand.js and hoverProbe.js add to it, navigator.js
 * reads it) and, once the crawl ends, collectResult turns it into the tables the
 * report is made from.
 *
 * A state is never expanded again once it has been, and that alone makes the
 * crawl terminate even when the real graph has cycles.
 *
 * @typedef {Object} GraphNode
 * @property {import('./gestures').Gesture[]} path - how to reach the state from the initial one
 * @property {Object<string, string>} transitions - action -> the state it led to ("__ERROR__" when it broke the page)
 * @property {Object<string, import('./gestures').Gesture>} gestures - action -> how to perform it; lets known
 *   transitions be redone when navigating without reloading (see knownRoute)
 * @property {boolean} [expanded] - true once every candidate of the state was tried; absent on a state that
 *   maxStates cut off, which is how the crawl knows it was truncated
 * @property {Object<string, {readable: string, tag: string}>} [labels] - action -> the readable name of its
 *   element IN this state, used to name the states and to spot names that depend on the state
 * @property {Object<string, number>} [visibility] - action -> visible fraction of a clicked element that was only partly visible
 * @property {Object<string, string>} [inert] - hover action -> why it was probed here but is not an action (see IGNORE_REASON)
 * @property {Object<string, Object>} [effects] - hover action -> its observed effect (see describeEffect)
 * @property {import('./gestures').Gesture} [pointer] - set on a state that only exists while the pointer is over an element
 * @property {string[]} [enabled] - on such a state, the gestureKeys of the clicks the hover enabled
 *
 * Optional fields stay absent until used: whether they exist changes what is reported.
 */

const { ERROR_STATE } = require('../constants');
const { compositeKey, splitKey } = require('../util');

/**
 * A node with nothing explored yet.
 * @param {import('./gestures').Gesture[]} [path]
 * @returns {GraphNode}
 */
const newNode = (path = []) => ({ path, transitions: {}, gestures: {} });

/**
 * node[field] as an object, created when missing. The optional fields stay
 * absent until used: whether they exist changes what is reported.
 * @param {GraphNode} node
 * @param {'labels'|'visibility'|'inert'|'effects'} field
 */
const ensureField = (node, field) => (node[field] = node[field] || {});

/**
 * Shortest sequence of already observed gestures from `from` to `to`, or null.
 * @param {Map<string, GraphNode>} graph
 * @param {string} from
 * @param {string} to
 * @returns {import('./gestures').Gesture[]|null}
 */
function knownRoute(graph, from, to) {
  if (!graph.has(from)) return null;
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length > 0) {
    const s = q.shift();
    if (s === to) break;
    const n = graph.get(s);
    if (!n) continue;
    for (const [action, next] of Object.entries(n.transitions)) {
      if (next === ERROR_STATE || prev.has(next) || !n.gestures[action]) continue;
      prev.set(next, [s, n.gestures[action]]);
      q.push(next);
    }
  }
  if (!prev.has(to)) return null;
  const route = [];
  for (let step = prev.get(to); step; step = prev.get(step[0])) route.unshift(step[1]);
  return route;
}

/**
 * The per-state tables the report is built from, read off the finished graph.
 * @param {Map<string, GraphNode>} graph - after renameUnstableActions
 * @returns {{
 *   transitions: Object<string, Object<string, string>>,
 *   visibility: Object, labels: Object<string, Object<string, string>>, effects: Object,
 *   ignoredHovers: {action: string, reason: string, states: number}[],
 * }} every table keyed by state (and then by action); a state appears in visibility / labels / effects
 *   only if it has entries. ignoredHovers counts in how many states each (action, reason) pair was ignored.
 */
function collectResult(graph) {
  const transitions = {};
  const visibility = {};
  const labels = {};
  const effects = {};
  const ignored = new Map(); // compositeKey(action, reason) -> in how many states
  for (const [state, node] of graph) {
    transitions[state] = node.transitions;
    if (node.visibility) visibility[state] = node.visibility;
    if (node.labels) {
      labels[state] = {};
      for (const [action, { readable }] of Object.entries(node.labels)) labels[state][action] = readable;
    }
    if (node.effects) effects[state] = node.effects;
    for (const [action, reason] of Object.entries(node.inert || {})) {
      const key = compositeKey(action, reason);
      ignored.set(key, (ignored.get(key) || 0) + 1);
    }
  }
  const ignoredHovers = [...ignored].map(([key, states]) => {
    const [action, reason] = splitKey(key);
    return { action, reason, states };
  });
  return { transitions, visibility, labels, effects, ignoredHovers };
}

module.exports = { newNode, ensureField, knownRoute, collectResult };
