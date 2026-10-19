const { displayAction, verbOf } = require('./actions');

/**
 * The crawler identifies each state by a fingerprint (a hash), which is fine
 * for equality but says nothing to a reader. This builds a human name per
 * state from the path of ACTIONS (already readable, see createNaming in
 * crawler.js) that first reaches it from the root: "root", "root > A",
 * "root > A > A1", and so on.
 *
 * It needs nothing from the browser: it works purely on the generated
 * transitions.json, running a BFS (the order in which the crawler discovered
 * the states) and numbering on collisions (which should not happen, since
 * each state has a single shortest path recorded, but just in case).
 *
 * When `data.labels` is also present (readable names per state and action,
 * see crawler.js) and describes a hierarchy, names come from the data
 * hierarchy instead of the click path (see hierarchyLabels).
 *
 * @param {{initialState: string, transitions: Object, visibility?: Object, labels?: Object}} data
 * @param {Object} [opts]
 * @param {string} [opts.rootLabel='root']
 * @param {string} [opts.separator=' > ']
 * @returns {{initialState: string, transitions: Object, labelOf: Object, hierarchical: boolean, visibility?: Object}}
 *   labelOf maps the original hash -> readable name, in case it has to be
 *   correlated with earlier checkpoints or logs.
 */
function prettifyStates(data, { rootLabel = 'root', separator = ' > ' } = {}) {
  const { initialState, transitions } = data;
  const ERROR_STATE = '__ERROR__';

  const hierarchy = hierarchyLabels(data, { rootLabel, separator });
  const labelOf = hierarchy || new Map([[initialState, rootLabel]]);
  // With a hierarchy, everything reachable by clicks is already named; states
  // reached only through a hover ("root > Hover_menu") are named from their origin.
  const queue = hierarchy ? [...hierarchy.keys()] : [initialState];

  while (queue.length > 0) {
    const state = queue.shift();
    const actions = transitions[state] || {};
    for (const [action, next] of Object.entries(actions)) {
      if (next === ERROR_STATE || labelOf.has(next)) continue;
      const short = displayAction(action);
      let label = `${labelOf.get(state)}${separator}${short}`;
      const existing = new Set(labelOf.values());
      let suffix = 2;
      while (existing.has(label)) label = `${labelOf.get(state)}${separator}${short}#${suffix++}`;
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
    labelOf: Object.fromEntries(labelOf),
    hierarchical: !!hierarchy,
  };
  if (data.visibility) {
    result.visibility = {};
    for (const [state, byAction] of Object.entries(data.visibility)) result.visibility[labelOf.get(state) ?? state] = byAction;
  }
  if (data.effects) {
    result.effects = {};
    for (const [state, byAction] of Object.entries(data.effects)) result.effects[labelOf.get(state) ?? state] = byAction;
  }
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
 * source state (`data.labels`, see crawler.js), which in a hierarchical
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
function hierarchyLabels({ initialState, transitions, labels }, { rootLabel = 'root', separator = ' > ' } = {}) {
  if (!labels) return null;
  const ERROR_STATE = '__ERROR__';

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

  const out = new Map([[initialState, rootLabel]]);
  const used = new Set([rootLabel]);
  for (const [state, path] of pathOf) {
    const hangsFromRoot = path.length > rootPath.length && rootPath.every((seg, i) => path[i] === seg);
    const rest = path.slice(rootPath.length);
    if (!hangsFromRoot || rest.some((seg) => seg.includes(separator.trim()))) return null;
    const label = [rootLabel, ...rest].join(separator);
    if (used.has(label)) return null;
    used.add(label);
    out.set(state, label);
  }
  return out;
}

module.exports = { prettifyStates, hierarchyLabels };
