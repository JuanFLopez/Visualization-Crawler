/**
 * Everything built AFTER the crawl, from the transition table: clean names,
 * the regex with cycles cut (and the exact ones), the comparison against an
 * expected regex (optional), the unexpected behaviors as series of events,
 * and the diagram. run.js uses it both at the end of a crawl and on an
 * already generated transitions.json.
 */

const { fromTransitionsJson, prefixClosure, DFA, ERROR_STATE } = require('./automaton');
const { compileRegex, dfaToRegexTrace, tokenize, literalsOf } = require('./regex');
const { diff } = require('./diff');
const { cleanNames, stripNumber } = require('./names');
const { toSVG } = require('./diagram');
const { classifyEdges, cutDfa } = require('./cycles');
const { buildIssues, issuesLog } = require('./issues');
const { DEFAULT_KIND, actionName, verbOf } = require('./actions');
const { summarizeHovers, hoverNotes, hoverLines } = require('./hovers');

/**
 * Regex of the "complete" interactions: the ones that end back at the initial
 * state (or in a state from which there is no way back). Every valid sequence
 * is a prefix of one of these. It is usually much shorter and more readable
 * than the exact language, which also has to describe every half-done
 * interaction.
 */
function completeInteractionsRegex(dfa, maxLength) {
  const loops = completeInteractionsDfa(dfa);
  return { trace: dfaToRegexTrace(loops, { exclude: [ERROR_STATE], maxLength }), stronglyConnected: loops.accepting.size === 1 };
}

/** The same automaton, accepting only the complete interactions. */
function completeInteractionsDfa(dfa) {
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
  return new DFA({ initial: dfa.initial, transitions: dfa.transitions, alphabet: dfa.alphabet, accepting });
}

// Default maxRegexLength: the flare icicle (252 states) gives ~87,000
// characters; above this the regex can no longer be read, and in a dense
// graph the next eliminated state multiplies it.
const DEFAULT_MAX_REGEX_LENGTH = 500000;

/**
 * Diagnosis of a regex that was cut for size: the step where it blew up, how
 * it had been growing, which states were left (the dense core), and how many
 * of the transitions inside that core are clicks on partially visible
 * elements, the typical reason a hierarchical graph becomes dense
 * (neighbouring circles peeking out of the corners of a zoom).
 */
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

/**
 * Transitions whose clicked element was only partly visible when it was
 * discovered (see visibleFrac in crawler.js), from the least visible to the most.
 */
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

/**
 * The hovers the crawler discarded, with clean names (the ones that are not
 * in the table did not go through cleanNames), repeated entries merged.
 */
function mergeIgnored(list, renamed) {
  const merged = new Map();
  for (const { action, reason, states } of list) {
    const name = renamed[action] ?? stripNumber(action);
    const key = `${name}\u0000${reason}`;
    merged.set(key, { action: name, reason, states: (merged.has(key) ? merged.get(key).states : 0) + states });
  }
  return [...merged.values()];
}

/**
 * Lets the expected regex be written without the "Click_" prefix ("vis c31"
 * instead of "Click_vis Click_c31"): a token that is not in the alphabet but
 * is with the prefix gets completed.
 */
function normalizeExpected(src, alphabet) {
  const literals = literalsOf(src);
  const completed = {};
  const toks = tokenize(src).map((t) => {
    const full = actionName(DEFAULT_KIND, t);
    if (literals.has(t) && !alphabet.has(t) && alphabet.has(full)) {
      completed[t] = full;
      return full;
    }
    return t;
  });
  return { src: toks.join(' '), completed };
}

/**
 * @param {{initialState: string, transitions: Object}} data - table as the crawler leaves it
 * @param {Object} [opts]
 * @param {string} [opts.expectedRegex] - regex to compare with what was observed
 * @param {boolean} [opts.prefixes=false] - compare against the PREFIXES of what
 *   expectedRegex describes (useful when the regex describes complete interactions)
 * @param {number} [opts.limit=10] - counterexamples to report per direction
 * @param {number} [opts.maxRegexLength=500000] - a longer regex is omitted
 *   (null in the JSON) and where it blew up is reported; Infinity = no limit
 * @param {boolean} [opts.traceRegex=false] - log the full state-elimination
 *   trace, even when nothing was cut
 * @returns {{ json: Object, svg: string, log: string[] }}
 */
function buildReport(data, { expectedRegex = null, prefixes = false, limit = 10, maxRegexLength = DEFAULT_MAX_REGEX_LENGTH, traceRegex = false } = {}) {
  const log = [];
  const clean = cleanNames(data);
  const nRenamed = Object.keys(clean.renamed).length;
  if (nRenamed) log.push(`nombres limpiados: ${nRenamed} acciones sin sufijo numérico (p.ej. "${Object.keys(clean.renamed)[0]}" -> "${Object.values(clean.renamed)[0]}")`);

  const dfa = fromTransitionsJson(clean);
  const visibility = clean.visibility || {};
  const hasPointer = [...dfa.alphabet].some((a) => verbOf(a) !== 'click');
  const cls = classifyEdges(dfa);
  const cut = cutDfa(dfa, cls);
  const cycleCut = completeInteractionsRegex(cut, maxRegexLength);
  const exactTrace = dfaToRegexTrace(dfa, { exclude: [ERROR_STATE], maxLength: maxRegexLength });
  const complete = completeInteractionsRegex(dfa, maxRegexLength);
  const exact = exactTrace.regex;
  const completeRegex = complete.trace.regex;
  const cycleCutRegex = cycleCut.trace.regex;

  const json = {
    initialState: clean.initialState,
    transitions: clean.transitions,
    regex: {
      syntax: 'tokens separados por espacio; | unión, * + ? {n,m} repetición, ( ) agrupación, () cadena vacía',
      cycleCut: cycleCutRegex,
      cycleCutMeaning: 'interacciones completas con los ciclos cortados: entrar por la jerarquía y volver hacia arriba (zoom out, volver, fondo); '
        + 'los atajos (saltos a un estado de otra rama) no se desarrollan en el regex y se listan en regex.cycles.shortcutTransitions',
      cycles: {
        meaning: 'árbol generador desde el estado inicial (por nombre jerárquico si lo hay, si no por BFS): '
          + 'tree = de padre a hijo, back = a un ancestro (cierra un ciclo), shortcut = a otra rama (atajo)',
        tree: cls.counts.tree,
        back: cls.counts.back,
        shortcuts: cls.counts.shortcut,
        shortcutTransitions: cls.shortcuts,
      },
      language: exact,
      languageMeaning: `semántica estándar: matchea EXACTAMENTE las secuencias de ${hasPointer ? 'interacciones (clicks y hovers)' : 'clicks'} realizables desde el estado inicial (sin las que rompen la página)`,
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
  for (const [name, trace, source] of [['cycleCut', cycleCut.trace, cut], ['language', exactTrace, dfa], ['completeInteractions', complete.trace, dfa]]) {
    if (traceRegex) log.push('', ...traceLog(name, trace));
    if (!trace.aborted) continue;
    explosion[name] = explosionInfo(trace, source, visibility, maxRegexLength);
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
    // ≈: measured with a 5x5 grid of points; 0 = no point fell in the visible part
    partial.slice(0, 5).forEach((p) => log.push(`    ${p.state} --${p.action}--> ${p.to}  (≈${Math.round(p.visible * 100)}% visible)`));
  }

  // Hovers: the ones that change something visible are actions (a loop of the
  // state, or a state of their own when they open something); the rest are
  // listed apart as what is NOT an action. In --from mode they arrive already
  // summarized.
  const hovers = data.hovers || summarizeHovers({
    transitions: clean.transitions,
    effects: clean.effects || {},
    ignored: mergeIgnored(data.ignoredHovers || [], clean.renamed),
  });
  if (hovers) {
    json.hovers = hovers;
    log.push('', `hover: ${hovers.transient} transitorios (un bucle del estado), ${hovers.structural} estructurales (cambian de estado)${hovers.broken ? `, ${hovers.broken} que rompen la página` : ''}`,
      ...hoverLines(hovers).map((l) => `    ${l}`));
  }

  log.push('', `ciclos: ${cls.counts.back} transiciones vuelven a un ancestro (cierran un ciclo), ${cls.counts.shortcut} son atajos a otra rama`
    + ` -- el regex con ciclos cortados tiene ${cycleCutRegex == null ? 'OMITIDO' : `${cycleCutRegex.length} caracteres`}`
    + ` (exacto: ${completeRegex == null ? 'OMITIDO' : `${completeRegex.length} caracteres`})`);

  // the diagram shows only the cut regex; the exact ones stay in the JSON
  const footer = [
    {
      title: `Regex con los ciclos cortados (interacciones completas; ${cls.counts.shortcut} atajos aparte, ver regex.cycles en transitions.json)`,
      text: cycleCutRegex ?? json.regex.cycleCutOmitted,
      color: cycleCutRegex == null ? '#a15c00' : undefined,
    },
  ];
  if (hovers) {
    const n = hovers.transient + hovers.structural + (hovers.broken || 0);
    footer.push({
      title: `Hover (${n} ${n === 1 ? 'acción con efecto visible' : 'acciones con efecto visible'})`,
      text: hoverLines(hovers).join('\n'),
    });
  }
  let highlightPath = [];
  let expected = null, d = null, target = null;

  if (expectedRegex) {
    const { src, completed } = normalizeExpected(expectedRegex, dfa.alphabet);
    expected = compileRegex(src, dfa.alphabet);
    if (prefixes) expected = prefixClosure(expected);

    // The expected regex may describe the full automaton or the cut one (the
    // one the diagram shows), and each either as every realizable prefix or as
    // complete interactions: matching any of them exactly is enough. With
    // --regexPrefixes the expected one is already a prefix closure, and only
    // makes sense against "language".
    const forms = prefixes ? ['language'] : ['completeInteractions', 'language'];
    const rankLimit = Math.max(limit, 50);
    const targets = [];
    for (const [automaton, base] of [['cortado', cut], ['completo', dfa]]) {
      for (const form of forms) {
        const tdfa = form === 'language' ? base : completeInteractionsDfa(base);
        targets.push({ automaton, form, dfa: tdfa, diff: diff(tdfa, expected, { limit: rankLimit }) });
      }
    }
    // The closest one: fewest differences; on a tie the order above wins (cut
    // before full, interactions before language).
    const size = (t) => t.diff.onlyInA.length + t.diff.onlyInB.length;
    const matched = targets.find((t) => t.diff.equivalent) || null;
    target = matched || targets.reduce((best, t) => (size(t) < size(best) ? t : best));
    d = {
      equivalent: target.diff.equivalent,
      onlyInA: target.diff.onlyInA.slice(0, limit),
      onlyInB: target.diff.onlyInB.slice(0, limit),
      truncated: target.diff.truncated || target.diff.onlyInA.length > limit || target.diff.onlyInB.length > limit,
    };
    const tname = (t) => `autómata ${t.automaton} · ${t.form === 'language' ? 'lenguaje (todo prefijo)' : 'interacciones completas'}`;
    const count = (t, list) => `${list.length}${t.diff.truncated ? '+' : ''}`;

    const usedSymbols = literalsOf(src);
    const unknownSymbols = [...usedSymbols].filter((s) => !dfa.alphabet.has(s));
    const usesWildcard = tokenize(src).includes('.');
    const unusedSymbols = usesWildcard ? [] : [...dfa.alphabet].filter((s) => !usedSymbols.has(s));
    const fmt = (seq) => (seq.length ? seq.join(' ') : '() (secuencia vacía)');

    json.comparison = {
      expected: expectedRegex,
      mode: prefixes ? 'prefijos del regex esperado' : 'semántica estándar (secuencias completas)',
      equivalent: !!matched,
      matched: matched && { automaton: matched.automaton, form: matched.form },
      targets: targets.map((t) => ({
        automaton: t.automaton, form: t.form, equivalent: t.diff.equivalent,
        onlyInCrawler: t.diff.onlyInA.length, onlyInExpected: t.diff.onlyInB.length, truncated: t.diff.truncated,
      })),
      reportedAgainst: { automaton: target.automaton, form: target.form },
      onlyInCrawler: d.onlyInA.map(fmt),
      onlyInExpected: d.onlyInB.map(fmt),
      truncated: d.truncated,
      unknownSymbols,
      symbolsNotInExpected: unusedSymbols,
    };
    if (Object.keys(completed).length) json.comparison.completedTokens = completed;

    log.push('', `=== COMPARACIÓN con el regex esperado (${json.comparison.mode}) ===`);
    for (const t of targets) {
      log.push(`  ${tname(t).padEnd(46)} ${t.diff.equivalent ? 'EQUIVALENTES' : `DIFERENTES (${count(t, t.diff.onlyInA)} / ${count(t, t.diff.onlyInB)})`}`);
    }
    log.push('    (entre paréntesis: secuencias que el crawler permite y el regex no / que el regex permite y el crawler no)');
    if (matched) {
      log.push(`RESULTADO: EQUIVALENTES (coincide con el ${tname(matched)})`);
    } else {
      log.push(`RESULTADO: DIFERENTES -- comportamientos inesperados respecto del más cercano: ${tname(target)}`);
      if (d.truncated) log.push(`  (se consideran a lo sumo ${limit} por dirección, las más cortas)`);
    }
    if (unknownSymbols.length) log.push(`  ATENCIÓN: el regex usa símbolos que el crawler nunca vio (¿typo?): ${unknownSymbols.join(', ')}`);
    if (unusedSymbols.length) log.push(`  acciones observadas que el regex no menciona: ${unusedSymbols.join(', ')}`);
  }

  // Events are always rebuilt over the FULL automaton (what really happens in
  // the visualization), even when the comparison was against the cut one.
  const issues = buildIssues({ dfa, cls, expected, diff: d, target });
  json.issues = issues;
  if (issues.length) log.push('', ...issuesLog(issues));
  else if (expectedRegex) log.push('', 'sin comportamientos inesperados.');

  const matchedName = json.comparison && json.comparison.matched
    && `autómata ${json.comparison.matched.automaton} · ${json.comparison.matched.form === 'language' ? 'lenguaje' : 'interacciones completas'}`;
  if (issues.length) {
    highlightPath = issues[0].sequence;
    const shown = issues.slice(0, 6).map((i) => `${i.message}\n    ${i.detail}`);
    if (issues.length > shown.length) shown.push(`(y ${issues.length - shown.length} más en transitions.json)`);
    const against = expectedRegex && !matchedName ? ` (comparado con: ${expectedRegex}, contra el autómata ${target.automaton})` : '';
    footer.unshift({
      title: `Comportamiento inesperado${against}   (en rojo: la primera serie de eventos)`,
      text: shown.join('\n'),
      color: '#c33',
    });
  }
  if (matchedName) {
    footer.unshift({ title: `Comparación con: ${expectedRegex}`, text: `EQUIVALENTES (${matchedName})`, color: '#1a7f37' });
  }

  const svg = toSVG(dfa, { footer, highlightPath, notes: hoverNotes(hovers) });
  return { json, svg, log };
}

module.exports = { buildReport, DEFAULT_MAX_REGEX_LENGTH };
