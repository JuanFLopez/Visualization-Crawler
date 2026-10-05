/**
 * Todo lo que se arma DESPUÉS del crawl, a partir de la tabla de
 * transiciones: nombres limpios, regex equivalente, comparación contra un
 * regex esperado (opcional) y el diagrama. Lo usa run.js, tanto al
 * terminar un crawl como sobre un transitions.json ya generado.
 */

const { fromTransitionsJson, prefixClosure, DFA, ERROR_STATE } = require('./automaton');
const { compileRegex, dfaToRegexTrace, tokenize, literalsOf } = require('./regex');
const { diff } = require('./diff');
const { cleanNames } = require('./names');
const { toSVG } = require('./diagram');

// Regex con las interacciones "completas": las que terminan de vuelta en
// el estado inicial (o en un estado desde el que ya no se puede volver).
// Toda secuencia válida es prefijo de alguna de estas -- suele ser mucho
// más corto y legible que el lenguaje exacto, que además tiene que
// describir cada interacción "a medio hacer".
function completeInteractionsRegex(dfa, maxLength) {
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
  return { trace: dfaToRegexTrace(loops, { exclude: [ERROR_STATE], maxLength }), stronglyConnected: accepting.size === 1 };
}

// Default de maxRegexLength: el icicle de flare (252 estados) da ~87.000
// caracteres; por encima de esto el regex ya no se puede leer, y en un
// grafo denso el siguiente estado eliminado lo multiplica.
const DEFAULT_MAX_REGEX_LENGTH = 500000;

// Diagnóstico de un regex cortado por tamaño: en qué paso explotó, cómo
// venía creciendo, qué estados quedaban (el núcleo denso) y cuántas de
// las transiciones dentro de ese núcleo son clicks sobre elementos
// visibles solo en parte -- la causa típica de que un grafo jerárquico se
// vuelva denso (círculos vecinos que asoman en las esquinas de un zoom).
function explosionInfo(trace, dfa, visibility, maxLength) {
  const steps = trace.steps;
  const last = steps[steps.length - 1];
  const growth = steps.slice(-12).map((s, i, arr) => {
    const prev = i > 0 ? arr[i - 1].totalSize : (steps[steps.length - arr.length - 1] || { totalSize: 0 }).totalSize;
    return { step: s.step, state: s.state, totalSize: s.totalSize, factor: prev > 0 ? +(s.totalSize / prev).toFixed(2) : null };
  });
  const core = new Set(trace.remaining);
  let coreTransitions = 0, corePartial = 0;
  for (const s of core) {
    for (const [a, to] of dfa.transitions.get(s) || []) {
      if (!core.has(to)) continue;
      coreTransitions++;
      if (visibility[s] && visibility[s][a] !== undefined) corePartial++;
    }
  }
  return {
    maxLength,
    abortedAtStep: last ? last.step : 0,
    totalSteps: dfa.states().length,
    sizeWhenAborted: last ? last.totalSize : null,
    growth,
    denseCore: trace.remaining,
    denseCoreTransitions: coreTransitions,
    denseCorePartiallyVisibleClicks: corePartial,
  };
}

function explosionLog(name, info) {
  const lines = [
    `regex "${name}" OMITIDO: superó ${info.maxLength} caracteres en el paso ${info.abortedAtStep} de ${info.totalSteps} de la eliminación de estados (${info.sizeWhenAborted} caracteres).`,
    '  crecimiento en los últimos pasos (estado eliminado -> tamaño total de las aristas que quedan):',
    ...info.growth.map((g) => `    paso ${String(g.step).padStart(3)}  ${g.state.padEnd(36)} ${String(g.totalSize).padStart(10)}${g.factor ? `  (x${g.factor})` : ''}`),
  ];
  if (info.denseCore.length) {
    lines.push(`  núcleo denso (estados que quedaban sin eliminar): ${info.denseCore.join(', ')}`);
    lines.push(`  ${info.denseCoreTransitions} transiciones dentro del núcleo, ${info.denseCorePartiallyVisibleClicks} de ellas sobre elementos visibles solo en parte`);
  }
  return lines;
}

function traceLog(name, trace) {
  return [
    `traza de la eliminación de estados (regex "${name}"):`,
    '  paso  estado                               in x out   bucle   tamaño total',
    ...trace.steps.map((s) => `  ${String(s.step).padStart(4)}  ${s.state.padEnd(36)} ${String(s.preds).padStart(3)} x ${String(s.succs).padEnd(3)} ${String(s.loopSize).padStart(7)}  ${String(s.totalSize).padStart(12)}`),
  ];
}

// Transiciones cuyo elemento clickeado se veía solo en parte al
// descubrirlo (ver visibleFrac en crawler.js), de la menos visible a la más.
function partiallyVisibleClicks(transitions, visibility) {
  const list = [];
  for (const [state, byAction] of Object.entries(visibility)) {
    for (const [action, visible] of Object.entries(byAction)) {
      const to = transitions[state] && transitions[state][action];
      if (to !== undefined) list.push({ state, action, to, visible });
    }
  }
  return list.sort((a, b) => a.visible - b.visible);
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
 * @param {number} [opts.maxRegexLength=500000] - un regex más largo se omite
 *   (null en el JSON) y se informa dónde explotó; Infinity = sin tope
 * @param {boolean} [opts.traceRegex=false] - loguear la traza completa de la
 *   eliminación de estados, aunque no se haya cortado
 * @returns {{ json: Object, svg: string, log: string[] }}
 */
function buildReport(data, { expectedRegex = null, prefixes = false, limit = 10, maxRegexLength = DEFAULT_MAX_REGEX_LENGTH, traceRegex = false } = {}) {
  const log = [];
  const clean = cleanNames(data);
  const nRenamed = Object.keys(clean.renamed).length;
  if (nRenamed) log.push(`nombres limpiados: ${nRenamed} acciones sin sufijo numérico (p.ej. "${Object.keys(clean.renamed)[0]}" -> "${Object.values(clean.renamed)[0]}")`);

  const dfa = fromTransitionsJson(clean);
  const visibility = clean.visibility || {};
  const exactTrace = dfaToRegexTrace(dfa, { exclude: [ERROR_STATE], maxLength: maxRegexLength });
  const complete = completeInteractionsRegex(dfa, maxRegexLength);
  const exact = exactTrace.regex;
  const completeRegex = complete.trace.regex;

  const json = {
    initialState: clean.initialState,
    transitions: clean.transitions,
    regex: {
      syntax: 'tokens separados por espacio; | unión, * + ? {n,m} repetición, ( ) agrupación, () cadena vacía',
      language: exact,
      languageMeaning: 'semántica estándar: matchea EXACTAMENTE las secuencias de clicks realizables desde el estado inicial (sin las que rompen la página)',
      completeInteractions: completeRegex,
      completeInteractionsMeaning: complete.stronglyConnected
        ? 'secuencias que vuelven al estado inicial; toda secuencia realizable es prefijo de alguna de estas'
        : 'secuencias que vuelven al estado inicial o terminan en un estado desde el que ya no se puede volver; toda secuencia realizable es prefijo de alguna de estas',
    },
  };

  const omittedText = (info) =>
    `omitido: el regex supera ${info.maxLength} caracteres (crece exponencialmente al eliminar los estados ` +
    `del núcleo denso: ${info.denseCore.join(', ') || '(todos)'}). La tabla de transiciones y la comparación ` +
    `contra un regex esperado no se ven afectadas. Ver regex.explosion en transitions.json.`;
  const explosion = {};
  for (const [name, trace] of [['language', exactTrace], ['completeInteractions', complete.trace]]) {
    if (traceRegex) log.push('', ...traceLog(name, trace));
    if (!trace.aborted) continue;
    explosion[name] = explosionInfo(trace, dfa, visibility, maxRegexLength);
    json.regex[`${name}Omitted`] = omittedText(explosion[name]);
    log.push('', ...explosionLog(name, explosion[name]));
  }
  if (Object.keys(explosion).length) json.regex.explosion = explosion;

  const partial = partiallyVisibleClicks(clean.transitions, visibility);
  if (Object.keys(visibility).length) json.visibility = visibility;
  if (partial.length) {
    const nTransitions = Object.values(clean.transitions).reduce((n, t) => n + Object.keys(t).length, 0);
    json.partiallyVisibleClicks = {
      meaning: 'transiciones cuyo elemento se veía solo en parte al clickearlo (visible: fracción aproximada de su área)',
      count: partial.length,
      ofTransitions: nTransitions,
      transitions: partial,
    };
    log.push('', `${partial.length} de ${nTransitions} transiciones clickean elementos visibles solo en parte; las menos visibles:`);
    // ≈: se mide con una grilla de 5x5 puntos; 0 = ningún punto cayó en la parte visible
    partial.slice(0, 5).forEach((p) => log.push(`    ${p.state} --${p.action}--> ${p.to}  (≈${Math.round(p.visible * 100)}% visible)`));
  }

  const footer = [
    { title: 'Regex (interacciones completas: vuelven al estado inicial)', text: completeRegex ?? json.regex.completeInteractionsOmitted, color: completeRegex == null ? '#a15c00' : undefined },
    { title: 'Regex (lenguaje exacto: toda secuencia de clicks realizable)', text: exact ?? json.regex.languageOmitted, color: exact == null ? '#a15c00' : undefined },
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

module.exports = { buildReport, DEFAULT_MAX_REGEX_LENGTH };
