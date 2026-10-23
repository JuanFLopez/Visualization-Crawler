/**
 * Cycle detection in the observed automaton, used to cut the regex.
 *
 * The exact regex blows up on dense graphs (see dfaToRegexTrace in
 * lib/regex.js). What makes it blow up is not the "there and back" cycles of
 * a hierarchy (entering a branch and zooming back out) but SHORTCUTS: jumps
 * to a state outside the current branch (a deep sunburst ring clicked from
 * the root, a neighbouring circle peeking out of a zoomed circle pack). Each
 * shortcut ties subtrees together and state elimination ends up copying loops
 * into every pair.
 *
 * A spanning tree is built from the initial state and every transition is
 * classified:
 *   - tree:     parent -> child in the tree
 *   - back:     to an ancestor (or to itself): CLOSES A CYCLE
 *   - shortcut: to any other state already reached through another branch
 *
 * The "cut" automaton (tree + back) keeps every state and every cycle that
 * goes back up, and its regex nests like the hierarchy; shortcuts are
 * reported separately. Cut regex + list of shortcuts = the full automaton.
 *
 * Tree: when state names are hierarchy paths ("root > vis > operator", see
 * lib/labels.js) the parent is the name's prefix. A DFS or BFS over a sunburst
 * takes whoever discovered a state first as its parent, and on a circle pack
 * that chains siblings (vis -> animate -> flex) as if they were levels. With
 * no hierarchy in the names (or when the parent has no transition to the
 * child) the parent is the BFS one.
 */

const { DFA } = require('./automaton');
const { ERROR_STATE, HIERARCHY_SEPARATOR: SEP } = require('./constants');
const { compositeKey } = require('./util');

/**
 * Classifies every transition of the states reachable from the initial one.
 * @param {import('./automaton').DFA} dfa - the observed automaton
 * @returns {{
 *   counts: {tree: number, back: number, shortcut: number},
 *   shortcuts: {state: string, action: string, to: string}[],
 *   kindOf: (state: string, action: string) => 'tree'|'back'|'shortcut'|null,
 * }}
 */
function classifyEdges(dfa) {
  const succ = (s) => dfa.transitions.get(s) || new Map();

  const { order, parent: bfsParent } = dfa.bfs({ skip: [ERROR_STATE] });
  const reachable = new Set(order);

  const hierarchical = [...reachable].every((s) => s === dfa.initial || s.startsWith(dfa.initial + SEP));
  const parent = new Map();
  for (const s of reachable) {
    if (s === dfa.initial) continue;
    const up = s.split(SEP).slice(0, -1).join(SEP);
    const hasEdge = hierarchical && reachable.has(up) && [...succ(up).values()].includes(s);
    parent.set(s, hasEdge ? up : bfsParent.get(s));
  }
  // Mixing name-based and BFS parents could, in a pathological case, build a
  // parent cycle; such a state falls back to its BFS parent (BFS-only chains
  // always end at the initial state).
  for (let changed = true; changed;) {
    changed = false;
    for (const s of parent.keys()) {
      const seen = new Set();
      let c = s;
      while (c !== undefined && !seen.has(c)) { seen.add(c); c = parent.get(c); }
      if (c !== undefined && parent.get(s) !== bfsParent.get(s)) { parent.set(s, bfsParent.get(s)); changed = true; }
    }
  }

  const isAncestor = (a, s) => {
    for (let c = s; c !== undefined; c = parent.get(c)) if (c === a) return true;
    return false;
  };

  const kinds = new Map();
  const counts = { tree: 0, back: 0, shortcut: 0 };
  const shortcuts = [];
  for (const s of reachable) {
    for (const [action, to] of succ(s)) {
      if (to === ERROR_STATE) continue;
      const kind = parent.get(to) === s ? 'tree' : isAncestor(to, s) ? 'back' : 'shortcut';
      kinds.set(compositeKey(s, action), kind);
      counts[kind]++;
      if (kind === 'shortcut') shortcuts.push({ state: s, action, to });
    }
  }

  return {
    counts,
    shortcuts,
    /** @returns {'tree'|'back'|'shortcut'|null} null for __ERROR__ or a transition from an unreachable state */
    kindOf: (state, action) => kinds.get(compositeKey(state, action)) || null,
  };
}

/**
 * The DFA with only its tree and back transitions (same alphabet and acceptance).
 * @param {import('./automaton').DFA} dfa
 * @param {ReturnType<typeof classifyEdges>} cls - the classification of `dfa`
 * @returns {import('./automaton').DFA}
 */
function cutDfa(dfa, cls) {
  const transitions = new Map();
  for (const [s, m] of dfa.transitions) {
    const kept = new Map();
    for (const [action, to] of m) {
      const kind = cls.kindOf(s, action);
      if (kind === 'tree' || kind === 'back') kept.set(action, to);
    }
    transitions.set(s, kept);
  }
  return new DFA({ initial: dfa.initial, transitions, alphabet: dfa.alphabet, accepting: dfa.accepting });
}

module.exports = { classifyEdges, cutDfa };
