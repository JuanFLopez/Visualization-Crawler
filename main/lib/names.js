/**
 * Cleans the action (and state) names of an already generated transitions.json:
 * removes the numeric suffix that leaks in from the tooltip. A typical D3
 * <title> reads "flare/vis\n432,629" (path + node value), and earlier crawler
 * versions flattened it into "Click_vis_432,629".
 *
 *   "Click_vis_432,629": "root > vis_432,629"  ->  "Click_vis": "root > vis"
 *
 * When removing the number leaves two different actions with the same name
 * (say "data_30,284" and "data_110,583", two "data" nodes in different
 * branches), the first to appear keeps the clean name and the next ones get
 * "#2", "#3"...; two actions are never merged. Idempotent: names that are
 * already clean do not change.
 *
 * First step of lib/report (buildReport), applied to whatever table it gets:
 * a fresh crawl or an old transitions.json re-analyzed with --from.
 */

const { isInternalName, isBarePrefix, displayAction } = require('./actions');
const { ERROR_STATE, HIERARCHY_SEPARATOR } = require('./constants');

// trailing number as d3.format leaves it: "432,629", "989", "1.5", "12%"
const NUMERIC_SUFFIX = /_[-+]?\d[\d.,]*%?$/;

/**
 * "Click_vis_432,629" -> "Click_vis". Internal ids ("Click_unknown_3") and names that would be left as a
 * bare prefix are returned unchanged.
 * @param {string} action
 * @returns {string}
 */
function stripNumber(action) {
  if (isInternalName(action)) return action; // an internal id, not a value
  const stripped = action.replace(NUMERIC_SUFFIX, '');
  return isBarePrefix(stripped) ? action : stripped;
}

/**
 * @param {{initialState: string, transitions: Object, visibility?: Object, effects?: Object}} data -
 *   the per-state tables of the crawl, all keyed by state and then by action
 * @returns {{initialState: string, transitions: Object, renamed: Object, visibility?: Object, effects?: Object}}
 *   the same tables with clean names; renamed: old action -> new action (only the ones that changed).
 *   `reveals` / `hides` of every hover effect are renamed too.
 */
function cleanNames({ initialState, transitions, visibility = null, effects = null }) {
  // first-appearance order, so that disambiguation is stable
  const actions = [];
  const seen = new Set();
  for (const trans of Object.values(transitions)) {
    for (const a of Object.keys(trans)) if (!seen.has(a)) { seen.add(a); actions.push(a); }
  }

  const rename = new Map();
  const taken = new Set();
  // the unchanged ones go first so nobody can "steal" their name
  for (const a of actions) if (stripNumber(a) === a) { rename.set(a, a); taken.add(a); }
  for (const a of actions) {
    if (rename.has(a)) continue;
    const base = stripNumber(a);
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base}#${k}`;
    rename.set(a, name);
    taken.add(name);
  }

  // States: the readable names (lib/labels.js) are paths of actions without
  // the "Click_" prefix (hovers keep theirs), so they are renamed segment by
  // segment with the same map.
  const segRename = new Map();
  for (const [from, to] of rename) segRename.set(displayAction(from), displayAction(to));
  const renameState = (s) => {
    if (s === ERROR_STATE || !s.includes(HIERARCHY_SEPARATOR)) return s;
    return s.split(HIERARCHY_SEPARATOR).map((seg) => segRename.get(seg) ?? seg).join(HIERARCHY_SEPARATOR);
  };
  const renameAction = (a) => rename.get(a) ?? a;

  // a table keyed by state whose rows are keyed by action: states are renamed,
  // and `entryOf(action, value)` gives each row entry as [newAction, newValue]
  const mapTable = (table, entryOf) => Object.fromEntries(Object.entries(table).map(([state, row]) => [
    renameState(state),
    Object.fromEntries(Object.entries(row).map(([action, value]) => entryOf(action, value))),
  ]));

  const renamed = {};
  for (const [a, b] of rename) if (a !== b) renamed[a] = b;
  const result = {
    initialState: renameState(initialState),
    transitions: mapTable(transitions, (a, next) => [rename.get(a), renameState(next)]),
    renamed,
  };
  if (visibility) result.visibility = mapTable(visibility, (a, frac) => [renameAction(a), frac]);
  if (effects) {
    // hover action -> what changes; `reveals` / `hides` name other actions
    const renameAll = (list) => list.map((a) => rename.get(a) ?? stripNumber(a));
    result.effects = mapTable(effects, (a, effect) => {
      const copy = { ...effect };
      if (copy.reveals) copy.reveals = renameAll(copy.reveals);
      if (copy.hides) copy.hides = renameAll(copy.hides);
      return [renameAction(a), copy];
    });
  }
  return result;
}

module.exports = { cleanNames, stripNumber };
