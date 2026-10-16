/**
 * Hover: qué se decide con lo que el crawler vio al probar un elemento
 * (probeHover en crawler.js), sin tocar el browser.
 *
 * Probar un hover es: instantánea del documento (ver __crawlerEffects en
 * instrument.js) -> el puntero entra -> instantánea -> el puntero sale ->
 * instantánea. De ahí sale una de tres cosas:
 *
 *   inerte       No cambió nada visible mientras el puntero estaba encima.
 *                NO es una acción: un hover que no hace nada no es una
 *                interacción de la visualización, y meterlo en el alfabeto
 *                sería inventar un hover que no existe.
 *   decorativa   Cambió algo (un resaltado, un tooltip) pero no cambia qué
 *                puede hacer el usuario: es una acción más DEL MISMO estado
 *                (un bucle en el autómata), y el efecto queda anotado.
 *   estructural  Cambia qué se puede hacer (un menú que se abre) o deja un
 *                cambio que no se revierte al salir: lleva a otro estado,
 *                con su propia vuelta (unhover).
 */

const { kindOfAction } = require('./actions');

const ERROR_STATE = '__ERROR__';
const MAX_CHANGES = 6;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {Object} p
 * @param {string} p.state - clave del estado donde se probó
 * @param {string} p.hoveredKey - clave del estado leída con el puntero encima
 * @param {Object[]} p.before - instantánea antes del hover
 * @param {Object[]} p.after - ... con el puntero encima
 * @param {Object[]} p.restored - ... después de sacar el puntero
 * @param {string[]} p.actionsBefore - gestos disponibles antes (claves)
 * @param {string[]} p.actionsHovered - ... con el puntero encima
 * @returns {{ type: 'inert'|'decorative'|'structural', reverted: boolean, revealed: string[], hidden: string[] }}
 *   revealed/hidden: gestos que aparecen / dejan de poder hacerse mientras el puntero está encima
 */
function classifyProbe({ state, hoveredKey, before, after, restored, actionsBefore, actionsHovered }) {
  const reverted = same(before, restored);
  if (same(before, after)) return { type: 'inert', reverted, revealed: [], hidden: [] };

  const had = new Set(actionsBefore);
  const has = new Set(actionsHovered);
  const revealed = actionsHovered.filter((k) => !had.has(k));
  const hidden = actionsBefore.filter((k) => !has.has(k));
  const sameActions = revealed.length === 0 && hidden.length === 0;

  // Si el estado no cambia de clave (lo que cambió no lo mira el
  // fingerprint, p.ej. un tooltip HTML) no hay un estado distinto al que
  // ir; si cambia pero revierte y no cambia las acciones, es un resaltado.
  const decorative = hoveredKey === state || (reverted && sameActions);
  return { type: decorative ? 'decorative' : 'structural', reverted, revealed, hidden };
}

const q = (s) => JSON.stringify(s);
const show = (v) => (v === undefined ? '(sin definir)' : v.length > 60 ? `${v.slice(0, 57)}...` : v);
const labelOf = (e) => `${e.t}${e.a && e.a.id ? `#${e.a.id}` : ''}${e.a && e.a.class ? `.${e.a.class.split(' ')[0]}` : ''}`;

/**
 * El efecto de un hover como una lista corta de cambios legibles, a partir
 * de dos instantáneas. Los cambios en el propio elemento van sin prefijo
 * ("stroke: (sin definir) -> #000"); los de otro llevan su etiqueta.
 * @param {string|null} selfKey - clave del elemento sobre el que se puso el puntero
 * @returns {{ changes: string[], more?: number }}
 */
function describeEffect(before, after, selfKey) {
  const prev = new Map(before.map((e) => [e.k, e]));
  const next = new Map(after.map((e) => [e.k, e]));
  const who = (e) => (e.k === selfKey ? '' : `${labelOf(e)}: `);
  const withText = (e) => (e.x ? ` (texto ${q(e.x)})` : '');
  const changes = [];

  // Qué elementos aparecen, desaparecen o se muestran/ocultan. Cuando se
  // muestra un grupo aparecen con él todos sus descendientes; alcanza con
  // decir lo de más arriba.
  const shown = (e) => !e.h;
  const flip = (k) => {
    const was = prev.get(k), now = next.get(k);
    if (!was && now) return 'aparece';
    if (was && !now) return 'desaparece';
    if (shown(was) !== shown(now)) return shown(now) ? 'se muestra' : 'se oculta';
    return null;
  };
  const underSameChange = (e, how) => e.p !== null && flip(e.p) === how;

  for (const [k, now] of next) {
    const was = prev.get(k);
    const how = flip(k);
    if (how) {
      if (!underSameChange(now, how)) {
        // un elemento oculto no guarda atributos: para nombrarlo, el de antes
        const ref = shown(now) ? now : was || now;
        const label = how === 'aparece' || ref.k !== selfKey ? `${labelOf(ref)}: ` : '';
        changes.push(`${label}${how}${shown(now) ? withText(now) : ''}`);
      }
      continue;
    }
    if (now.h) continue;
    for (const name of new Set([...Object.keys(was.a), ...Object.keys(now.a)])) {
      if (was.a[name] !== now.a[name]) changes.push(`${who(now)}${name}: ${show(was.a[name])} -> ${show(now.a[name])}`);
    }
    if (was.x !== now.x) changes.push(`${who(now)}texto: ${q(was.x)} -> ${q(now.x)}`);
    // estilos calculados que cambiaron (un :hover de CSS): si un atributo del mismo nombre cambió, ya está dicho
    // (y si el padre cambió igual, el hijo solo lo hereda: alcanza con la línea del padre)
    const parent = now.p ? next.get(now.p) : null;
    for (const [prop, [from, to]] of Object.entries(now.cs || {})) {
      if (was.a[prop] !== now.a[prop]) continue;
      const inherited = parent && parent.cs && parent.cs[prop] && parent.cs[prop][0] === from && parent.cs[prop][1] === to;
      if (!inherited) changes.push(`${who(now)}${prop} (CSS): ${show(from)} -> ${show(to)}`);
    }
  }
  for (const [k, was] of prev) {
    if (!next.has(k) && !underSameChange(was, 'desaparece')) changes.push(`${labelOf(was)}: desaparece`);
  }

  const out = { changes: changes.slice(0, MAX_CHANGES) };
  if (changes.length > MAX_CHANGES) out.more = changes.length - MAX_CHANGES;
  return out;
}

// el id del crawler de un selector de gesto, o null: [data-crawler-id="c12"] -> "id:c12"
function selfKeyOf(sel) {
  const m = /data-crawler-id="([^"]+)"/.exec(sel);
  return m ? `id:${m[1]}` : null;
}

/**
 * Resumen por acción de los hovers de la tabla de transiciones, para el
 * reporte. `effects`: estado -> acción -> efecto (lo que dejó describeEffect,
 * más `persistent`/`reveals`/`hides`); `ignored`: [{ action, reason, states }].
 * @returns {Object|null} null si no hay ningún hover ni ninguno ignorado
 */
function summarizeHovers({ transitions, effects = {}, ignored = [] }) {
  const byAction = new Map();
  for (const [state, trans] of Object.entries(transitions)) {
    for (const [action, to] of Object.entries(trans)) {
      if (kindOfAction(action) !== 'hover') continue;
      if (!byAction.has(action)) byAction.set(action, { states: 0, loops: 0, moves: 0, errors: 0, effects: new Map() });
      const a = byAction.get(action);
      a.states++;
      if (to === ERROR_STATE) a.errors++;
      else if (to !== state) a.moves++;
      else a.loops++;
      const effect = effects[state] && effects[state][action];
      if (effect) {
        const sig = JSON.stringify(effect);
        if (!a.effects.has(sig)) a.effects.set(sig, { in: 0, effect });
        a.effects.get(sig).in++;
      }
    }
  }
  if (byAction.size === 0 && ignored.length === 0) return null;

  const actions = {};
  let transient = 0, structural = 0, broken = 0;
  for (const [action, a] of byAction) {
    const type = a.moves > 0 ? 'structural' : a.loops > 0 ? 'transient' : 'error';
    const entry = { type, states: a.states };
    if (type === 'structural') structural++; else if (type === 'transient') transient++; else broken++;
    if (a.errors) entry.errors = a.errors;
    const distinct = [...a.effects.values()];
    if (distinct.length === 1) Object.assign(entry, distinct[0].effect);
    else if (distinct.length > 1) entry.effects = distinct.map((d) => ({ in: d.in, ...d.effect }));
    actions[action] = entry;
  }

  const flagged = (flag) => Object.values(actions).some((a) => a[flag] || (a.effects || []).some((e) => e[flag]));
  let meaning = 'acciones de hover (el puntero entra a un elemento) que cambian algo visible. transient: un resaltado o tooltip que ' +
    'desaparece al salir y no cambia qué se puede hacer (un bucle en su estado); structural: abre algo o deja un cambio, lleva a ' +
    'otro estado (su vuelta es Unhover_); error: hacerlo rompe la página (se informa como comportamiento inesperado). changes es el efecto ' +
    'observado; los hovers sin efecto visible no son acciones (ignored)';
  // solo cuando hay uno: así la salida de lo que no los tiene no cambia
  if (flagged('positional')) meaning += '. positional: el efecto depende de dónde se apunta; se probó en el centro y en el borde del elemento';
  if (flagged('native')) meaning += '. native: tooltip nativo del navegador (un <title>); no cambia el DOM, así que se confía en que el elemento lo tiene y no en un cambio observado';
  const out = {
    meaning,
    transient,
    structural,
    ...(broken ? { broken } : {}),
    actions,
  };
  if (ignored.length) out.ignored = ignored;
  return out;
}

// Una línea por acción con lo que hace, para el tooltip del diagrama y el
// pie: "stroke: (sin definir) -> #000".
function hoverNotes(hovers) {
  const notes = {};
  if (!hovers) return notes;
  const text = (e) => {
    const parts = [...(e.changes || [])];
    if (e.more) parts.push(`... y ${e.more} más`);
    if (e.reveals && e.reveals.length) parts.push(`habilita: ${e.reveals.join(', ')}`);
    if (e.hides && e.hides.length) parts.push(`impide: ${e.hides.join(', ')}`);
    if (e.persistent) parts.push('no se revierte al salir');
    if (e.positional) parts.push('depende de dónde se apunta (probado en el centro y en el borde)');
    if (e.native) parts.push('lo dibuja el navegador: no se verifica en el DOM');
    return parts.join('; ');
  };
  for (const [action, a] of Object.entries(hovers.actions)) {
    notes[action] = a.effects ? a.effects.map((e) => `${text(e)} (en ${e.in} estados)`).join(' | ') : text(a);
    if (a.errors) notes[action] = [notes[action], 'rompe la página (excepción)'].filter(Boolean).join('; ');
  }
  return notes;
}

/**
 * El resumen en líneas de texto para el log y el pie del diagrama: las
 * acciones con el mismo efecto van juntas ("Hover_a, Hover_b (2): stroke: ..."),
 * porque en una visualización con decenas de elementos casi todos hacen lo
 * mismo. Después, lo que se probó y NO es una acción, con el motivo.
 */
function hoverLines(hovers) {
  if (!hovers) return [];
  const notes = hoverNotes(hovers);
  const groups = new Map(); // "tipo\0nota" -> acciones
  for (const [action, a] of Object.entries(hovers.actions)) {
    const key = `${a.type}\u0000${notes[action] || '(sin efecto anotado)'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(action);
  }
  const lines = [];
  for (const [key, actions] of groups) {
    const [type, note] = key.split('\u0000');
    const where = { structural: 'cambia de estado', transient: 'bucle en el estado', error: 'rompe la página' }[type];
    lines.push(`${actions.join(', ')} (${actions.length}; ${where}): ${note}`);
  }
  if (hovers.ignored && hovers.ignored.length) {
    // un hover sin efecto en un estado puede tenerlo en otro (p.ej. si ya lo había aplicado): ahí sí es una acción
    const groups = new Map(); // 'motivo aislado' -> items
    for (const { action, reason, states } of hovers.ignored) {
      const elsewhere = Boolean(hovers.actions[action]);
      const key = `${reason} ${elsewhere ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${action} (${states} ${states === 1 ? 'estado' : 'estados'})`);
    }
    for (const [key, items] of groups) {
      const [reason, elsewhere] = key.split(' ');
      lines.push(elsewhere === '1'
        ? `sin efecto en algunos estados (${reason}), aunque sí lo tienen en otros: ${items.join(', ')}`
        : `NO son acciones (${reason}): ${items.join(', ')}`);
    }
  }
  return lines;
}

module.exports = { classifyProbe, describeEffect, selfKeyOf, summarizeHovers, hoverNotes, hoverLines };
