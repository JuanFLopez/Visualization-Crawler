/**
 * A partial DFA over an alphabet of actions (the "Click_X" symbols the
 * crawler discovers). Partial: a state with no transition for a symbol
 * REJECTS the string from there; there is no explicit trap state, a missing
 * transition is just null.
 *
 * In the OBSERVED automaton (the crawler's) every reachable state is
 * accepting except __ERROR__. It does not model "did the run end well" but
 * "can this sequence of actions be performed", so its language is exactly the
 * set of action sequences that can really be executed from the initial
 * state. The automaton built from a regex (lib/regex) has acceptance of
 * its own (standard semantics).
 *
 * This is the shared data structure of the analysis: lib/report builds the
 * observed DFA from transitions.json, lib/cycles cuts it, lib/regex converts it
 * to and from regexes, lib/diff compares two of them and lib/diagram draws one.
 */

const { ERROR_STATE } = require('./constants');

class DFA {
  /**
   * @param {Object} opts
   * @param {string} opts.initial
   * @param {Map<string, Map<string, string>>} opts.transitions - state -> (symbol -> state)
   * @param {Set<string>} [opts.alphabet] - inferred from `transitions` when omitted
   * @param {Set<string>} [opts.accepting] - every state accepts when omitted
   */
  constructor({ initial, transitions, alphabet, accepting = null }) {
    this.initial = initial;
    this.transitions = transitions;
    this.alphabet = alphabet || DFA._inferAlphabet(transitions);
    this.accepting = accepting;
  }

  /** @param {string} state */
  isAccepting(state) {
    return this.accepting ? this.accepting.has(state) : true;
  }

  static _inferAlphabet(transitions) {
    const alphabet = new Set();
    for (const symbolMap of transitions.values()) {
      for (const symbol of symbolMap.keys()) alphabet.add(symbol);
    }
    return alphabet;
  }

  /**
   * @param {string} state
   * @param {string} symbol
   * @returns {string|null} the target state, or null when there is no such transition (string rejected)
   */
  step(state, symbol) {
    const symbolMap = this.transitions.get(state);
    if (!symbolMap) return null;
    return symbolMap.has(symbol) ? symbolMap.get(symbol) : null;
  }

  /** @returns {string[]} the states that have a row in the table (a target that never appears as a source is not listed) */
  states() {
    return [...this.transitions.keys()];
  }

  /**
   * Breadth-first discovery from the initial state, never entering a state in
   * `skip`. The first state to reach another is its parent, so the result does
   * not depend on how the caller later walks it.
   * @returns {{ order: string[], depth: Map<string, number>, parent: Map<string, string>, via: Map<string, string> }}
   *   order: states in discovery order; parent / via: the state and the symbol that first reached each one
   */
  bfs({ skip = [] } = {}) {
    const skipped = new Set(skip);
    const order = [this.initial];
    const depth = new Map([[this.initial, 0]]);
    const parent = new Map();
    const via = new Map();
    for (let i = 0; i < order.length; i++) {
      const from = order[i];
      for (const [symbol, to] of this.transitions.get(from) || []) {
        if (skipped.has(to) || depth.has(to)) continue;
        order.push(to);
        depth.set(to, depth.get(from) + 1);
        parent.set(to, from);
        via.set(to, symbol);
      }
    }
    return { order, depth, parent, via };
  }
}

/**
 * Builds a DFA from the transitions.json the crawler writes
 * ({ initialState, transitions: { state: { action: targetState } } }).
 * This is the OBSERVED automaton: every state accepts except __ERROR__.
 * @param {{initialState: string, transitions: Object<string, Object<string, string>>}} table
 * @returns {DFA}
 */
function fromTransitionsJson({ initialState, transitions }) {
  const map = new Map();
  const accepting = new Set();
  for (const [state, actions] of Object.entries(transitions)) {
    map.set(state, new Map(Object.entries(actions)));
    accepting.add(state);
    for (const to of Object.values(actions)) if (to !== ERROR_STATE) accepting.add(to);
  }
  return new DFA({ initial: initialState, transitions: map, accepting });
}

/**
 * `targets` plus every state that can reach one of them.
 * @param {DFA} dfa
 * @param {Iterable<string>} targets
 * @returns {Set<string>}
 */
function statesReaching(dfa, targets) {
  const preds = new Map();
  for (const [from, m] of dfa.transitions) {
    for (const to of m.values()) {
      if (!preds.has(to)) preds.set(to, new Set());
      preds.get(to).add(from);
    }
  }
  const reaching = new Set(targets);
  const stack = [...reaching];
  while (stack.length) {
    for (const p of preds.get(stack.pop()) || []) {
      if (!reaching.has(p)) { reaching.add(p); stack.push(p); }
    }
  }
  return reaching;
}

/**
 * Prefix closure: accepts every sequence that can be EXTENDED to an accepted
 * one. Lets an expected regex that describes complete interactions (such as
 * "(Click_A Click_BACK)*") be compared without spelling out every
 * half-finished interaction.
 * @param {DFA} dfa - its initial state becomes null when no accepting state is reachable from it
 * @returns {DFA}
 */
function prefixClosure(dfa) {
  const live = statesReaching(dfa, dfa.states().filter((s) => dfa.isAccepting(s)));
  const map = new Map();
  for (const s of live) {
    const m = new Map();
    for (const [sym, to] of dfa.transitions.get(s) || []) if (live.has(to)) m.set(sym, to);
    map.set(s, m);
  }
  const initial = live.has(dfa.initial) ? dfa.initial : null;
  return new DFA({ initial, transitions: map, alphabet: dfa.alphabet, accepting: live });
}

/**
 * The same automaton, accepting only the COMPLETE interactions: the initial
 * state, and the states from which the initial one can no longer be reached.
 * Every valid sequence is a prefix of one of the accepted ones.
 * @param {DFA} dfa
 * @returns {DFA} shares `dfa.transitions`
 */
function completeInteractionsDfa(dfa) {
  const reachesInitial = statesReaching(dfa, [dfa.initial]);
  const accepting = new Set([dfa.initial]);
  for (const s of dfa.states()) if (!reachesInitial.has(s)) accepting.add(s);
  return new DFA({ initial: dfa.initial, transitions: dfa.transitions, alphabet: dfa.alphabet, accepting });
}

module.exports = { DFA, fromTransitionsJson, prefixClosure, completeInteractionsDfa };
