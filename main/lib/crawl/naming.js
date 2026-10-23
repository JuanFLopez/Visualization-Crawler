/**
 * Naming the actions of the automaton. An action's name belongs to the
 * ELEMENT, not to the state: the same element has to be the same alphabet
 * symbol in every state (otherwise the automaton and its regex mean nothing).
 * So it is assigned once per crawl and reused (createNaming), and the names
 * that turn out to depend on the state are fixed when the crawl ends
 * (renameUnstableActions). The prefixes and the display rules live in lib/actions.js.
 */

const { actionName, internalName, kindOfAction, unhoverOf } = require('../actions');
const { gestureKey } = require('./gestures');

// Possible names for the action, from the shortest to the most specific.
function nameOptions(info) {
  if (info.dataName) return [info.dataName];
  if (info.cls.includes('center-circle')) return ['BACK'];

  const options = [];

  if (info.readable) {
    const segments = info.readable
      .replace(/\s+[-+]?\d[\d.,]*%?$/, '')
      .split('/')
      .map((s) => s.trim().replace(/\s+/g, '_'))
      .filter(Boolean);
    for (let k = 1; k <= segments.length; k++) options.push(segments.slice(-k).join('/'));
  } else if (info.isRootSvg) {
    options.push('background');
  }
  if (info.crawlerId) options.push(info.crawlerId);
  return options;
}

/** The selector that finds the candidate `info` again (a replay, a reload). */
function selectorFor(info) {
  if (info.dataName) return `[data-name="${info.dataName}"]`;
  if (info.cls.includes('center-circle')) return 'circle.center-circle';
  if (info.crawlerId) return `[data-crawler-id="${info.crawlerId}"]`;
  // Elements only found when discovering (inline handler, CSS :hover, mark of a
  // delegated listener) have no crawler id: see stableSelector in lib/page/discovery.js.
  if (info.selector) return info.selector;
  throw new Error('interactable element with no stable identity');
}

/** The function that names a candidate: `nameFor(info, gesture)`. */
function createNaming() {
  const byGesture = new Map();
  const taken = new Set();
  let unknownCounter = 0;
  return function nameFor(info, gesture) {
    const key = gestureKey(gesture);
    if (byGesture.has(key)) return byGesture.get(key);
    let name = null;
    const options = nameOptions(info);
    // A hover on the outer <svg> is "the background", like its click; without
    // this it would be named after all the text it contains.
    if (gesture.kind === 'hover' && info.isRootSvg) options.unshift('background');
    for (const opt of options) {
      const candidate = actionName(gesture.kind, opt);
      if (!taken.has(candidate)) { name = candidate; break; }
    }
    if (!name) name = internalName(gesture.kind, unknownCounter++);
    byGesture.set(key, name);
    taken.add(name);
    return name;
  };
}

// An element whose readable name CHANGES with the state cannot carry any of
// those names: the symbol belongs to the element, not to the state. The typical
// case is the sunburst's center circle, which every click re-binds to the
// focus's parent (parent.datum(p.parent)), so in each state it "says" a
// different node. When the crawl ends, those actions are renamed after their
// SVG / HTML tag ("Click_circle"). It reads node.labels, which keeps what was
// seen in each state.
// Renames the graph in place and returns the map old name -> new name.
function renameUnstableActions(graph) {
  const seen = new Map(); // action -> { readables: Set, tag }
  for (const node of graph.values()) {
    for (const [action, { readable, tag }] of Object.entries(node.labels || {})) {
      if (!seen.has(action)) seen.set(action, { readables: new Set(), tag });
      seen.get(action).readables.add(readable);
    }
  }
  const taken = new Set();
  for (const node of graph.values()) for (const a of Object.keys(node.transitions)) taken.add(a);

  const rename = new Map();
  for (const [action, { readables, tag }] of seen) {
    if (readables.size < 2) continue;
    // '#n' and not '_n': lib/names.js strips "_<number>" suffixes
    const kind = kindOfAction(action);
    let name = actionName(kind, tag);
    for (let k = 2; taken.has(name); k++) name = actionName(kind, `${tag}#${k}`);
    taken.delete(action);
    taken.add(name);
    rename.set(action, name);
  }
  // The way back of a hover (Unhover_X) is not a candidate and has no label of
  // its own: it is named after its hover.
  for (const [from, to] of [...rename]) {
    if (kindOfAction(from) !== 'hover' || !taken.has(unhoverOf(from))) continue;
    rename.set(unhoverOf(from), unhoverOf(to));
    taken.delete(unhoverOf(from));
    taken.add(unhoverOf(to));
  }
  if (rename.size === 0) return rename;

  const renameKeys = (obj) => {
    if (!obj) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[rename.get(k) ?? k] = v;
    return out;
  };
  for (const node of graph.values()) {
    node.transitions = renameKeys(node.transitions);
    node.gestures = renameKeys(node.gestures);
    node.visibility = renameKeys(node.visibility);
    node.labels = renameKeys(node.labels);
    node.inert = renameKeys(node.inert);
    node.effects = renameKeys(node.effects);
    for (const effect of Object.values(node.effects || {})) {
      for (const list of [effect.reveals, effect.hides]) {
        if (list) list.forEach((a, i) => { list[i] = rename.get(a) ?? a; });
      }
    }
  }
  return rename;
}

module.exports = { createNaming, selectorFor, renameUnstableActions };
