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
 */

const { isInternalName, isBarePrefix, displayAction } = require('./actions');

const ERROR_STATE = '__ERROR__';

// trailing number as d3.format leaves it: "432,629", "989", "1.5", "12%"
const NUMERIC_SUFFIX = /_[-+]?\d[\d.,]*%?$/;

function stripNumber(action) {
  if (isInternalName(action)) return action; // an internal id, not a value
  const stripped = action.replace(NUMERIC_SUFFIX, '');
  return isBarePrefix(stripped) ? action : stripped;
}

/**
 * @param {{initialState: string, transitions: Object, visibility?: Object, effects?: Object}} data
 * @returns {{initialState: string, transitions: Object, renamed: Object, visibility?: Object, effects?: Object}}
 *   renamed: old action -> new action (only the ones that changed)
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
  const SEP = ' > ';
  const segRename = new Map();
  for (const [from, to] of rename) segRename.set(displayAction(from), displayAction(to));
  const renameState = (s) => {
    if (s === ERROR_STATE || !s.includes(SEP)) return s;
    return s.split(SEP).map((seg) => segRename.get(seg) ?? seg).join(SEP);
  };

  const out = {};
  for (const [state, trans] of Object.entries(transitions)) {
    const t = {};
    for (const [a, next] of Object.entries(trans)) t[rename.get(a)] = renameState(next);
    out[renameState(state)] = t;
  }

  const renamed = {};
  for (const [a, b] of rename) if (a !== b) renamed[a] = b;
  const result = { initialState: renameState(initialState), transitions: out, renamed };
  if (visibility) {
    result.visibility = {};
    for (const [state, byAction] of Object.entries(visibility)) {
      const v = {};
      for (const [a, frac] of Object.entries(byAction)) v[rename.get(a) ?? a] = frac;
      result.visibility[renameState(state)] = v;
    }
  }
  if (effects) {
    // hover action -> what changes; `reveals` / `hides` name other actions
    const renameAll = (list) => list.map((a) => rename.get(a) ?? stripNumber(a));
    result.effects = {};
    for (const [state, byAction] of Object.entries(effects)) {
      const e = {};
      for (const [a, effect] of Object.entries(byAction)) {
        const copy = { ...effect };
        if (copy.reveals) copy.reveals = renameAll(copy.reveals);
        if (copy.hides) copy.hides = renameAll(copy.hides);
        e[rename.get(a) ?? a] = copy;
      }
      result.effects[renameState(state)] = e;
    }
  }
  return result;
}

module.exports = { cleanNames, stripNumber };
