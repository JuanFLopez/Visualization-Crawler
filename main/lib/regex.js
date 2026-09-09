/**
 * Regex sobre un ALFABETO DE TOKENS (nombres de acción completos, p.ej.
 * "Click_A", no caracteres sueltos). Gramática:
 *
 *   Regex   := Union
 *   Union   := Concat ('|' Concat)*
 *   Concat  := Postfix*                (yuxtaposición = concatenación)
 *   Postfix := Atom ('*' | '+' | '?')?
 *   Atom    := '(' Union ')'
 *            | '{' TOKEN (',' TOKEN)* '}'   -- atajo para (a|b|c)
 *            | '.'                          -- cualquier símbolo del alfabeto
 *            | TOKEN
 *
 * Ejemplo: "(Click_A|Click_B) Click_BACK" describe "entrar a una rama
 * cualquiera y volver". Con '*': "((Click_A|Click_B) Click_BACK)*"
 * describe "repetir esa secuencia cualquier cantidad de veces (incluido
 * cero)".
 */

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('()|*+?{},.'.includes(c)) { tokens.push(c); i++; continue; }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !'()|*+?{},.'.includes(src[j])) j++;
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
      throw new Error(`se esperaba "${expected}" pero se encontró "${tokens[pos]}" en la posición ${pos}`);
    }
    return tokens[pos++];
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
    while (peek() === '*' || peek() === '+' || peek() === '?') {
      const op = eat();
      node = { type: op === '*' ? 'star' : op === '+' ? 'plus' : 'optional', node };
    }
    return node;
  }

  function parseAtom() {
    if (peek() === '(') {
      eat('(');
      const node = parseUnion();
      eat(')');
      return node;
    }
    if (peek() === '{') {
      eat('{');
      const options = [eat()];
      while (peek() === ',') { eat(','); options.push(eat()); }
      eat('}');
      return { type: 'union', branches: options.map((t) => ({ type: 'literal', token: t })) };
    }
    if (peek() === '.') {
      eat('.');
      return { type: 'union', branches: [...alphabet].map((t) => ({ type: 'literal', token: t })) };
    }
    const token = eat();
    if ('()|*+?{},.'.includes(token) || token === undefined) {
      throw new Error(`token inesperado: "${token}" en la posición ${pos}`);
    }
    return { type: 'literal', token };
  }

  const ast = parseUnion();
  if (pos !== tokens.length) throw new Error(`sobraron tokens desde la posición ${pos}: ${tokens.slice(pos).join(' ')}`);
  return ast;
}

// --- Thompson: AST -> NFA con transiciones epsilon ---
// Representación: lista de estados (índices), cada uno con
// { symbolEdges: Map<symbol, Set<state>>, epsilonEdges: Set<state> }.

function astToNfa(ast, alphabet) {
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
      case 'plus': {
        const frag = build(node.node);
        const frag2 = build(node.node); // copia independiente para permitir repetición
        addEpsilon(frag.end, frag2.start);
        addEpsilon(frag2.end, frag2.start);
        return { start: frag.start, end: frag2.end };
      }
      case 'optional': {
        const s = newState(), e = newState();
        const frag = build(node.node);
        addEpsilon(s, frag.start);
        addEpsilon(frag.end, e);
        addEpsilon(s, e);
        return { start: s, end: e };
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

// --- subconjuntos: NFA -> DFA (parcial: sin trampa explícita) ---
function nfaToDfa(nfa, alphabet) {
  const key = (set) => [...set].sort((a, b) => a - b).join(',');
  const startSet = epsilonClosure(nfa.states, new Set([nfa.start]));
  const startKey = key(startSet);

  const dfaStates = new Map(); // key -> Set<nfaState>
  dfaStates.set(startKey, startSet);
  const dfaTransitions = new Map(); // key -> Map<symbol, key>
  const queue = [startKey];

  while (queue.length) {
    const curKey = queue.shift();
    const curSet = dfaStates.get(curKey);
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
  return new DFA({ initial: startKey, transitions: dfaTransitions, alphabet: new Set(alphabet) });
}

/**
 * Compila un regex (string) en un DFA, sobre el alfabeto dado (necesario
 * para poder expandir '.' a "cualquier símbolo").
 */
function compileRegex(src, alphabet) {
  const ast = parse(src, alphabet);
  const nfa = astToNfa(ast, alphabet);
  return nfaToDfa(nfa, alphabet);
}

module.exports = { compileRegex, parse, tokenize };
