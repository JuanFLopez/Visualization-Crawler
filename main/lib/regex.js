/**
 * Regex over an ALPHABET OF TOKENS (whole action names such as "Click_A",
 * not single characters), with STANDARD semantics: the regex's language is
 * exactly the set of sequences it matches in full. Tokens are separated by
 * spaces (like the characters of a classic regex, but multi-letter).
 * Grammar:
 *
 *   Regex   := Union
 *   Union   := Concat ('|' Concat)*
 *   Concat  := Postfix*                (juxtaposition = concatenation)
 *   Postfix := Atom ('*' | '+' | '?' | '{n}' | '{n,}' | '{n,m}')*
 *   Atom    := '(' Union ')'           -- '()' is the empty string
 *            | '.'                     -- any symbol of the alphabet
 *            | TOKEN
 *
 * Example: "(Click_A | Click_B) Click_BACK" describes "enter any branch and
 * come back". With '*': "((Click_A | Click_B) Click_BACK)*" describes "repeat
 * that sequence any number of times (zero included)".
 *
 * Besides the parser / compiler, this module does the reverse trip:
 * dfaToRegex() turns a DFA (such as the one the crawler observed) into a
 * regex by state elimination.
 */

const SPECIAL = '()|*+?{},.';

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (SPECIAL.includes(c)) { tokens.push(c); i++; continue; }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !SPECIAL.includes(src[j])) j++;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

function parse(src, alphabet) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (expected) => {
    if (expected !== undefined && tokens[pos] !== expected) {
      const found = tokens[pos] === undefined ? 'el final del regex' : `"${tokens[pos]}" (token ${pos + 1})`;
      throw new Error(`se esperaba "${expected}" pero se encontró ${found}`);
    }
    return tokens[pos++];
  };
  const eatInt = () => {
    const t = eat();
    if (!/^\d+$/.test(t || '')) throw new Error(`se esperaba un número dentro de {} pero se encontró "${t}"`);
    return parseInt(t, 10);
  };

  function parseUnion() {
    const branches = [parseConcat()];
    while (peek() === '|') { eat('|'); branches.push(parseConcat()); }
    return branches.length === 1 ? branches[0] : { type: 'union', branches };
  }

  function parseConcat() {
    const parts = [];
    while (pos < tokens.length && peek() !== '|' && peek() !== ')') {
      parts.push(parsePostfix());
    }
    if (parts.length === 0) return { type: 'epsilon' };
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  function parsePostfix() {
    let node = parseAtom();
    for (;;) {
      const op = peek();
      if (op === '*' || op === '+' || op === '?') {
        eat();
        node = { type: op === '*' ? 'star' : op === '+' ? 'plus' : 'optional', node };
      } else if (op === '{') {
        // standard bounded repetition: {n}, {n,}, {n,m}
        eat('{');
        const min = eatInt();
        let max = min;
        if (peek() === ',') {
          eat(',');
          max = peek() === '}' ? Infinity : eatInt();
        }
        eat('}');
        if (max < min) throw new Error(`repetición inválida {${min},${max}}`);
        node = { type: 'repeat', node, min, max };
      } else {
        return node;
      }
    }
  }

  function parseAtom() {
    if (peek() === '(') {
      eat('(');
      const node = parseUnion();
      eat(')');
      return node;
    }
    if (peek() === '.') {
      eat('.');
      return { type: 'union', branches: [...alphabet].map((t) => ({ type: 'literal', token: t })) };
    }
    const token = eat();
    if (token === undefined) throw new Error('el regex termina donde se esperaba un símbolo o "("');
    if (SPECIAL.includes(token)) throw new Error(`"${token}" inesperado (token ${pos})`);
    return { type: 'literal', token };
  }

  const ast = parseUnion();
  if (pos !== tokens.length) throw new Error(`sobraron tokens desde la posición ${pos}: ${tokens.slice(pos).join(' ')}`);
  return ast;
}

/**
 * The literal tokens that appear in the regex, so that a comparison can tell
 * which symbols it mentions that the crawler never saw (typically typos).
 */
function literalsOf(src) {
  const out = new Set();
  const toks = tokenize(src);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (SPECIAL.includes(t)) continue;
    // numbers inside {n,m} are not symbols
    if (/^\d+$/.test(t) && (toks[i - 1] === '{' || toks[i - 1] === ',')) continue;
    out.add(t);
  }
  return out;
}

// --- Thompson: AST -> NFA with epsilon transitions ---
// Representation: a list of states (indices), each one
// { symbolEdges: Map<symbol, Set<state>>, epsilonEdges: Set<state> }.

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
      case 'empty': {
        return { start: newState(), end: newState() }; // no path between the two
      }
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
        throw new Error(`nodo AST desconocido: ${node.type}`);
    }
  }

  const { start, end } = build(ast);
  return { states, start, accept: end };
}

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

// --- subset construction: NFA -> DFA (partial: no explicit trap state) ---
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

  const { DFA } = require('./automaton');
  return new DFA({ initial: startKey, transitions: dfaTransitions, alphabet: new Set(alphabet), accepting });
}

/**
 * Compiles a regex (string) into a DFA with accepting states (standard
 * semantics). `alphabet` is needed to expand '.' to "any symbol"; the tokens
 * the regex mentions are added on their own.
 */
function compileRegex(src, alphabet = []) {
  const fullAlphabet = new Set([...alphabet, ...literalsOf(src)]);
  const ast = parse(src, fullAlphabet);
  const nfa = astToNfa(ast);
  return nfaToDfa(nfa, fullAlphabet);
}

// ---------------------------------------------------------------------
// DFA -> regex (state elimination)
// ---------------------------------------------------------------------
//
// Intermediate expressions are built with constructors that simplify on the
// spot (otherwise the result grows explosively and is unreadable): flat
// unions without duplicates and with common prefixes / suffixes factored out
// ("a b | a c" -> "a (b | c)"), epsilon absorbed by branches that already
// accept the empty string, stars of stars collapsed, and so on. Internally
// only empty / epsilon / literal / concat / union / star exist; '?' and '+'
// appear only when printing ("(ε | X)" -> "X?", "X X*" -> "X+").

const EMPTY = { type: 'empty' };
const EPS = { type: 'epsilon' };

function keyOf(n) {
  if (n._k === undefined) n._k = print(n, 0);
  return n._k;
}

// Approximate length of print(n) without printing it: the AST is a DAG
// (elimination reuses subexpressions), so printing to measure would cost
// exactly what we want to avoid when the regex explodes.
function sizeOf(n) {
  if (n._n !== undefined) return n._n;
  let s;
  switch (n.type) {
    case 'empty': s = 1; break;
    case 'epsilon': s = 0; break;
    case 'literal': s = n.token.length; break;
    case 'star': s = sizeOf(n.node) + 3; break;
    case 'concat': s = n.parts.reduce((a, p) => a + sizeOf(p) + 1, -1); break;
    case 'union': s = n.branches.reduce((a, b) => a + sizeOf(b) + 3, -1); break;
    default: s = 0;
  }
  n._n = s;
  return s;
}

function nullable(n) {
  switch (n.type) {
    case 'epsilon': case 'star': return true;
    case 'empty': case 'literal': return false;
    case 'concat': return n.parts.every(nullable);
    case 'union': return n.branches.some(nullable);
    default: return false;
  }
}

const partsOf = (n) => (n.type === 'concat' ? n.parts : [n]);

function mkLiteral(token) {
  return { type: 'literal', token };
}

function mkConcat(list) {
  const parts = [];
  for (const p of list) {
    if (p.type === 'empty') return EMPTY;
    if (p.type === 'epsilon') continue;
    if (p.type === 'concat') parts.push(...p.parts);
    else parts.push(p);
  }
  if (parts.length === 0) return EPS;
  if (parts.length === 1) return parts[0];
  return { type: 'concat', parts };
}

function mkUnion(list) {
  const seen = new Set();
  const flat = [];
  let hasEps = false;
  const add = (b) => {
    if (b.type === 'empty') return;
    if (b.type === 'union') { b.branches.forEach(add); return; }
    if (b.type === 'epsilon') { hasEps = true; return; }
    const k = keyOf(b);
    if (seen.has(k)) return;
    seen.add(k);
    flat.push(b);
  };
  list.forEach(add);

  let branches = factor(flat, 'prefix');
  branches = factor(branches, 'suffix');

  if (hasEps && !branches.some(nullable)) branches.push(EPS);
  if (branches.length === 0) return hasEps ? EPS : EMPTY;
  if (branches.length === 1) return branches[0];
  return { type: 'union', branches };
}

// "a b | a c | d" -> "a (b | c) | d" (or the analogue by suffix). Keeps the
// order of appearance so the output is stable.
function factor(branches, side) {
  const groups = new Map();
  for (const b of branches) {
    const parts = partsOf(b);
    const edge = side === 'prefix' ? parts[0] : parts[parts.length - 1];
    const k = keyOf(edge);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  if (groups.size === branches.length) return branches;
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const rests = group.map((b) => {
      const parts = partsOf(b);
      return mkConcat(side === 'prefix' ? parts.slice(1) : parts.slice(0, -1));
    });
    const edge = side === 'prefix' ? partsOf(group[0])[0] : partsOf(group[0]).slice(-1)[0];
    out.push(side === 'prefix' ? mkConcat([edge, mkUnion(rests)]) : mkConcat([mkUnion(rests), edge]));
  }
  return out;
}

function mkStar(n) {
  if (n.type === 'empty' || n.type === 'epsilon') return EPS;
  if (n.type === 'star') return n;
  if (n.type === 'union') {
    // (ε | a* | b)* = (a | b)*
    const inner = n.branches
      .filter((b) => b.type !== 'epsilon')
      .map((b) => (b.type === 'star' ? b.node : b));
    return { type: 'star', node: mkUnion(inner) };
  }
  return { type: 'star', node: n };
}

// precedence: 0 = union, 1 = concatenation, 2 = postfix / atom
function print(n, prec = 0) {
  const wrap = (s, p) => (prec > p ? `(${s})` : s);
  switch (n.type) {
    case 'empty': return '∅';
    case 'epsilon': return '()';
    case 'literal': return n.token;
    case 'star': return `${print(n.node, 2)}*`;
    case 'concat': {
      const out = [];
      const ps = n.parts;
      for (let i = 0; i < ps.length; i++) {
        const next = ps[i + 1];
        if (next && next.type === 'star' && keyOf(next.node) === keyOf(ps[i])) {
          out.push(`${print(ps[i], 2)}+`); // X X* -> X+
          i++;
        } else {
          out.push(print(ps[i], 1));
        }
      }
      return wrap(out.join(' '), 1);
    }
    case 'union': {
      const nonEps = n.branches.filter((b) => b.type !== 'epsilon');
      if (nonEps.length < n.branches.length) {
        // (ε | X) -> X?
        const rest = nonEps.length === 1 ? nonEps[0] : { type: 'union', branches: nonEps };
        return wrap(`${print(rest, 2)}?`, 1);
      }
      return wrap(n.branches.map((b) => print(b, 0)).join(' | '), 0);
    }
    default:
      throw new Error(`nodo AST desconocido: ${n.type}`);
  }
}

/**
 * Regex (string, standard semantics) whose language is exactly the DFA's:
 * the symbol sequences that end in an accepting state starting from the
 * initial one. `exclude` leaves states out (such as the crawler's __ERROR__).
 *
 * Returns null when the regex is longer than `maxLength` characters (see
 * dfaToRegexTrace to find out where it blew up).
 */
function dfaToRegex(dfa, opts = {}) {
  return dfaToRegexTrace(dfa, opts).regex;
}

/**
 * Same as dfaToRegex, but also returns the elimination trace.
 *
 * Why it is needed: in a dense graph (many states that reach one another,
 * for example a circle pack where the neighbouring circles peeking out of
 * the corners can be clicked) the regex grows EXPONENTIALLY: each eliminated
 * state copies its loop into every predecessor / successor pair, and the ones
 * eliminated first end up copied hundreds of thousands of times. It is not an
 * error of the automaton but an inherent limit of turning a dense graph into
 * a regex. So elimination stops once `maxLength` is exceeded (measured as the
 * sum of all remaining edges, which in practice matches the length of the
 * final regex) and reports which states were left: they are the dense core
 * that makes it explode.
 *
 * @returns {{
 *   regex: string|null,
 *   aborted: boolean,
 *   steps: {step: number, state: string, preds: number, succs: number, loopSize: number, totalSize: number}[],
 *   remaining: string[],
 * }} remaining: states not eliminated when it stopped (empty if it did not stop)
 */
function dfaToRegexTrace(dfa, { exclude = [], maxLength = Infinity } = {}) {
  const START = '\u0000start', FINAL = '\u0000final';
  const skip = new Set(exclude);

  // edges: from -> Map(to -> ast), with unions merged
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

  // only states reachable from the initial one (and not excluded)
  const reachable = new Set([dfa.initial]);
  const depth = new Map([[dfa.initial, 0]]);
  const q = [dfa.initial];
  while (q.length) {
    const s = q.shift();
    const m = dfa.transitions.get(s);
    if (!m) continue;
    for (const to of m.values()) {
      if (skip.has(to) || reachable.has(to)) continue;
      reachable.add(to);
      depth.set(to, depth.get(s) + 1);
      q.push(to);
    }
  }

  addEdge(START, dfa.initial, EPS);
  for (const s of reachable) {
    ensure(s);
    if (dfa.isAccepting(s)) addEdge(s, FINAL, EPS);
    const m = dfa.transitions.get(s);
    if (!m) continue;
    for (const [symbol, to] of m) {
      if (reachable.has(to)) addEdge(s, to, mkLiteral(symbol));
    }
  }

  const remaining = new Set(reachable);
  const steps = [];
  while (remaining.size) {
    // Eliminate the cheapest state first (fewest paths to combine); on a tie,
    // the deepest one, so the result nests like the visualization's hierarchy.
    let best = null, bestCost = Infinity;
    for (const s of remaining) {
      const ins = [...inc.get(s).keys()].filter((p) => p !== s).length;
      const outs = [...out.get(s).keys()].filter((r) => r !== s).length;
      const cost = ins * outs;
      if (cost < bestCost || (cost === bestCost && depth.get(s) > depth.get(best))) {
        best = s; bestCost = cost;
      }
    }

    const s = best;
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
    remaining.delete(s);

    let totalSize = 0;
    for (const m of out.values()) for (const ast of m.values()) totalSize += sizeOf(ast);
    steps.push({ step: steps.length + 1, state: s, preds: preds.length, succs: succs.length, loopSize: loop ? sizeOf(loop) : 0, totalSize });
    if (totalSize > maxLength) return { regex: null, aborted: true, steps, remaining: [...remaining] };
  }

  const result = (out.get(START) && out.get(START).get(FINAL)) || EMPTY;
  const regex = print(result, 0);
  if (regex.length > maxLength) return { regex: null, aborted: true, steps, remaining: [] };
  return { regex, aborted: false, steps, remaining: [] };
}

module.exports = { compileRegex, dfaToRegex, dfaToRegexTrace, parse, tokenize, literalsOf };
