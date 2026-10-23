/**
 * Regex -> DFA: Thompson's construction (AST -> NFA with epsilon transitions)
 * followed by the subset construction (NFA -> partial DFA). The result is the
 * automaton the expected regex is compared against (lib/report/comparison.js)
 * and what run.js uses to validate a regex before a long crawl.
 */

const { DFA } = require('../automaton');
const { parse, literalsOf } = require('./parse');

// --- Thompson: AST -> NFA with epsilon transitions ---
// Representation: a list of states (indices), each one
// { symbolEdges: Map<symbol, Set<state>>, epsilonEdges: Set<state> }.

/**
 * @param {import('./parse').AstNode} ast
 * @returns {{states: {symbolEdges: Map<string, Set<number>>, epsilonEdges: Set<number>}[], start: number, accept: number}}
 */
function astToNfa(ast) {
  const states = [];
  const newState = () => { states.push({ symbolEdges: new Map(), epsilonEdges: new Set() }); return states.length - 1; };
  const addEpsilon = (from, to) => states[from].epsilonEdges.add(to);
  const addSymbol = (from, symbol, to) => {
    if (!states[from].symbolEdges.has(symbol)) states[from].symbolEdges.set(symbol, new Set());
    states[from].symbolEdges.get(symbol).add(to);
  };

  function build(node) {
    switch (node.type) {
      case 'epsilon': {
        const s = newState(), e = newState();
        addEpsilon(s, e);
        return { start: s, end: e };
      }
      case 'literal': {
        const s = newState(), e = newState();
        addSymbol(s, node.token, e);
        return { start: s, end: e };
      }
      case 'concat': {
        let frag = build(node.parts[0]);
        for (let k = 1; k < node.parts.length; k++) {
          const next = build(node.parts[k]);
          addEpsilon(frag.end, next.start);
          frag = { start: frag.start, end: next.end };
        }
        return frag;
      }
      case 'union': {
        const s = newState(), e = newState();
        for (const branch of node.branches) {
          const frag = build(branch);
          addEpsilon(s, frag.start);
          addEpsilon(frag.end, e);
        }
        return { start: s, end: e };
      }
      case 'star': {
        const s = newState(), e = newState();
        const frag = build(node.node);
        addEpsilon(s, frag.start);
        addEpsilon(frag.end, frag.start);
        addEpsilon(frag.end, e);
        addEpsilon(s, e);
        return { start: s, end: e };
      }
      case 'plus':
        return build({ type: 'concat', parts: [node.node, { type: 'star', node: node.node }] });
      case 'optional':
        return build({ type: 'union', branches: [node.node, { type: 'epsilon' }] });
      case 'repeat': {
        // X{n,m} = X...X (n times) followed by (m-n) X? -- or X* when m = infinity
        const parts = [];
        for (let k = 0; k < node.min; k++) parts.push(node.node);
        if (node.max === Infinity) parts.push({ type: 'star', node: node.node });
        else for (let k = node.min; k < node.max; k++) parts.push({ type: 'optional', node: node.node });
        return build(parts.length === 0 ? { type: 'epsilon' } : { type: 'concat', parts });
      }
      default:
        throw new Error(`unknown AST node: ${node.type}`);
    }
  }

  const { start, end } = build(ast);
  return { states, start, accept: end };
}

/** Every NFA state reachable from `stateSet` through epsilon edges only (including `stateSet`). */
function epsilonClosure(states, stateSet) {
  const stack = [...stateSet];
  const closure = new Set(stateSet);
  while (stack.length) {
    const s = stack.pop();
    for (const t of states[s].epsilonEdges) {
      if (!closure.has(t)) { closure.add(t); stack.push(t); }
    }
  }
  return closure;
}

/**
 * Subset construction: NFA -> DFA. Partial: there is no explicit trap state, a
 * missing transition rejects.
 * @param {ReturnType<typeof astToNfa>} nfa
 * @returns {import('../automaton').DFA} its states are named after the NFA states they stand for ("0,3,4")
 */
function nfaToDfa(nfa, alphabet) {
  const key = (set) => [...set].sort((a, b) => a - b).join(',');
  const startSet = epsilonClosure(nfa.states, new Set([nfa.start]));
  const startKey = key(startSet);

  const dfaStates = new Map(); // key -> Set<nfaState>
  dfaStates.set(startKey, startSet);
  const dfaTransitions = new Map(); // key -> Map<symbol, key>
  const accepting = new Set();
  const queue = [startKey];

  while (queue.length) {
    const curKey = queue.shift();
    const curSet = dfaStates.get(curKey);
    if (curSet.has(nfa.accept)) accepting.add(curKey);
    const edges = new Map();
    for (const symbol of alphabet) {
      let next = new Set();
      for (const s of curSet) {
        const targets = nfa.states[s].symbolEdges.get(symbol);
        if (targets) for (const t of targets) next.add(t);
      }
      if (next.size === 0) continue;
      next = epsilonClosure(nfa.states, next);
      const nextKey = key(next);
      if (!dfaStates.has(nextKey)) { dfaStates.set(nextKey, next); queue.push(nextKey); }
      edges.set(symbol, nextKey);
    }
    dfaTransitions.set(curKey, edges);
  }

  return new DFA({ initial: startKey, transitions: dfaTransitions, alphabet: new Set(alphabet), accepting });
}

/**
 * Compiles a regex (string) into a DFA with accepting states (standard
 * semantics). `alphabet` is needed to expand '.' to "any symbol"; the tokens
 * the regex mentions are added on their own.
 * @param {Iterable<string>} [alphabet]
 * @returns {import('../automaton').DFA}
 * @throws {Error} on a syntax error (see parse)
 */
function compileRegex(src, alphabet = []) {
  const fullAlphabet = new Set([...alphabet, ...literalsOf(src)]);
  const ast = parse(src, fullAlphabet);
  const nfa = astToNfa(ast);
  return nfaToDfa(nfa, fullAlphabet);
}

module.exports = { compileRegex };
