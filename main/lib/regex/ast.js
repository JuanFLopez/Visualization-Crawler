/**
 * The regex AST that state elimination builds, and its printer.
 *
 * Intermediate expressions are built with constructors that simplify on the
 * spot (otherwise the result grows explosively and is unreadable): flat
 * unions without duplicates and with common prefixes / suffixes factored out
 * ("a b | a c" -> "a (b | c)"), epsilon absorbed by branches that already
 * accept the empty string, stars of stars collapsed, and so on. Internally
 * only empty / epsilon / literal / concat / union / star exist; '?' and '+'
 * appear only when printing ("(ε | X)" -> "X?", "X X*" -> "X+").
 *
 * Nodes are plain objects ({type, token} / {type, parts} / {type, branches} /
 * {type, node}) and may be SHARED between expressions: state elimination
 * reuses sub-expressions, so the AST is a DAG. Printing a node and measuring
 * it are both cached on the node (`_k`, `_n`), which is why sizeOf can say how
 * long a regex would be without printing it. Used by eliminate.js.
 */

const EMPTY = { type: 'empty' };
const EPS = { type: 'epsilon' };

/** A key that identifies the expression `n` (its printed form, cached on the node), to spot duplicates. */
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

/** Does `n` accept the empty string? */
function nullable(n) {
  switch (n.type) {
    case 'epsilon': case 'star': return true;
    case 'empty': case 'literal': return false;
    case 'concat': return n.parts.every(nullable);
    case 'union': return n.branches.some(nullable);
    default: return false;
  }
}

// the factors of a concatenation, or the node itself as the only factor
const partsOf = (n) => (n.type === 'concat' ? n.parts : [n]);

/** @param {string} token - an action name */
function mkLiteral(token) {
  return { type: 'literal', token };
}

/** Concatenation: nested concats are flattened, epsilon disappears and `empty` absorbs everything. */
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

/**
 * Union: nested unions are flattened, duplicates and `empty` dropped, common
 * prefixes and suffixes factored out, and epsilon kept only when no branch
 * already accepts the empty string.
 */
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

/** Kleene star of `n`, collapsing the cases that need none: (empty)* = (epsilon)* = epsilon, (a*)* = a*, (ε | a* | b)* = (a | b)*. */
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

/**
 * The regex text of `n`, parenthesized only where the precedence needs it.
 * @param {Object} n - an AST node built with the mk* functions
 * @param {number} [prec=0] - precedence of the context: 0 = union, 1 = concatenation, 2 = postfix / atom
 * @returns {string} tokens separated by spaces; '()' is the empty string and '∅' the empty language
 */
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
      throw new Error(`unknown AST node: ${n.type}`);
  }
}

module.exports = { EMPTY, EPS, mkLiteral, mkConcat, mkUnion, mkStar, print, sizeOf };
