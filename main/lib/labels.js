/**
 * El crawler identifica cada estado con un fingerprint (hash) para poder
 * comparar igualdad -- pero ese hash no dice nada a simple vista. Esta
 * función arma un nombre humano por estado usando el camino de ACCIONES
 * (ya con nombres legibles, ver _actionName en crawler.js) que lo alcanza
 * por primera vez desde la raíz: "root", "root > A", "root > A > A1", etc.
 *
 * No necesita nada del lado del browser -- opera puro sobre el
 * transitions.json ya generado, haciendo un BFS (mismo orden en que el
 * crawler los descubrió) y numerando en caso de colisión (no debería
 * pasar, ya que cada estado tiene un solo camino más corto registrado,
 * pero por las dudas).
 *
 * @param {{initialState: string, transitions: Object}} data
 * @param {Object} [opts]
 * @param {string} [opts.rootLabel='root']
 * @param {string} [opts.separator=' > ']
 * @returns {{initialState: string, transitions: Object, labelOf: Object}}
 *   labelOf mapea el hash original -> nombre legible, por si hace falta
 *   correlacionar con checkpoints o logs previos.
 */
function prettifyStates(data, { rootLabel = 'root', separator = ' > ' } = {}) {
  const { initialState, transitions } = data;
  const ERROR_STATE = '__ERROR__';

  const labelOf = new Map([[initialState, rootLabel]]);
  const queue = [initialState];

  while (queue.length > 0) {
    const state = queue.shift();
    const actions = transitions[state] || {};
    for (const [action, next] of Object.entries(actions)) {
      if (next === ERROR_STATE || labelOf.has(next)) continue;
      const shortAction = action.replace(/^Click_/, '');
      let label = `${labelOf.get(state)}${separator}${shortAction}`;
      const existing = new Set(labelOf.values());
      let suffix = 2;
      while (existing.has(label)) label = `${labelOf.get(state)}${separator}${shortAction}#${suffix++}`;
      labelOf.set(next, label);
      queue.push(next);
    }
  }

  const renamedTransitions = {};
  for (const [state, actions] of Object.entries(transitions)) {
    const newState = labelOf.get(state) ?? state; // estado inalcanzable desde initialState (no debería darse)
    const renamedActions = {};
    for (const [action, next] of Object.entries(actions)) {
      renamedActions[action] = next === ERROR_STATE ? next : (labelOf.get(next) ?? next);
    }
    renamedTransitions[newState] = renamedActions;
  }

  return {
    initialState: labelOf.get(initialState),
    transitions: renamedTransitions,
    labelOf: Object.fromEntries(labelOf),
  };
}

module.exports = { prettifyStates };
