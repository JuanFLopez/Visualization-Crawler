/**
 * DFA -> regex by state elimination.
 *
 * Why the elimination trace is returned: in a dense graph (many states that
 * reach one another, for example a circle pack where the neighbouring circles
 * peeking out of the corners can be clicked) the regex grows EXPONENTIALLY:
 * each eliminated state copies its loop into every predecessor / successor
 * pair, and the ones eliminated first end up copied hundreds of thousands of
 * times. It is not an error of the automaton but an inherent limit of turning
 * a dense graph into a regex. So elimination stops once `maxLength` is
 * exceeded (measured as the sum of all remaining edges, which in practice
 * matches the length of the final regex) and reports which states were left:
 * they are the dense core that makes it explode.
 */

const { EMPTY, EPS, mkLiteral, mkConcat, mkUnion, mkStar, print, sizeOf } = require('./ast');

const START = '\u0000start', FINAL = '\u0000final';

/** Edges as from -> Map(to -> ast) and the inverse, with parallel edges merged into a union. */
function createEdgeGraph() {
  const out = new Map();
  const inc = new Map();
  const ensure = (s) => {
    if (!out.has(s)) out.set(s, new Map());
    if (!inc.has(s)) inc.set(s, new Map());
  };
  const addEdge = (from, to, ast) => {
    ensure(from); ensure(to);
    const prev = out.get(from).get(to);
    const merged = prev ? mkUnion([prev, ast]) : ast;
    out.get(from).set(to, merged);
    inc.get(to).set(from, merged);
  };
  return { out, inc, ensure, addEdge };
}

/** The DFA's transitions between `reachable` states, plus START -> initial and accepting -> FINAL. */
function buildEdgeGraph(dfa, reachable) {
  const graph = createEdgeGraph();
  graph.addEdge(START, dfa.initial, EPS);
  for (const s of reachable) {
    graph.ensure(s);
    if (dfa.isAccepting(s)) graph.addEdge(s, FINAL, EPS);
    const m = dfa.transitions.get(s);
    if (!m) continue;
    for (const [symbol, to] of m) {
      if (reachable.has(to)) graph.addEdge(s, to, mkLiteral(symbol));
    }
  }
  return graph;
}

/**
 * The state to eliminate next: the cheapest one (fewest paths to combine); on
 * a tie, the deepest one, so the result nests like the visualization's hierarchy.
 */
function cheapestState(remaining, { out, inc }, depth) {
  let best = null, bestCost = Infinity;
  for (const s of remaining) {
    const ins = [...inc.get(s).keys()].filter((p) => p !== s).length;
    const outs = [...out.get(s).keys()].filter((r) => r !== s).length;
    const cost = ins * outs;
    if (cost < bestCost || (cost === bestCost && depth.get(s) > depth.get(best))) {
      best = s; bestCost = cost;
    }
  }
  return best;
}

/** Removes `s`, joining every predecessor to every successor through its loop. */
function eliminateState({ out, inc, addEdge }, s) {
  const loop = out.get(s).get(s);
  const loopStar = loop ? mkStar(loop) : EPS;
  const preds = [...inc.get(s)].filter(([p]) => p !== s);
  const succs = [...out.get(s)].filter(([r]) => r !== s);
  for (const [p] of preds) out.get(p).delete(s);
  for (const [r] of succs) inc.get(r).delete(s);
  for (const [p, r1] of preds) {
    for (const [r, r2] of succs) addEdge(p, r, mkConcat([r1, loopStar, r2]));
  }
  out.delete(s); inc.delete(s);
  return { loop, preds, succs };
}

/** Sum of the (approximate) printed lengths of all remaining edges: what the final regex would weigh. */
function totalSize({ out }) {
  let size = 0;
  for (const m of out.values()) for (const ast of m.values()) size += sizeOf(ast);
  return size;
}

/**
 * Regex (string, standard semantics) whose language is exactly the DFA's:
 * the symbol sequences that end in an accepting state starting from the
 * initial one. `exclude` leaves states out (such as the crawler's __ERROR__).
 * The elimination trace comes along, to find out where a regex blew up.
 *
 * @returns {{
 *   regex: string|null,       null when it is longer than `maxLength` characters
 *   aborted: boolean,
 *   steps: {step: number, state: string, preds: number, succs: number, loopSize: number, totalSize: number}[],
 *   remaining: string[],
 * }} remaining: states not eliminated when it stopped (empty if it did not stop)
 */
function dfaToRegexTrace(dfa, { exclude = [], maxLength = Infinity } = {}) {
  // only states reachable from the initial one (and not excluded)
  const { order, depth } = dfa.bfs({ skip: exclude });
  const reachable = new Set(order);
  const graph = buildEdgeGraph(dfa, reachable);

  const remaining = new Set(reachable);
  const steps = [];
  while (remaining.size) {
    const s = cheapestState(remaining, graph, depth);
    const { loop, preds, succs } = eliminateState(graph, s);
    remaining.delete(s);

    const size = totalSize(graph);
    steps.push({ step: steps.length + 1, state: s, preds: preds.length, succs: succs.length, loopSize: loop ? sizeOf(loop) : 0, totalSize: size });
    if (size > maxLength) return { regex: null, aborted: true, steps, remaining: [...remaining] };
  }

  const result = (graph.out.get(START) && graph.out.get(START).get(FINAL)) || EMPTY;
  const regex = print(result, 0);
  if (regex.length > maxLength) return { regex: null, aborted: true, steps, remaining: [] };
  return { regex, aborted: false, steps, remaining: [] };
}

module.exports = { dfaToRegexTrace };
