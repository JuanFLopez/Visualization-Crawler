/**
 * Human-readable state names. The crawler's states are fingerprint hashes;
 * run.js passes the raw table through prettifyStates right after a crawl, so
 * that everything downstream (regex, diagram, issues) speaks in names like
 * "root > vis > operator". It is skipped when the page defines its own
 * window.__testState (those names are already meaningful) and on a --from
 * re-analysis (the file already has the readable names).
 */

const { displayAction, verbOf } = require('./actions');
const { ERROR_STATE, HIERARCHY_SEPARATOR } = require('./constants');
const { mapKeys } = require('./util');

const ROOT_LABEL = 'root';

/**
 * Builds a human name per state from the path of ACTIONS (already readable,
 * see createNaming in lib/crawl/naming.js) that first reaches it from the
 * root: "root", "root > A", "root > A > A1", and so on. It works purely on the
 * transition table with a BFS (the order in which the crawler discovered the
 * states), numbering on collisions (which should not happen, since each state
 * has a single shortest path recorded, but just in case).
 *
 * When `data.labels` is also present (readable names per state and action,
 * see collectResult in lib/crawl/graph.js) and describes a hierarchy, names come from the data
 * hierarchy instead of the click path (see hierarchyLabels).
 *
 * @param {{initialState: string, transitions: Object, visibility?: Object, effects?: Object, labels?: Object}} data -
 *   the raw crawl tables; visibility and effects are keyed by state and get their keys renamed too
 * @returns {{initialState: string, transitions: Object, hierarchical: boolean, visibility?: Object, effects?: Object}}
 *   hierarchical: the names come from the data hierarchy rather than from click paths
 */
function prettifyStates(data) {
  const { initialState, transitions } = data;

  const hierarchy = hierarchyLabels(data);
  const labelOf = hierarchy || new Map([[initialState, ROOT_LABEL]]);
  // With a hierarchy, everything reachable by clicks is already named; states
  // reached only through a hover ("root > Hover_menu") are named from their origin.
  const queue = hierarchy ? [...hierarchy.keys()] : [initialState];

  while (queue.length > 0) {
    const state = queue.shift();
    const actions = transitions[state] || {};
    for (const [action, next] of Object.entries(actions)) {
      if (next === ERROR_STATE || labelOf.has(next)) continue;
      const short = displayAction(action);
      let label = `${labelOf.get(state)}${HIERARCHY_SEPARATOR}${short}`;
      const existing = new Set(labelOf.values());
      let suffix = 2;
      while (existing.has(label)) label = `${labelOf.get(state)}${HIERARCHY_SEPARATOR}${short}#${suffix++}`;
      labelOf.set(next, label);
      queue.push(next);
    }
  }

  const renamedTransitions = {};
  for (const [state, actions] of Object.entries(transitions)) {
    const newState = labelOf.get(state) ?? state; // a state unreachable from initialState (should not happen)
    const renamedActions = {};
    for (const [action, next] of Object.entries(actions)) {
      renamedActions[action] = next === ERROR_STATE ? next : (labelOf.get(next) ?? next);
    }
    renamedTransitions[newState] = renamedActions;
  }

  const result = {
    initialState: labelOf.get(initialState),
    transitions: renamedTransitions,
    hierarchical: !!hierarchy,
  };
  const renameState = (state) => labelOf.get(state) ?? state;
  if (data.visibility) result.visibility = mapKeys(data.visibility, renameState);
  if (data.effects) result.effects = mapKeys(data.effects, renameState);
  return result;
}

/**
 * Names by the data HIERARCHY ("root > vis > operator") instead of by click
 * path. The shortest click path does not say what level a state is at: a
 * sunburst shows two rings, so from the root "operator" (level 2) is
 * clicked directly, and BFS would name it "root > operator", level with
 * "vis", and the diagram would draw vis -> operator as a sideways move.
 *
 * Each action carries the full readable name of the clicked element IN its
 * source state (`data.labels`, see collectResult in lib/crawl/graph.js), which in a hierarchical
 * visualization is a path ("flare/vis/operator", from the <title> or the D3
 * datum). A state's path is the longest common prefix (by segments) of the
 * paths of all actions that enter it: entering "animate" in an icicle is
 * either clicking animate (flare/animate) or clicking a focused child
 * (flare/animate/Easing, which goes up to the parent); the common prefix is
 * flare/animate.
 *
 * All or nothing: if some state has no path, two states share a path, or one
 * does not hang from the initial state's path, it returns null and the
 * click-path names are used (non-hierarchical visualizations).
 *
 * @returns {Map<string, string> | null} state -> name
 */
function hierarchyLabels({ initialState, transitions, labels }) {
  if (!labels) return null;

  // Only clicks count: they are what descends the data hierarchy. A hover on
  // "flare/vis" that does not change state (or the way back from a hover)
  // would also "enter" a state with that path and pollute the name.
  const isClick = (action) => verbOf(action) === 'click';
  const reachable = new Set([initialState]);
  const queue = [initialState];
  while (queue.length) {
    for (const [action, next] of Object.entries(transitions[queue.shift()] || {})) {
      if (isClick(action) && next !== ERROR_STATE && !reachable.has(next)) { reachable.add(next); queue.push(next); }
    }
  }

  const incoming = new Map();
  for (const state of reachable) {
    for (const [action, next] of Object.entries(transitions[state] || {})) {
      const readable = labels[state] && labels[state][action];
      if (!isClick(action) || next === ERROR_STATE || typeof readable !== 'string') continue;
      const segments = readable.split('/').map((s) => s.trim()).filter(Boolean);
      if (segments.length === 0) continue;
      if (!incoming.has(next)) incoming.set(next, []);
      incoming.get(next).push(segments);
    }
  }

  const commonPrefix = (paths) => {
    let prefix = paths[0];
    for (const p of paths.slice(1)) {
      let k = 0;
      while (k < prefix.length && k < p.length && prefix[k] === p[k]) k++;
      prefix = prefix.slice(0, k);
    }
    return prefix;
  };

  const pathOf = new Map();
  for (const state of reachable) {
    if (state === initialState) continue;
    const paths = incoming.get(state);
    if (!paths) return null;
    const path = commonPrefix(paths);
    if (path.length === 0) return null;
    pathOf.set(state, path);
  }
  // the initial state may have no action entering it (nothing "goes back")
  const rootPath = incoming.has(initialState)
    ? commonPrefix(incoming.get(initialState))
    : commonPrefix([...pathOf.values()]);
  if (!rootPath || rootPath.length === 0) return null;

  const out = new Map([[initialState, ROOT_LABEL]]);
  const used = new Set([ROOT_LABEL]);
  for (const [state, path] of pathOf) {
    const hangsFromRoot = path.length > rootPath.length && rootPath.every((seg, i) => path[i] === seg);
    const rest = path.slice(rootPath.length);
    if (!hangsFromRoot || rest.some((seg) => seg.includes(HIERARCHY_SEPARATOR.trim()))) return null;
    const label = [ROOT_LABEL, ...rest].join(HIERARCHY_SEPARATOR);
    if (used.has(label)) return null;
    used.add(label);
    out.set(state, label);
  }
  return out;
}

module.exports = { prettifyStates };
