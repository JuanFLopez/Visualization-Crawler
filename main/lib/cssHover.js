/**
 * Qué elementos reaccionan a un :hover de CSS, a partir del texto de las
 * reglas de las hojas de estilo.
 *
 * Un puntero simulado con eventos no dispara el :hover de CSS, y una regla
 * como `.node:hover circle { stroke: black }` no registra ningún listener
 * que el crawler pueda ver. Lo que sí está a la vista es el texto de la
 * regla: de ahí sale QUIÉN tiene que recibir el :hover (aquí `.node`; el
 * círculo solo cambia como consecuencia).
 *
 * Las dos funciones son AUTOCONTENIDAS (sin closures ni require): crawler.js
 * las inyecta en la página con toString(), y los tests las usan directo.
 */

/**
 * Selectores de los elementos que reciben el :hover en una regla.
 * @param {string} selectorText - selectorText de una regla de estilo (puede ser una lista)
 * @returns {string[]} uno por cada selector complejo que contiene :hover
 *   (`.a:hover, .b > .c:hover` -> [".a", ".b > .c"]); lo que viene después
 *   del compuesto con :hover (`.node:hover circle` -> ".node") no entra
 */
function hoverTargets(selectorText) {
  // recorre `text` llamando a visit(char, index, depth) solo fuera de comillas y escapes
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

  // la lista, partida en las comas de nivel 0 (no las de :is(a, b) ni las de [x="a,b"])
  const complexes = [];
  let from = 0;
  scan(selectorText, (c, i, depth) => {
    if (c === ',' && depth === 0) { complexes.push(selectorText.slice(from, i)); from = i + 1; }
  });
  complexes.push(selectorText.slice(from));

  // el compuesto sin su :hover de nivel 0 (un :hover dentro de :not(...) no cuenta: eso es "no está en hover")
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

    // compuestos y combinadores (espacio, >, +, ~) de nivel 0
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

    // el elemento que recibe el :hover: sin pseudo-elementos (::after, :before...), y `*` si no queda nada
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
 * ¿Esta propiedad de una regla :hover cambia cómo se ve algo? `cursor` o
 * `transition` no: una regla que solo declara eso no es un efecto visible, y
 * probarla sería gastar un hover para no encontrar nada.
 */
function isVisualProperty(name) {
  return !/^(cursor|transition|animation|pointer-events|user-select|-webkit-user-select|-webkit-tap-highlight-color|will-change|touch-action|scroll-behavior|caret-color|resize|appearance|-webkit-appearance)/.test(name);
}

module.exports = { hoverTargets, isVisualProperty };
