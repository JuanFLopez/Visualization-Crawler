/**
 * Which elements react to a CSS :hover, from the text of the stylesheet rules.
 *
 * A pointer simulated with events does not trigger CSS :hover, and a rule
 * such as `.node:hover circle { stroke: black }` registers no listener the
 * crawler could see. What is visible is the rule's text, and from it comes WHO
 * has to receive the :hover (here `.node`; the circle only changes as a
 * consequence).
 *
 * Both functions are SELF-CONTAINED (no closures, no require): crawler.js
 * injects them into the page with toString(), and the tests call them directly.
 */

/**
 * Selectors of the elements that receive the :hover in a rule.
 * @param {string} selectorText - selectorText of a style rule (may be a list)
 * @returns {string[]} one per complex selector that contains :hover
 *   (`.a:hover, .b > .c:hover` -> [".a", ".b > .c"]); whatever follows the
 *   compound with :hover (`.node:hover circle` -> ".node") is left out
 */
function hoverTargets(selectorText) {
  // walks `text` calling visit(char, index, depth), only outside quotes and escapes
  function scan(text, visit) {
    let depth = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (visit(c, i, depth) === false) return;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
    }
  }

  // the list, split at top-level commas (not the ones in :is(a, b) or [x="a,b"])
  const complexes = [];
  let from = 0;
  scan(selectorText, (c, i, depth) => {
    if (c === ',' && depth === 0) { complexes.push(selectorText.slice(from, i)); from = i + 1; }
  });
  complexes.push(selectorText.slice(from));

  // the compound without its top-level :hover (a :hover inside :not(...) does not count: that means "not hovered")
  function withoutHover(compound) {
    let found = false;
    let out = '';
    let last = 0;
    scan(compound, (c, i, depth) => {
      if (depth === 0 && compound.startsWith(':hover', i) && !/[\w-]/.test(compound[i + 6] || '')) {
        found = true;
        out += compound.slice(last, i);
        last = i + 6;
      }
    });
    return { found, text: out + compound.slice(last) };
  }

  const targets = [];
  for (const raw of complexes) {
    const complex = raw.trim();
    if (!complex) continue;

    // top-level compounds and combinators (space, >, +, ~)
    const compounds = [];
    const combinators = [];
    let start = 0;
    let i = 0;
    const flush = (end) => { if (end > start) compounds.push(complex.slice(start, end)); };
    scan(complex, (c, at, depth) => {
      if (at < i) return;
      if (depth === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~')) {
        flush(at);
        let j = at;
        let kind = ' ';
        while (j < complex.length && (/\s/.test(complex[j]) || '>+~'.includes(complex[j]))) {
          if ('>+~'.includes(complex[j])) kind = complex[j];
          j++;
        }
        if (compounds.length > combinators.length) combinators.push(kind);
        start = j;
        i = j;
      }
    });
    flush(complex.length);

    const index = compounds.findIndex((compound) => withoutHover(compound).found);
    if (index === -1) continue;

    // the element that receives the :hover: without pseudo-elements (::after, :before...), and `*` if nothing is left
    let own = withoutHover(compounds[index]).text
      .replace(/::[\w-]+(\([^)]*\))?/g, '')
      .replace(/:(before|after|first-line|first-letter)\b/g, '');
    if (!own.trim()) own = '*';

    let target = '';
    for (let k = 0; k < index; k++) target += compounds[k] + (combinators[k] === ' ' ? ' ' : ` ${combinators[k]} `);
    target += own;
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

/**
 * Does this property of a :hover rule change how something looks? `cursor` or
 * `transition` do not: a rule that only declares those is not a visible
 * effect, and probing it would spend a hover to find nothing.
 */
function isVisualProperty(name) {
  return !/^(cursor|transition|animation|pointer-events|user-select|-webkit-user-select|-webkit-tap-highlight-color|will-change|touch-action|scroll-behavior|caret-color|resize|appearance|-webkit-appearance)/.test(name);
}

module.exports = { hoverTargets, isVisualProperty };
