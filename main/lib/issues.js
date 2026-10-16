/**
 * Comportamientos inesperados, reconstruidos como SERIES DE EVENTOS sobre
 * el autómata observado: desde el estado inicial, qué se clickeó en cada
 * estado, adónde llevó y en qué paso algo no salió como se esperaba.
 *
 * Tres orígenes:
 *   - error:      un click rompió la página (transición a __ERROR__). Se
 *                 informa siempre, haya o no regex esperado, con el camino
 *                 más corto para reproducirlo.
 *   - noEsperado: la visualización permite una secuencia que el regex
 *                 esperado no admite (onlyInA de lib/diff.js).
 *   - faltante:   el regex esperado admite una secuencia que la
 *                 visualización no permite (onlyInB): en algún paso el
 *                 click no está disponible, o rompe la página.
 *
 * Varios contraejemplos que fallan en el mismo lugar (mismo estado, misma
 * acción) son el mismo problema: se agrupan y se muestra la serie más
 * corta (diff es BFS, así que es la primera).
 */

const { ERROR_STATE } = require('./automaton');
const { displayAction, shortAction, verbOf } = require('./actions');

const HEADLINE = 'Hay un comportamiento inesperado cuando ocurre esta serie de eventos';

/**
 * Recorre `seq` sobre el autómata observado.
 * @returns {{ events: Object[], failure: null | {step: number, state: string, action: string, reason: 'noDisponible'|'error'} }}
 *   events incluye el paso que falla (to: null si el click no estaba, __ERROR__ si rompió la página)
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

/** Primer paso (1-based) en que el regex esperado deja de admitir la secuencia, o null si la admite hasta el final. */
function expectedDivergence(expected, seq) {
  let cur = expected.initial;
  for (let i = 0; i < seq.length; i++) {
    cur = cur === null ? null : expected.step(cur, seq[i]);
    if (cur === null) return i + 1;
  }
  return null;
}

// camino más corto (en clicks) desde el inicial hasta `target`
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
  const a = `"${shortAction(event.action)}"`; // con el verbo delante ("hover"), el prefijo sobra
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
 * @param {import('./automaton').DFA} p.dfa - autómata observado (completo, sin cortar)
 * @param {ReturnType<import('./cycles').classifyEdges>} p.cls
 * @param {import('./automaton').DFA} [p.expected] - DFA del regex esperado (ya con prefijos, si corresponde)
 * @param {{onlyInA: string[][], onlyInB: string[][]}} [p.diff] - contra `target`
 * @param {{automaton: 'completo'|'cortado', form: 'language'|'completeInteractions'}} [p.target] - contra qué se comparó;
 *   los eventos se reconstruyen igual sobre `dfa` (el completo)
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
        // la visualización sí lo permite: la diferencia es del autómata
        // contra el que se comparó (un atajo que el cortado no tiene, o
        // una interacción que el regex da por completa sin haber vuelto)
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

/** Líneas de log para una lista de issues de buildIssues(). */
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
