/**
 * Detección de ciclos en el autómata observado, para cortar el regex.
 *
 * El regex exacto explota en grafos densos (ver dfaToRegexTrace en
 * lib/regex.js): lo que lo hace explotar no son los ciclos "de ida y
 * vuelta" de una jerarquía (entrar a una rama y volver con zoom out) sino
 * los ATAJOS -- saltar a un estado fuera de la propia rama (un anillo
 * profundo del sunburst clickeado desde la raíz, un círculo vecino que
 * asoma en la esquina de un zoom). Cada atajo conecta subárboles entre sí
 * y la eliminación de estados termina copiando bucles en cada par.
 *
 * Se arma un árbol generador desde el estado inicial y se clasifica cada
 * transición:
 *   - tree:     del padre al hijo en el árbol
 *   - back:     a un ancestro (o a sí mismo): CIERRA UN CICLO
 *   - shortcut: a cualquier otro estado ya alcanzado por otra rama
 *
 * El autómata "cortado" (tree + back) tiene todos los estados y todos los
 * ciclos de volver hacia arriba, y su regex queda anidado como la
 * jerarquía; los atajos se informan aparte. Regex cortado + lista de
 * atajos = autómata completo.
 *
 * Árbol: si los nombres de estado son caminos de la jerarquía ("root >
 * vis > operator", ver lib/labels.js), el padre es el prefijo del nombre
 * -- un DFS o BFS sobre un sunburst toma por padre a quien lo descubrió
 * primero, y en un circle pack eso encadena hermanos (vis -> animate ->
 * flex) como si fueran niveles. Si no hay jerarquía en los nombres (o al
 * padre le falta la transición al hijo), el padre es el de un BFS.
 */

const { DFA, ERROR_STATE } = require('./automaton');

const SEP = ' > ';

function classifyEdges(dfa) {
  const succ = (s) => dfa.transitions.get(s) || new Map();

  const bfsParent = new Map();
  const reachable = new Set([dfa.initial]);
  const queue = [dfa.initial];
  while (queue.length) {
    const s = queue.shift();
    for (const to of succ(s).values()) {
      if (to === ERROR_STATE || reachable.has(to)) continue;
      reachable.add(to);
      bfsParent.set(to, s);
      queue.push(to);
    }
  }

  const hierarchical = [...reachable].every((s) => s === dfa.initial || s.startsWith(dfa.initial + SEP));
  const parent = new Map();
  for (const s of reachable) {
    if (s === dfa.initial) continue;
    const up = s.split(SEP).slice(0, -1).join(SEP);
    const hasEdge = hierarchical && reachable.has(up) && [...succ(up).values()].includes(s);
    parent.set(s, hasEdge ? up : bfsParent.get(s));
  }
  // mezclar padres por nombre y por BFS podría, en un caso patológico,
  // armar un ciclo de padres: ahí ese estado vuelve a su padre BFS (las
  // cadenas solo-BFS siempre terminan en el inicial)
  for (let changed = true; changed;) {
    changed = false;
    for (const s of parent.keys()) {
      const seen = new Set();
      let c = s;
      while (c !== undefined && !seen.has(c)) { seen.add(c); c = parent.get(c); }
      if (c !== undefined && parent.get(s) !== bfsParent.get(s)) { parent.set(s, bfsParent.get(s)); changed = true; }
    }
  }

  const isAncestor = (a, s) => {
    for (let c = s; c !== undefined; c = parent.get(c)) if (c === a) return true;
    return false;
  };

  const kinds = new Map();
  const counts = { tree: 0, back: 0, shortcut: 0 };
  const shortcuts = [];
  for (const s of reachable) {
    for (const [action, to] of succ(s)) {
      if (to === ERROR_STATE) continue;
      const kind = parent.get(to) === s ? 'tree' : isAncestor(to, s) ? 'back' : 'shortcut';
      kinds.set(`${s}\u0000${action}`, kind);
      counts[kind]++;
      if (kind === 'shortcut') shortcuts.push({ state: s, action, to });
    }
  }

  return {
    parent,
    hierarchical,
    counts,
    shortcuts,
    /** @returns {'tree'|'back'|'shortcut'|null} null: a __ERROR__ o desde un estado inalcanzable */
    kindOf: (state, action) => kinds.get(`${state}\u0000${action}`) || null,
  };
}

/** El DFA con solo las transiciones tree y back (mismo alfabeto y aceptación). */
function cutDfa(dfa, cls) {
  const transitions = new Map();
  for (const [s, m] of dfa.transitions) {
    const kept = new Map();
    for (const [action, to] of m) {
      const kind = cls.kindOf(s, action);
      if (kind === 'tree' || kind === 'back') kept.set(action, to);
    }
    transitions.set(s, kept);
  }
  return new DFA({ initial: dfa.initial, transitions, alphabet: dfa.alphabet, accepting: dfa.accepting });
}

module.exports = { classifyEdges, cutDfa };
