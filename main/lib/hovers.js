/**
 * Hover: decides what a probed element is from what the crawler saw
 * (probeHover in lib/crawl/hoverProbe.js), without touching the browser.
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
 *
 * Used by lib/crawl/hoverProbe.js (classifyProbe, describeEffect, selfKeyOf,
 * IGNORE_REASON) while crawling, and by lib/report (summarizeHovers,
 * hoverNotes, hoverLines) when the table is turned into the report.
 *
 * A "snapshot" below is the array __crawlerEffects returns (instrument.js):
 * { k: key, p: parent key, t: tag, h?: 1 (hidden), a?: attributes, x?: own text,
 * cs?: changed computed styles }.
 */

const { kindOfAction } = require('./actions');
const { ERROR_STATE } = require('./constants');
const { sameJson, compositeKey, splitKey } = require('./util');

const MAX_CHANGES = 6;

/** What happened to an element between two snapshots; describeEffect compares these. */
const CHANGE = { appears: 'appears', disappears: 'disappears', shown: 'shown', hidden: 'hidden' };

/** Why a probed hover is NOT an action (the `reason` of hovers.ignored in transitions.json). */
const IGNORE_REASON = {
  noVisibleEffect: 'no visible effect',
  notInteractable: 'no longer interactable',
  navigationMissed: 'navigation did not reach this state',
  neverSettles: 'never settles (continuous animation)',
  pageDrifts: 'the page changes by itself over time',
  structuralInFastMode: 'structural, and fast mode (backSelector) cannot follow it',
};

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
  const reverted = sameJson(before, restored);
  if (sameJson(before, after)) return { type: 'inert', reverted, revealed: [], hidden: [] };

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

// text helpers for the effect notes
const q = (s) => JSON.stringify(s); // a quoted string
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`; // "1 state", "2 states"
// an attribute value for a note: "(unset)" when missing, cut when long
const show = (v) => (v === undefined ? '(unset)' : v.length > 60 ? `${v.slice(0, 57)}...` : v);
// how a snapshot element is named in a note: tag#id.firstClass
const labelOf = (e) => `${e.t}${e.a && e.a.id ? `#${e.a.id}` : ''}${e.a && e.a.class ? `.${e.a.class.split(' ')[0]}` : ''}`;

/**
 * The effect of a hover as a short list of readable changes, from two
 * snapshots. Changes on the element itself have no prefix
 * ("stroke: (unset) -> #000"); changes on another element carry its label.
 * @param {Object[]} before - snapshot before the hover
 * @param {Object[]} after - snapshot with the pointer over the element
 * @param {string|null} selfKey - snapshot key of the element the pointer was put over
 * @returns {{ changes: string[], more?: number }} at most MAX_CHANGES readable changes, and how many more there were
 */
function describeEffect(before, after, selfKey) {
  const prev = new Map(before.map((e) => [e.k, e]));
  const next = new Map(after.map((e) => [e.k, e]));
  const who = (e) => (e.k === selfKey ? '' : `${labelOf(e)}: `);
  const withText = (e) => (e.x ? ` (text ${q(e.x)})` : '');
  const changes = [];

  // Which elements appear, disappear, or are shown / hidden. When a group is
  // shown all its descendants appear with it; reporting the topmost is enough.
  const shown = (e) => !e.h;
  const flip = (k) => {
    const was = prev.get(k), now = next.get(k);
    if (!was && now) return CHANGE.appears;
    if (was && !now) return CHANGE.disappears;
    if (shown(was) !== shown(now)) return shown(now) ? CHANGE.shown : CHANGE.hidden;
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
        const label = how === CHANGE.appears || ref.k !== selfKey ? `${labelOf(ref)}: ` : '';
        changes.push(`${label}${how}${shown(now) ? withText(now) : ''}`);
      }
      continue;
    }
    if (now.h) continue;
    for (const name of new Set([...Object.keys(was.a), ...Object.keys(now.a)])) {
      if (was.a[name] !== now.a[name]) changes.push(`${who(now)}${name}: ${show(was.a[name])} -> ${show(now.a[name])}`);
    }
    if (was.x !== now.x) changes.push(`${who(now)}text: ${q(was.x)} -> ${q(now.x)}`);
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
    if (!next.has(k) && !underSameChange(was, CHANGE.disappears)) changes.push(`${labelOf(was)}: ${CHANGE.disappears}`);
  }

  const out = { changes: changes.slice(0, MAX_CHANGES) };
  if (changes.length > MAX_CHANGES) out.more = changes.length - MAX_CHANGES;
  return out;
}

/**
 * The crawler id of a gesture selector, or null: [data-crawler-id="c12"] -> "id:c12".
 * The "id:" key format must match the keys __crawlerEffects builds in instrument.js.
 * @param {string} sel - the selector of a gesture
 * @returns {string|null}
 */
function selfKeyOf(sel) {
  const m = /data-crawler-id="([^"]+)"/.exec(sel);
  return m ? `id:${m[1]}` : null;
}

/**
 * Per-action summary of the hovers in the transition table, for the report.
 * `effects`: state -> action -> effect (what describeEffect left, plus
 * `persistent` / `reveals` / `hides`); `ignored`: [{ action, reason, states }].
 * @param {Object} p
 * @param {Object<string, Object<string, string>>} p.transitions - the table, with clean names
 * @param {Object<string, Object<string, Object>>} [p.effects]
 * @param {{action: string, reason: string, states: number}[]} [p.ignored] - probed elements that are not actions
 * @returns {Object|null} the `hovers` section of transitions.json (actions grouped by type, effects, ignored),
 *   or null when there is no hover and none was ignored
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
  let meaning = 'hover actions (the pointer enters an element) that change something visible. transient: a highlight or tooltip that ' +
    'disappears on leaving and does not change what can be done (a loop on its state); structural: opens something or leaves a change, ' +
    'leading to another state (its way back is Unhover_); error: doing it breaks the page (reported as unexpected behavior). changes is the ' +
    'observed effect; hovers with no visible effect are not actions (ignored)';
  // only when there is one, so the output of pages without them does not change
  if (flagged('positional')) meaning += '. positional: the effect depends on where the pointer is aimed; it was tested at the center and at the edge of the element';
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
 * and the footer: "stroke: (unset) -> #000".
 * @param {Object|null} hovers - the section built by summarizeHovers
 * @returns {Object<string, string>} action -> its note (empty when there are no hovers)
 */
function hoverNotes(hovers) {
  const notes = {};
  if (!hovers) return notes;
  const text = (e) => {
    const parts = [...(e.changes || [])];
    if (e.more) parts.push(`... and ${e.more} more`);
    if (e.reveals && e.reveals.length) parts.push(`enables: ${e.reveals.join(', ')}`);
    if (e.hides && e.hides.length) parts.push(`disables: ${e.hides.join(', ')}`);
    if (e.persistent) parts.push('does not revert on leaving');
    if (e.positional) parts.push('depends on where it is aimed (tested at the center and at the edge)');
    return parts.join('; ');
  };
  for (const [action, a] of Object.entries(hovers.actions)) {
    notes[action] = a.effects ? a.effects.map((e) => `${text(e)} (in ${plural(e.in, 'state')})`).join(' | ') : text(a);
    if (a.errors) notes[action] = [notes[action], 'breaks the page (exception)'].filter(Boolean).join('; ');
  }
  return notes;
}

/**
 * The summary as lines of text for the log and the diagram footer. Actions
 * with the same effect are listed together ("Hover_a, Hover_b (2): stroke:
 * ..."), because in a visualization with dozens of elements almost all of them
 * do the same. After those come the probed elements that are NOT actions,
 * with the reason.
 * @param {Object|null} hovers - the section built by summarizeHovers
 * @returns {string[]}
 */
function hoverLines(hovers) {
  if (!hovers) return [];
  const notes = hoverNotes(hovers);
  const groups = new Map(); // "type\0note" -> actions
  for (const [action, a] of Object.entries(hovers.actions)) {
    const key = compositeKey(a.type, notes[action] || '(no effect noted)');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(action);
  }
  const lines = [];
  for (const [key, actions] of groups) {
    const [type, note] = splitKey(key);
    const where = { structural: 'changes state', transient: 'loop on the state', error: 'breaks the page' }[type];
    lines.push(`${actions.join(', ')} (${actions.length}; ${where}): ${note}`);
  }
  if (hovers.ignored && hovers.ignored.length) {
    // A hover with no effect in one state may have one in another (say, when it
    // was already applied), and there it is an action.
    const groups = new Map(); // 'reason\0elsewhere' -> items
    for (const { action, reason, states } of hovers.ignored) {
      const elsewhere = Boolean(hovers.actions[action]);
      const key = compositeKey(reason, elsewhere ? 1 : 0);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${action} (${plural(states, 'state')})`);
    }
    for (const [key, items] of groups) {
      const [reason, elsewhere] = splitKey(key);
      lines.push(elsewhere === '1'
        ? `no effect in some states (${reason}), though they have one in others: ${items.join(', ')}`
        : `NOT actions (${reason}): ${items.join(', ')}`);
    }
  }
  return lines;
}

module.exports = { IGNORE_REASON, classifyProbe, describeEffect, selfKeyOf, summarizeHovers, hoverNotes, hoverLines };
