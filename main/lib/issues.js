/**
 * Unexpected behaviors, rebuilt as SERIES OF EVENTS over the observed
 * automaton: from the initial state, what was clicked in each state, where it
 * led and at which step something did not go as expected.
 *
 * Three origins (the `kind` values are Spanish because they end up in the
 * generated JSON):
 *   - error:      a click broke the page (a transition to __ERROR__). Always
 *                 reported, with or without an expected regex, together with
 *                 the shortest path that reproduces it.
 *   - noEsperado: the visualization allows a sequence the expected regex does
 *                 not admit (onlyInA of lib/diff.js).
 *   - faltante:   the expected regex admits a sequence the visualization does
 *                 not allow (onlyInB): at some step the click is not
 *                 available, or it breaks the page.
 *
 * Several counterexamples that fail in the same place (same state, same
 * action) are the same problem: they are grouped and the shortest series is
 * shown (diff is BFS, so that is the first one).
 */

const { ERROR_STATE } = require('./automaton');
const { displayAction, shortAction, verbOf } = require('./actions');

const HEADLINE = 'Hay un comportamiento inesperado cuando ocurre esta serie de eventos';

/**
 * Walks `seq` over the observed automaton.
 * @returns {{ events: Object[], failure: null | {step: number, state: string, action: string, reason: 'noDisponible'|'error'} }}
 *   events includes the failing step (to: null when the click was not there, __ERROR__ when it broke the page)
 */
function replay(dfa, seq, cls) {
  const events = [];
  let cur = dfa.initial;
  for (let i = 0; i < seq.length; i++) {
    const action = seq[i];
    const next = dfa.step(cur, action);
    const event = { step: i + 1, state: cur, action, to: next, edge: next === null ? null : cls.kindOf(cur, action) };
    events.push(event);
    if (next === null || next === ERROR_STATE) {
      return { events, failure: { step: i + 1, state: cur, action, reason: next === null ? 'noDisponible' : 'error' } };
    }
    cur = next;
  }
  return { events, failure: null };
}

/** First step (1-based) at which the expected regex stops admitting the sequence, or null if it admits it to the end. */
function expectedDivergence(expected, seq) {
  let cur = expected.initial;
  for (let i = 0; i < seq.length; i++) {
    cur = cur === null ? null : expected.step(cur, seq[i]);
    if (cur === null) return i + 1;
  }
  return null;
}

// shortest path (in clicks) from the initial state to `target`
function shortestPath(dfa, target) {
  const prev = new Map([[dfa.initial, null]]);
  const queue = [dfa.initial];
  while (queue.length) {
    const s = queue.shift();
    if (s === target) break;
    for (const [action, to] of dfa.transitions.get(s) || []) {
      if (to === ERROR_STATE || prev.has(to)) continue;
      prev.set(to, { from: s, action });
      queue.push(to);
    }
  }
  if (!prev.has(target)) return null;
  const path = [];
  for (let c = target; prev.get(c); c = prev.get(c).from) path.unshift(prev.get(c).action);
  return path;
}

function describe(kind, failingStep, event, { incomplete = false, alsoExpected = false, reason = null, form = 'language' } = {}) {
  const a = `"${shortAction(event.action)}"`; // with the verb in front ("hover") the prefix is redundant
  const verb = verbOf(event.action);
  if (kind === 'error') {
    return `la página tira una excepción al hacer ${verb} ${a} en "${event.state}" (paso ${failingStep})` +
      (alsoExpected ? '; el regex esperado admite esta secuencia' : '');
  }
  if (kind === 'faltante') {
    if (reason === 'atajo') {
      return `el regex esperado usa el atajo ${a} en el paso ${failingStep}; existe en la visualización pero no en el autómata con ciclos cortados`;
    }
    if (reason === 'sinVolver') {
      return `el regex esperado da la interacción por terminada en "${event.to}", pero desde ahí la visualización todavía no volvió al estado inicial`;
    }
    return `el regex esperado admite ${verb} ${a} en el paso ${failingStep}, pero en "${event.state}" la visualización no lo ofrece`;
  }
  if (incomplete) {
    return form === 'completeInteractions'
      ? 'la serie vuelve al estado inicial (interacción completa), pero el regex esperado no la acepta'
      : 'la visualización permite terminar acá, pero el regex esperado no acepta la secuencia como completa' +
        ' (si el regex describe interacciones completas, compará con --regexPrefixes)';
  }
  return `la visualización permite ${verb} ${a} en "${event.state}" (paso ${failingStep}), pero el regex esperado no lo admite`;
}

/**
 * @param {Object} p
 * @param {import('./automaton').DFA} p.dfa - observed automaton (full, uncut)
 * @param {ReturnType<import('./cycles').classifyEdges>} p.cls
 * @param {import('./automaton').DFA} [p.expected] - DFA of the expected regex (already prefix-closed when it applies)
 * @param {{onlyInA: string[][], onlyInB: string[][]}} [p.diff] - against `target`
 * @param {{automaton: 'completo'|'cortado', form: 'language'|'completeInteractions'}} [p.target] - what it was compared
 *   against; the events are rebuilt over `dfa` (the full one) either way
 * @returns {{kind: string, message: string, detail: string, sequence: string[], events: Object[], failingStep: number, occurrences: number}[]}
 */
function buildIssues({ dfa, cls, expected = null, diff = null, target = null }) {
  target = target || { automaton: 'completo', form: 'language' };
  const byKey = new Map();
  const add = (key, issue) => {
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...issue, occurrences: 1 }); return; }
    prev.occurrences++;
    if (issue.sequence.length < prev.sequence.length) Object.assign(prev, { ...issue, occurrences: prev.occurrences });
  };

  for (const [state, m] of dfa.transitions) {
    for (const [action, to] of m) {
      if (to !== ERROR_STATE) continue;
      const path = shortestPath(dfa, state);
      if (!path) continue;
      const seq = [...path, action];
      const { events, failure } = replay(dfa, seq, cls);
      add(`error\u0000${state}\u0000${action}`, { kind: 'error', sequence: seq, events, failingStep: failure.step });
    }
  }

  if (diff) {
    for (const seq of diff.onlyInB) {
      const { events, failure } = replay(dfa, seq, cls);
      if (!failure) {
        // The visualization does allow it: the difference belongs to the
        // automaton it was compared against (a shortcut the cut one lacks,
        // or an interaction the regex considers complete without having
        // returned).
        const shortcut = target.automaton === 'cortado' ? events.find((e) => e.edge === 'shortcut') : null;
        if (shortcut) {
          add(`faltante\u0000${shortcut.state}\u0000${shortcut.action}`, { kind: 'faltante', sequence: seq, events, failingStep: shortcut.step, reason: 'atajo' });
        } else if (events.length) {
          const last = events[events.length - 1];
          add(`faltante\u0000${last.to}\u0000`, { kind: 'faltante', sequence: seq, events, failingStep: last.step, reason: 'sinVolver' });
        }
        continue;
      }
      const kind = failure.reason === 'error' ? 'error' : 'faltante';
      const key = `${kind}\u0000${failure.state}\u0000${failure.action}`;
      if (kind === 'error' && byKey.has(key)) { byKey.get(key).alsoExpected = true; continue; }
      add(key, { kind, sequence: seq, events, failingStep: failure.step, alsoExpected: kind === 'error' });
    }
    for (const seq of diff.onlyInA) {
      const { events } = replay(dfa, seq, cls);
      const step = expectedDivergence(expected, seq);
      const incomplete = step === null;
      const failingStep = incomplete ? seq.length : step;
      const at = incomplete ? (events.length ? events[events.length - 1].to : dfa.initial) : events[step - 1].state;
      const key = `noEsperado\u0000${at}\u0000${incomplete ? '' : seq[step - 1]}`;
      add(key, { kind: 'noEsperado', sequence: seq, events, failingStep, incomplete });
    }
  }

  const order = { error: 0, faltante: 1, noEsperado: 2 };
  return [...byKey.values()]
    .sort((a, b) => order[a.kind] - order[b.kind] || a.sequence.length - b.sequence.length)
    .map(({ kind, sequence, events, failingStep, occurrences, incomplete, alsoExpected, reason }) => {
      const failing = events[failingStep - 1];
      const opts = { incomplete, alsoExpected, reason, form: target.form };
      const detail = failing
        ? describe(kind, failingStep, failing, opts)
        : describe(kind, 0, { action: '', state: dfa.initial }, { ...opts, incomplete: true });
      const series = sequence.length ? sequence.map(displayAction).join(' → ') : '(ninguno: no hacer nada)';
      return { kind, message: `${HEADLINE}: ${series}`, detail, sequence, events, failingStep, occurrences };
    });
}

function eventLine(e, failingStep) {
  const head = `${e.step}. en "${e.state}": ${verbOf(e.action)} "${shortAction(e.action)}"`;
  let tail;
  if (e.to === null) tail = '-> no disponible en este estado';
  else if (e.to === ERROR_STATE) tail = '-> ERROR: la página tiró una excepción';
  else tail = `-> "${e.to}"`;
  const notes = [];
  if (e.edge === 'back') notes.push('vuelve: cierra un ciclo');
  if (e.edge === 'shortcut') notes.push('atajo: no aparece en el regex con ciclos cortados');
  if (e.step === failingStep) notes.push('<-- acá');
  return `${head} ${tail}${notes.length ? `   (${notes.join('; ')})` : ''}`;
}

/** Log lines for a list of issues from buildIssues(). */
function issuesLog(issues) {
  if (!issues.length) return [];
  const lines = [`=== COMPORTAMIENTO INESPERADO (${issues.length}) ===`];
  issues.forEach((issue, i) => {
    lines.push(`[${i + 1}] ${HEADLINE}:`);
    if (!issue.events.length) lines.push('      (ninguno: no hacer nada)');
    issue.events.forEach((e) => lines.push(`      ${eventLine(e, issue.failingStep)}`));
    lines.push(`    ${issue.detail}${issue.occurrences > 1 ? ` (${issue.occurrences} contraejemplos fallan en este mismo lugar)` : ''}`);
  });
  return lines;
}

module.exports = { buildIssues, issuesLog, replay, HEADLINE };
