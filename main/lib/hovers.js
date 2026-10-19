/**
 * Hover: decides what a probed element is from what the crawler saw
 * (probeHover in crawler.js), without touching the browser.
 *
 * Probing a hover is: snapshot of the document (see __crawlerEffects in
 * instrument.js) -> the pointer enters -> snapshot -> the pointer leaves ->
 * snapshot. That yields one of three outcomes:
 *
 *   inert        Nothing visible changed while the pointer was over the
 *                element. NOT an action: a hover that does nothing is not an
 *                interaction of the visualization, and adding it to the
 *                alphabet would invent a hover that does not exist.
 *   decorative   Something changed (a highlight, a tooltip) but what the user
 *                can do did not: one more action OF THE SAME state (a loop in
 *                the automaton), with the effect noted.
 *   structural   What can be done changed (a menu opens), or the change does
 *                not revert on leaving: it leads to another state, with its
 *                own way back (unhover).
 *
 * Native browser tooltips (an SVG <title> child or a title="" attribute) never
 * become hover actions. D3 has no tooltip code (7.9.0 never creates a <title>);
 * the browser draws the tooltip as its own UI, with no listener and no DOM
 * change, so a probe can never observe an effect. Counting it would add a
 * hover that cannot be verified, which is exactly the phantom this module
 * exists to keep out. The <title> text is still used to name actions.
 */

const { kindOfAction } = require('./actions');

const ERROR_STATE = '__ERROR__';
const MAX_CHANGES = 6;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {Object} p
 * @param {string} p.state - key of the state where the probe ran
 * @param {string} p.hoveredKey - state key read with the pointer over the element
 * @param {Object[]} p.before - snapshot before the hover
 * @param {Object[]} p.after - ... with the pointer over the element
 * @param {Object[]} p.restored - ... after the pointer left
 * @param {string[]} p.actionsBefore - gestures available before (keys)
 * @param {string[]} p.actionsHovered - ... with the pointer over the element
 * @returns {{ type: 'inert'|'decorative'|'structural', reverted: boolean, revealed: string[], hidden: string[] }}
 *   revealed / hidden: gestures that become possible / impossible while the pointer is over the element
 */
function classifyProbe({ state, hoveredKey, before, after, restored, actionsBefore, actionsHovered }) {
  const reverted = same(before, restored);
  if (same(before, after)) return { type: 'inert', reverted, revealed: [], hidden: [] };

  const had = new Set(actionsBefore);
  const has = new Set(actionsHovered);
  const revealed = actionsHovered.filter((k) => !had.has(k));
  const hidden = actionsBefore.filter((k) => !has.has(k));
  const sameActions = revealed.length === 0 && hidden.length === 0;

  // If the state key does not change (what changed is not in the fingerprint,
  // e.g. an HTML tooltip) there is no other state to go to; if it does change
  // but reverts and leaves the actions alone, it is a highlight.
  const decorative = hoveredKey === state || (reverted && sameActions);
  return { type: decorative ? 'decorative' : 'structural', reverted, revealed, hidden };
}

const q = (s) => JSON.stringify(s);
const show = (v) => (v === undefined ? '(sin definir)' : v.length > 60 ? `${v.slice(0, 57)}...` : v);
const labelOf = (e) => `${e.t}${e.a && e.a.id ? `#${e.a.id}` : ''}${e.a && e.a.class ? `.${e.a.class.split(' ')[0]}` : ''}`;

/**
 * The effect of a hover as a short list of readable changes, from two
 * snapshots. Changes on the element itself have no prefix
 * ("stroke: (sin definir) -> #000"); changes on another element carry its label.
 * @param {string|null} selfKey - snapshot key of the element the pointer was put over
 * @returns {{ changes: string[], more?: number }}
 */
function describeEffect(before, after, selfKey) {
  const prev = new Map(before.map((e) => [e.k, e]));
  const next = new Map(after.map((e) => [e.k, e]));
  const who = (e) => (e.k === selfKey ? '' : `${labelOf(e)}: `);
  const withText = (e) => (e.x ? ` (texto ${q(e.x)})` : '');
  const changes = [];

  // Which elements appear, disappear, or are shown / hidden. When a group is
  // shown all its descendants appear with it; reporting the topmost is enough.
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
        // a hidden element keeps no attributes: to name it, use the earlier one
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
    // Computed styles that changed (a CSS :hover): if an attribute of the same
    // name changed it is already reported, and if the parent changed the same
    // way the child merely inherits it, so the parent's line is enough.
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

/** The crawler id of a gesture selector, or null: [data-crawler-id="c12"] -> "id:c12". */
function selfKeyOf(sel) {
  const m = /data-crawler-id="([^"]+)"/.exec(sel);
  return m ? `id:${m[1]}` : null;
}

/**
 * Per-action summary of the hovers in the transition table, for the report.
 * `effects`: state -> action -> effect (what describeEffect left, plus
 * `persistent` / `reveals` / `hides`); `ignored`: [{ action, reason, states }].
 * @returns {Object|null} null when there is no hover and none was ignored
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
  // only when there is one, so the output of pages without them does not change
  if (flagged('positional')) meaning += '. positional: el efecto depende de dónde se apunta; se probó en el centro y en el borde del elemento';
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

/**
 * One line of text per action saying what it does, for the diagram tooltip
 * and the footer: "stroke: (sin definir) -> #000".
 */
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
    return parts.join('; ');
  };
  for (const [action, a] of Object.entries(hovers.actions)) {
    notes[action] = a.effects ? a.effects.map((e) => `${text(e)} (en ${e.in} estados)`).join(' | ') : text(a);
    if (a.errors) notes[action] = [notes[action], 'rompe la página (excepción)'].filter(Boolean).join('; ');
  }
  return notes;
}

/**
 * The summary as lines of text for the log and the diagram footer. Actions
 * with the same effect are listed together ("Hover_a, Hover_b (2): stroke:
 * ..."), because in a visualization with dozens of elements almost all of them
 * do the same. After those come the probed elements that are NOT actions,
 * with the reason.
 */
function hoverLines(hovers) {
  if (!hovers) return [];
  const notes = hoverNotes(hovers);
  const groups = new Map(); // "type\0note" -> actions
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
    // A hover with no effect in one state may have one in another (say, when it
    // was already applied), and there it is an action.
    const groups = new Map(); // 'reason\0elsewhere' -> items
    for (const { action, reason, states } of hovers.ignored) {
      const elsewhere = Boolean(hovers.actions[action]);
      const key = `${reason}\u0000${elsewhere ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${action} (${states} ${states === 1 ? 'estado' : 'estados'})`);
    }
    for (const [key, items] of groups) {
      const [reason, elsewhere] = key.split('\u0000');
      lines.push(elsewhere === '1'
        ? `sin efecto en algunos estados (${reason}), aunque sí lo tienen en otros: ${items.join(', ')}`
        : `NO son acciones (${reason}): ${items.join(', ')}`);
    }
  }
  return lines;
}

module.exports = { classifyProbe, describeEffect, selfKeyOf, summarizeHovers, hoverNotes, hoverLines };
