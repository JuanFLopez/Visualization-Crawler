/**
 * Un DFA parcial sobre un alfabeto de acciones (los "Click_X" que descubre
 * el crawler). Parcial: si un estado no tiene transición definida para un
 * símbolo, esa cadena queda RECHAZADA desde ahí (no hay un estado "trampa"
 * explícito -- lo tratamos como null/undefined y listo).
 *
 * En el autómata OBSERVADO (el del crawler) todo estado alcanzable es
 * aceptante, salvo __ERROR__: no estamos modelando "¿terminó bien la
 * ejecución?" sino "¿esta secuencia de clicks es realizable?" -- por eso
 * su lenguaje es exactamente el conjunto de secuencias de acciones que se
 * pueden ejecutar de verdad desde el estado inicial. El que sale de un
 * regex (lib/regex.js) sí tiene aceptación propia (semántica estándar).
 */

const ERROR_STATE = '__ERROR__';

class DFA {
  /**
   * @param {Object} opts
   * @param {string} opts.initial
   * @param {Map<string, Map<string, string>>} opts.transitions - estado -> (símbolo -> estado)
   * @param {Set<string>} [opts.alphabet] - si se omite, se infiere de `transitions`.
   * @param {Set<string>} [opts.accepting] - si se omite, todo estado es aceptante.
   */
  constructor({ initial, transitions, alphabet, accepting = null }) {
    this.initial = initial;
    this.transitions = transitions;
    this.alphabet = alphabet || DFA._inferAlphabet(transitions);
    this.accepting = accepting;
  }

  isAccepting(state) {
    return this.accepting ? this.accepting.has(state) : true;
  }

  static _inferAlphabet(transitions) {
    const alphabet = new Set();
    for (const symbolMap of transitions.values()) {
      for (const symbol of symbolMap.keys()) alphabet.add(symbol);
    }
    return alphabet;
  }

  /** @returns {string|null} el estado destino, o null si la transición no existe (cadena rechazada) */
  step(state, symbol) {
    const symbolMap = this.transitions.get(state);
    if (!symbolMap) return null;
    return symbolMap.has(symbol) ? symbolMap.get(symbol) : null;
  }

  states() {
    return [...this.transitions.keys()];
  }
}

/**
 * Convierte el transitions.json que produce el crawler (formato:
 * { initialState, transitions: { estado: { accion: estadoDestino } } })
 * en un DFA. Este es el autómata OBSERVADO.
 */
function fromTransitionsJson({ initialState, transitions }) {
  const map = new Map();
  const accepting = new Set();
  for (const [state, actions] of Object.entries(transitions)) {
    map.set(state, new Map(Object.entries(actions)));
    accepting.add(state);
    for (const to of Object.values(actions)) if (to !== ERROR_STATE) accepting.add(to);
  }
  return new DFA({ initial: initialState, transitions: map, accepting });
}

/**
 * Clausura por prefijos: acepta toda secuencia que pueda EXTENDERSE hasta
 * una aceptada. Para comparar con un regex que describe interacciones
 * completas (p.ej. "(Click_A Click_BACK)*") sin tener que escribir a mano
 * cada interacción a medio hacer.
 */
function prefixClosure(dfa) {
  const preds = new Map();
  for (const [from, m] of dfa.transitions) {
    for (const to of m.values()) {
      if (!preds.has(to)) preds.set(to, new Set());
      preds.get(to).add(from);
    }
  }
  const live = new Set([...dfa.transitions.keys()].filter((s) => dfa.isAccepting(s)));
  const stack = [...live];
  while (stack.length) {
    for (const p of preds.get(stack.pop()) || []) {
      if (!live.has(p)) { live.add(p); stack.push(p); }
    }
  }
  const map = new Map();
  for (const s of live) {
    const m = new Map();
    for (const [sym, to] of dfa.transitions.get(s) || []) if (live.has(to)) m.set(sym, to);
    map.set(s, m);
  }
  const initial = live.has(dfa.initial) ? dfa.initial : null;
  return new DFA({ initial, transitions: map, alphabet: dfa.alphabet, accepting: live });
}

module.exports = { DFA, fromTransitionsJson, prefixClosure, ERROR_STATE };
