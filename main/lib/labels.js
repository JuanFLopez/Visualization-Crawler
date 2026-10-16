const { displayAction, verbOf } = require('./actions');

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
 * Si además vienen `data.labels` (nombres legibles por estado y acción,
 * ver crawler.js) y describen una jerarquía, los nombres salen de la
 * jerarquía de datos y no del camino de clicks (ver hierarchyLabels).
 *
 * @param {{initialState: string, transitions: Object, visibility?: Object, labels?: Object}} data
 * @param {Object} [opts]
 * @param {string} [opts.rootLabel='root']
 * @param {string} [opts.separator=' > ']
 * @returns {{initialState: string, transitions: Object, labelOf: Object, hierarchical: boolean, visibility?: Object}}
 *   labelOf mapea el hash original -> nombre legible, por si hace falta
 *   correlacionar con checkpoints o logs previos.
 */
function prettifyStates(data, { rootLabel = 'root', separator = ' > ' } = {}) {
  const { initialState, transitions } = data;
  const ERROR_STATE = '__ERROR__';

  const hierarchy = hierarchyLabels(data, { rootLabel, separator });
  const labelOf = hierarchy || new Map([[initialState, rootLabel]]);
  // con jerarquía ya están nombrados los alcanzables haciendo clicks; los que
  // solo se alcanzan con un hover ("root > Hover_menu") se nombran desde su origen
  const queue = hierarchy ? [...hierarchy.keys()] : [initialState];

  while (queue.length > 0) {
    const state = queue.shift();
    const actions = transitions[state] || {};
    for (const [action, next] of Object.entries(actions)) {
      if (next === ERROR_STATE || labelOf.has(next)) continue;
      const short = displayAction(action);
      let label = `${labelOf.get(state)}${separator}${short}`;
      const existing = new Set(labelOf.values());
      let suffix = 2;
      while (existing.has(label)) label = `${labelOf.get(state)}${separator}${short}#${suffix++}`;
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

  const result = {
    initialState: labelOf.get(initialState),
    transitions: renamedTransitions,
    labelOf: Object.fromEntries(labelOf),
    hierarchical: !!hierarchy,
  };
  if (data.visibility) {
    result.visibility = {};
    for (const [state, byAction] of Object.entries(data.visibility)) result.visibility[labelOf.get(state) ?? state] = byAction;
  }
  if (data.effects) {
    result.effects = {};
    for (const [state, byAction] of Object.entries(data.effects)) result.effects[labelOf.get(state) ?? state] = byAction;
  }
  return result;
}

/**
 * Nombres por JERARQUÍA de datos ("root > vis > operator") en vez de por
 * camino de clicks. Hace falta porque el camino de clicks más corto no
 * dice en qué nivel está un estado: un sunburst muestra dos anillos, así
 * que desde la raíz se clickea "operator" (nivel 2) directo, y por BFS
 * quedaría como "root > operator", a la par de "vis" -- y el diagrama
 * dibujaría vis -> operator como un movimiento lateral.
 *
 * Cada acción trae el nombre legible completo del elemento clickeado EN el
 * estado de origen (`data.labels`, ver crawler.js), que en una
 * visualización jerárquica es un camino ("flare/vis/operator", del
 * <title> o del dato D3). El camino de un estado es el prefijo común más
 * largo (por segmentos) de los caminos de todas las acciones que entran a
 * él: entrar a "animate" en un icicle es clickear animate
 * (flare/animate) o clickear un hijo enfocado (flare/animate/Easing, que
 * sube al padre); el prefijo común es flare/animate.
 *
 * Todo o nada: si algún estado queda sin camino, dos estados comparten
 * camino, o alguno no cuelga del camino del inicial, devuelve null y se
 * usa el nombre por camino de clicks (visualizaciones no jerárquicas).
 *
 * @returns {Map<string, string> | null} estado -> nombre
 */
function hierarchyLabels({ initialState, transitions, labels }, { rootLabel = 'root', separator = ' > ' } = {}) {
  if (!labels) return null;
  const ERROR_STATE = '__ERROR__';

  // Solo cuentan los clicks: son los que bajan por la jerarquía de datos. Un
  // hover sobre "flare/vis" que no cambia de estado (o la vuelta de un hover)
  // también "entra" a un estado con ese camino, y ensuciaría el nombre.
  const isClick = (action) => verbOf(action) === 'click';
  const reachable = new Set([initialState]);
  const queue = [initialState];
  while (queue.length) {
    for (const [action, next] of Object.entries(transitions[queue.shift()] || {})) {
      if (isClick(action) && next !== ERROR_STATE && !reachable.has(next)) { reachable.add(next); queue.push(next); }
    }
  }

  const incoming = new Map();
  for (const state of reachable) {
    for (const [action, next] of Object.entries(transitions[state] || {})) {
      const readable = labels[state] && labels[state][action];
      if (!isClick(action) || next === ERROR_STATE || typeof readable !== 'string') continue;
      const segments = readable.split('/').map((s) => s.trim()).filter(Boolean);
      if (segments.length === 0) continue;
      if (!incoming.has(next)) incoming.set(next, []);
      incoming.get(next).push(segments);
    }
  }

  const commonPrefix = (paths) => {
    let prefix = paths[0];
    for (const p of paths.slice(1)) {
      let k = 0;
      while (k < prefix.length && k < p.length && prefix[k] === p[k]) k++;
      prefix = prefix.slice(0, k);
    }
    return prefix;
  };

  const pathOf = new Map();
  for (const state of reachable) {
    if (state === initialState) continue;
    const paths = incoming.get(state);
    if (!paths) return null;
    const path = commonPrefix(paths);
    if (path.length === 0) return null;
    pathOf.set(state, path);
  }
  // el inicial puede no tener acciones que entren a él (nada "vuelve")
  const rootPath = incoming.has(initialState)
    ? commonPrefix(incoming.get(initialState))
    : commonPrefix([...pathOf.values()]);
  if (!rootPath || rootPath.length === 0) return null;

  const out = new Map([[initialState, rootLabel]]);
  const used = new Set([rootLabel]);
  for (const [state, path] of pathOf) {
    const hangsFromRoot = path.length > rootPath.length && rootPath.every((seg, i) => path[i] === seg);
    const rest = path.slice(rootPath.length);
    if (!hangsFromRoot || rest.some((seg) => seg.includes(separator.trim()))) return null;
    const label = [rootLabel, ...rest].join(separator);
    if (used.has(label)) return null;
    used.add(label);
    out.set(state, label);
  }
  return out;
}

module.exports = { prettifyStates, hierarchyLabels };
