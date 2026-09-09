/**
 * Un DFA parcial sobre un alfabeto de acciones (los "Click_X" que descubre
 * el crawler). Parcial: si un estado no tiene transición definida para un
 * símbolo, esa cadena queda RECHAZADA desde ahí (no hay un estado "trampa"
 * explícito -- lo tratamos como null/undefined y listo).
 *
 * Todo estado alcanzable es aceptante. No estamos modelando "¿terminó bien
 * la ejecución?" sino "¿esta secuencia de clicks es realizable?" -- por
 * eso el lenguaje de este autómata es exactamente el conjunto de secuencias
 * de acciones que se pueden ejecutar de verdad desde el estado inicial.
 * Es lo que hace comparable a este autómata contra el que salga de un
 * regex esperado (mismo tipo de lenguaje: prefijos ejecutables, no
 * cadenas que llegan a un estado final designado).
 */

class DFA {
  /**
   * @param {Object} opts
   * @param {string} opts.initial
   * @param {Map<string, Map<string, string>>} opts.transitions - estado -> (símbolo -> estado)
   * @param {Set<string>} [opts.alphabet] - si se omite, se infiere de `transitions`.
   */
  constructor({ initial, transitions, alphabet }) {
    this.initial = initial;
    this.transitions = transitions;
    this.alphabet = alphabet || DFA._inferAlphabet(transitions);
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
  for (const [state, actions] of Object.entries(transitions)) {
    map.set(state, new Map(Object.entries(actions)));
  }
  return new DFA({ initial: initialState, transitions: map });
}

module.exports = { DFA, fromTransitionsJson };
