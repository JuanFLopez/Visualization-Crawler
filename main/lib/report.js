/**
 * Todo lo que se arma DESPUÉS del crawl, a partir de la tabla de
 * transiciones: nombres limpios, regex equivalente, comparación contra un
 * regex esperado (opcional) y el diagrama. Lo usa run.js, tanto al
 * terminar un crawl como sobre un transitions.json ya generado.
 */

const { fromTransitionsJson, prefixClosure, DFA, ERROR_STATE } = require('./automaton');
const { compileRegex, dfaToRegex, tokenize, literalsOf } = require('./regex');
const { diff } = require('./diff');
const { cleanNames } = require('./names');
const { toSVG } = require('./diagram');

// Regex con las interacciones "completas": las que terminan de vuelta en
// el estado inicial (o en un estado desde el que ya no se puede volver).
// Toda secuencia válida es prefijo de alguna de estas -- suele ser mucho
// más corto y legible que el lenguaje exacto, que además tiene que
// describir cada interacción "a medio hacer".
function completeInteractionsRegex(dfa) {
  const preds = new Map();
  for (const [from, m] of dfa.transitions) {
    for (const to of m.values()) {
      if (!preds.has(to)) preds.set(to, new Set());
      preds.get(to).add(from);
    }
  }
  const reachesInitial = new Set([dfa.initial]);
  const stack = [dfa.initial];
  while (stack.length) {
    for (const p of preds.get(stack.pop()) || []) {
      if (!reachesInitial.has(p)) { reachesInitial.add(p); stack.push(p); }
    }
  }
  const accepting = new Set([dfa.initial]);
  for (const s of dfa.states()) if (!reachesInitial.has(s)) accepting.add(s);
  const loops = new DFA({ initial: dfa.initial, transitions: dfa.transitions, alphabet: dfa.alphabet, accepting });
  return { regex: dfaToRegex(loops, { exclude: [ERROR_STATE] }), stronglyConnected: accepting.size === 1 };
}

// Permite escribir el regex esperado sin el prefijo "Click_" ("vis c31"
// en vez de "Click_vis Click_c31"): un token que no está en el alfabeto
// pero sí con el prefijo, se completa.
function normalizeExpected(src, alphabet) {
  const literals = literalsOf(src);
  const completed = {};
  const toks = tokenize(src).map((t) => {
    if (literals.has(t) && !alphabet.has(t) && alphabet.has(`Click_${t}`)) {
      completed[t] = `Click_${t}`;
      return `Click_${t}`;
    }
    return t;
  });
  return { src: toks.join(' '), completed };
}

/**
 * @param {{initialState: string, transitions: Object}} data - tabla tal como la deja el crawler
 * @param {Object} [opts]
 * @param {string} [opts.expectedRegex] - regex a comparar con lo observado
 * @param {boolean} [opts.prefixes=false] - comparar contra los PREFIJOS de lo
 *   que describe expectedRegex (útil si el regex describe interacciones completas)
 * @param {number} [opts.limit=10] - contraejemplos a reportar por dirección
 * @returns {{ json: Object, svg: string, log: string[] }}
 */
function buildReport(data, { expectedRegex = null, prefixes = false, limit = 10 } = {}) {
  const log = [];
  const clean = cleanNames(data);
  const nRenamed = Object.keys(clean.renamed).length;
  if (nRenamed) log.push(`nombres limpiados: ${nRenamed} acciones sin sufijo numérico (p.ej. "${Object.keys(clean.renamed)[0]}" -> "${Object.values(clean.renamed)[0]}")`);

  const dfa = fromTransitionsJson(clean);
  const exact = dfaToRegex(dfa, { exclude: [ERROR_STATE] });
  const complete = completeInteractionsRegex(dfa);

  const json = {
    initialState: clean.initialState,
    transitions: clean.transitions,
    regex: {
      syntax: 'tokens separados por espacio; | unión, * + ? {n,m} repetición, ( ) agrupación, () cadena vacía',
      language: exact,
      languageMeaning: 'semántica estándar: matchea EXACTAMENTE las secuencias de clicks realizables desde el estado inicial (sin las que rompen la página)',
      completeInteractions: complete.regex,
      completeInteractionsMeaning: complete.stronglyConnected
        ? 'secuencias que vuelven al estado inicial; toda secuencia realizable es prefijo de alguna de estas'
        : 'secuencias que vuelven al estado inicial o terminan en un estado desde el que ya no se puede volver; toda secuencia realizable es prefijo de alguna de estas',
    },
  };

  const footer = [
    { title: 'Regex (interacciones completas: vuelven al estado inicial)', text: complete.regex },
    { title: 'Regex (lenguaje exacto: toda secuencia de clicks realizable)', text: exact },
  ];
  let highlightPath = [];

  if (expectedRegex) {
    const { src, completed } = normalizeExpected(expectedRegex, dfa.alphabet);
    let expected = compileRegex(src, dfa.alphabet);
    if (prefixes) expected = prefixClosure(expected);
    const d = diff(dfa, expected, { limit });

    const usedSymbols = literalsOf(src);
    const unknownSymbols = [...usedSymbols].filter((s) => !dfa.alphabet.has(s));
    const usesWildcard = tokenize(src).includes('.');
    const unusedSymbols = usesWildcard ? [] : [...dfa.alphabet].filter((s) => !usedSymbols.has(s));
    const fmt = (seq) => (seq.length ? seq.join(' ') : '() (secuencia vacía)');

    json.comparison = {
      expected: expectedRegex,
      mode: prefixes ? 'prefijos del regex esperado' : 'semántica estándar (secuencias completas)',
      equivalent: d.equivalent,
      onlyInCrawler: d.onlyInA.map(fmt),
      onlyInExpected: d.onlyInB.map(fmt),
      truncated: d.truncated,
      unknownSymbols,
      symbolsNotInExpected: unusedSymbols,
    };
    if (Object.keys(completed).length) json.comparison.completedTokens = completed;

    log.push('', `=== COMPARACIÓN con el regex esperado (${json.comparison.mode}) ===`);
    if (d.equivalent) {
      log.push('EQUIVALENTES: el regex describe exactamente lo que observó el crawler.');
    } else {
      log.push('DIFERENTES.');
      if (d.onlyInA.length) {
        log.push(`  el crawler las permite, el regex NO (${d.onlyInA.length}${d.truncated ? '+' : ''}):`);
        d.onlyInA.forEach((s) => log.push(`    ${fmt(s)}`));
      }
      if (d.onlyInB.length) {
        log.push(`  el regex las permite, el crawler NO (${d.onlyInB.length}${d.truncated ? '+' : ''}):`);
        d.onlyInB.forEach((s) => log.push(`    ${fmt(s)}`));
      }
      if (d.truncated) log.push(`  (se muestran a lo sumo ${limit} por dirección, las más cortas)`);
    }
    if (unknownSymbols.length) log.push(`  ATENCIÓN: el regex usa símbolos que el crawler nunca vio (¿typo?): ${unknownSymbols.join(', ')}`);
    if (unusedSymbols.length) log.push(`  acciones observadas que el regex no menciona: ${unusedSymbols.join(', ')}`);

    const first = d.onlyInA[0] || d.onlyInB[0];
    if (first) highlightPath = first;
    const lines = d.equivalent
      ? ['EQUIVALENTES']
      : [
          ...d.onlyInA.slice(0, 5).map((s) => `crawler sí / regex no:  ${fmt(s)}`),
          ...d.onlyInB.slice(0, 5).map((s) => `regex sí / crawler no:  ${fmt(s)}`),
        ];
    footer.unshift({
      title: `Comparación con: ${expectedRegex}${first ? '   (en rojo: primer contraejemplo)' : ''}`,
      text: lines.join('\n'),
      color: d.equivalent ? '#1a7f37' : '#c33',
    });
  }

  const svg = toSVG(dfa, { footer, highlightPath });
  return { json, svg, log };
}

module.exports = { buildReport };
