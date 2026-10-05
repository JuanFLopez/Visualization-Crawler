/**
 * Limpia los nombres de acción (y de estado) de un transitions.json ya
 * generado: saca el sufijo numérico que se cuela desde el tooltip -- el
 * <title> típico de D3 es "flare/vis\n432,629" (ruta + valor del nodo),
 * y versiones anteriores del crawler lo aplanaban a "Click_vis_432,629".
 *
 *   "Click_vis_432,629": "root > vis_432,629"  ->  "Click_vis": "root > vis"
 *
 * Si al sacar el número dos acciones distintas quedan con el mismo nombre
 * (p.ej. "data_30,284" y "data_110,583" son dos nodos "data" en ramas
 * distintas), la primera en aparecer se queda con el nombre limpio y las
 * siguientes llevan "#2", "#3"... -- nunca se fusionan dos acciones.
 * Idempotente: sobre nombres ya limpios no cambia nada.
 */

const ERROR_STATE = '__ERROR__';

// número al final, tal como lo deja d3.format: "432,629", "989", "1.5", "12%"
const NUMERIC_SUFFIX = /_[-+]?\d[\d.,]*%?$/;

function stripNumber(action) {
  if (/^Click_unknown_\d+$/.test(action)) return action; // id interno, no un valor
  const stripped = action.replace(NUMERIC_SUFFIX, '');
  return stripped === 'Click_' || stripped === 'Click' ? action : stripped;
}

/**
 * @param {{initialState: string, transitions: Object, visibility?: Object}} data
 * @returns {{initialState: string, transitions: Object, renamed: Object, visibility?: Object}}
 *   renamed: acción vieja -> nueva (solo las que cambiaron)
 */
function cleanNames({ initialState, transitions, visibility = null }) {
  // orden de primera aparición, para que la desambiguación sea estable
  const actions = [];
  const seen = new Set();
  for (const trans of Object.values(transitions)) {
    for (const a of Object.keys(trans)) if (!seen.has(a)) { seen.add(a); actions.push(a); }
  }

  const rename = new Map();
  const taken = new Set();
  // primero las que no cambian, para que nunca les "roben" el nombre
  for (const a of actions) if (stripNumber(a) === a) { rename.set(a, a); taken.add(a); }
  for (const a of actions) {
    if (rename.has(a)) continue;
    const base = stripNumber(a);
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base}#${k}`;
    rename.set(a, name);
    taken.add(name);
  }

  // estados: los nombres legibles (lib/labels.js) son caminos de acciones
  // sin el "Click_" -- se renombra segmento por segmento con el mismo mapa
  const SEP = ' > ';
  const segRename = new Map();
  for (const [from, to] of rename) segRename.set(from.replace(/^Click_/, ''), to.replace(/^Click_/, ''));
  const renameState = (s) => {
    if (s === ERROR_STATE || !s.includes(SEP)) return s;
    return s.split(SEP).map((seg) => segRename.get(seg) ?? seg).join(SEP);
  };

  const out = {};
  for (const [state, trans] of Object.entries(transitions)) {
    const t = {};
    for (const [a, next] of Object.entries(trans)) t[rename.get(a)] = renameState(next);
    out[renameState(state)] = t;
  }

  const renamed = {};
  for (const [a, b] of rename) if (a !== b) renamed[a] = b;
  const result = { initialState: renameState(initialState), transitions: out, renamed };
  if (visibility) {
    result.visibility = {};
    for (const [state, byAction] of Object.entries(visibility)) {
      const v = {};
      for (const [a, frac] of Object.entries(byAction)) v[rename.get(a) ?? a] = frac;
      result.visibility[renameState(state)] = v;
    }
  }
  return result;
}

module.exports = { cleanNames };
