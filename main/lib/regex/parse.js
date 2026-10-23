/**
 * Parser for a regex over an ALPHABET OF TOKENS (whole action names such as
 * "Click_A", not single characters), with STANDARD semantics: the regex's
 * language is exactly the set of sequences it matches in full. Tokens are
 * separated by spaces (like the characters of a classic regex, but
 * multi-letter). Grammar:
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
 * parse() builds an AST that compile.js turns into an automaton:
 *
 * @typedef {(
 *   {type: 'literal', token: string} |
 *   {type: 'epsilon'} |
 *   {type: 'concat', parts: AstNode[]} |
 *   {type: 'union', branches: AstNode[]} |
 *   {type: 'star' | 'plus' | 'optional', node: AstNode} |
 *   {type: 'repeat', node: AstNode, min: number, max: number}
 * )} AstNode `max` is Infinity for {n,}
 */

const SPECIAL = '()|*+?{},.';

/**
 * Splits a regex into tokens: the special characters on their own and every
 * other run of non-space characters (an action name) as one token.
 * @param {string} src
 * @returns {string[]}
 */
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

/**
 * Recursive-descent parser for the grammar above.
 * @param {string} src
 * @param {Iterable<string>} alphabet - what '.' expands to
 * @returns {AstNode}
 * @throws {Error} with a message that says what was expected and where, for a syntax error
 */
function parse(src, alphabet) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (expected) => {
    if (expected !== undefined && tokens[pos] !== expected) {
      const found = tokens[pos] === undefined ? 'the end of the regex' : `"${tokens[pos]}" (token ${pos + 1})`;
      throw new Error(`expected "${expected}" but found ${found}`);
    }
    return tokens[pos++];
  };
  const eatInt = () => {
    const t = eat();
    if (!/^\d+$/.test(t || '')) throw new Error(`expected a number inside {} but found "${t}"`);
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
        if (max < min) throw new Error(`invalid repetition {${min},${max}}`);
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
    if (token === undefined) throw new Error('the regex ends where a symbol or "(" was expected');
    if (SPECIAL.includes(token)) throw new Error(`unexpected "${token}" (token ${pos})`);
    return { type: 'literal', token };
  }

  const ast = parseUnion();
  if (pos !== tokens.length) throw new Error(`leftover tokens from position ${pos}: ${tokens.slice(pos).join(' ')}`);
  return ast;
}

/**
 * The literal tokens that appear in the regex, so that a comparison can tell
 * which symbols it mentions that the crawler never saw (typically typos).
 * @param {string} src
 * @returns {Set<string>} the tokens that are action names (not operators, not the numbers of {n,m})
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

module.exports = { tokenize, parse, literalsOf };
