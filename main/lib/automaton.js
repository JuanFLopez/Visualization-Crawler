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
 * state. The automaton built from a regex (lib/regex.js) has acceptance of
 * its own (standard semantics).
 */

const ERROR_STATE = '__ERROR__';

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

  /** @returns {string|null} the target state, or null when there is no such transition (string rejected) */
  step(state, symbol) {
    const symbolMap = this.transitions.get(state);
    if (!symbolMap) return null;
    return symbolMap.has(symbol) ? symbolMap.get(symbol) : null;
  }

  states() {
    return [...this.transitions.keys()];
  }
}

/**
 * Builds a DFA from the transitions.json the crawler writes
 * ({ initialState, transitions: { state: { action: targetState } } }).
 * This is the OBSERVED automaton.
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
 * Prefix closure: accepts every sequence that can be EXTENDED to an accepted
 * one. Lets an expected regex that describes complete interactions (such as
 * "(Click_A Click_BACK)*") be compared without spelling out every
 * half-finished interaction.
 */
function prefixClosure(dfa) {
  const preds = new Map();
  for (const [from, m] of dfa.transitions) {
    for (const to of m.values()) {
      if (!preds.has(to)) preds.set(to, new Set());
      preds.get(to).add(from);
    }
  }
  const live = new Set([...dfa.transitions.keys()].filter((s) => dfa.isAccepting(s)));
  const stack = [...live];
  while (stack.length) {
    for (const p of preds.get(stack.pop()) || []) {
      if (!live.has(p)) { live.add(p); stack.push(p); }
    }
  }
  const map = new Map();
  for (const s of live) {
    const m = new Map();
    for (const [sym, to] of dfa.transitions.get(s) || []) if (live.has(to)) m.set(sym, to);
    map.set(s, m);
  }
  const initial = live.has(dfa.initial) ? dfa.initial : null;
  return new DFA({ initial, transitions: map, alphabet: dfa.alphabet, accepting: live });
}

module.exports = { DFA, fromTransitionsJson, prefixClosure, ERROR_STATE };
