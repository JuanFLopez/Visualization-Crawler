/**
 * Compares the languages of two DFAs (with acceptance, see automaton.js),
 * looking for symbol sequences that one accepts and the other does not.
 *
 * BFS over pairs (stateA, stateB) exploring the union of both alphabets; null
 * stands for "already rejected" (the DFA is partial). Whenever a pair differs
 * in acceptance, the path to it is a concrete counterexample, and being BFS
 * it is among the shortest. More than one is collected: up to `limit` per
 * direction (each pair is visited once, so they are counterexamples from
 * different "places" of the automaton, not trivial extensions of one).
 */

const { compositeKey } = require('./util');

/**
 * @param {import('./automaton').DFA} dfaA - sequences only it accepts end up in `onlyInA`
 * @param {import('./automaton').DFA} dfaB
 * @param {Object} [opts]
 * @param {number} [opts.limit=10] - counterexamples to collect per direction
 * @param {number} [opts.maxDepth=200] - longest sequence explored
 * @returns {{
 *   equivalent: boolean,
 *   onlyInA: string[][],   // sequences A accepts and B does not
 *   onlyInB: string[][],   // sequences B accepts and A does not
 *   truncated: boolean,    // stopped on reaching `limit` in some direction
 * }}
 */
function diff(dfaA, dfaB, { limit = 10, maxDepth = 200 } = {}) {
  const alphabet = [...new Set([...dfaA.alphabet, ...dfaB.alphabet])].sort();
  const acc = (dfa, s) => s !== null && dfa.isAccepting(s);
  const step = (dfa, s, sym) => (s === null ? null : dfa.step(s, sym));

  const onlyInA = [], onlyInB = [];
  let truncated = false;
  // A side that already rejected (null) is also told apart by WHERE it
  // rejected (the state of the side that fell off, plus the symbol); otherwise
  // two different errors that continue to the same state on the other side
  // would merge into one (e.g. two options missing from the regex that return
  // to the same place).
  const visited = new Set();
  const keyOf = (a, b, deadA, deadB) => compositeKey(a, b, a === null ? deadA : '', b === null ? deadB : '');
  const queue = [{ a: dfaA.initial, b: dfaB.initial, path: [], deadA: null, deadB: null }];
  visited.add(keyOf(dfaA.initial, dfaB.initial));

  while (queue.length) {
    const { a, b, path, deadA, deadB } = queue.shift();
    const accA = acc(dfaA, a), accB = acc(dfaB, b);

    if (accA !== accB) {
      const list = accA ? onlyInA : onlyInB;
      if (list.length < limit) list.push(path);
      else truncated = true;
      // once one side has rejected, every extension the other accepts is the
      // same difference, only longer: following it adds nothing new
      if (a === null || b === null) continue;
    }
    if (path.length >= maxDepth) continue;
    if (onlyInA.length >= limit && onlyInB.length >= limit) { truncated = true; break; }

    for (const sym of alphabet) {
      const na = step(dfaA, a, sym), nb = step(dfaB, b, sym);
      if (na === null && nb === null) continue;
      const nDeadA = a !== null && na === null ? compositeKey(a, sym) : deadA;
      const nDeadB = b !== null && nb === null ? compositeKey(a, sym) : deadB;
      const k = keyOf(na, nb, nDeadA, nDeadB);
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push({ a: na, b: nb, path: [...path, sym], deadA: nDeadA, deadB: nDeadB });
    }
  }

  return { equivalent: onlyInA.length === 0 && onlyInB.length === 0, onlyInA, onlyInB, truncated };
}

module.exports = { diff };
