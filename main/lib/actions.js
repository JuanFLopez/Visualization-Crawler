/**
 * Action naming. An action is a symbol of the automaton's alphabet, written
 * "<Kind>_<element>" (for example "Click_vis"): the prefix says what kind of
 * interaction it is and the rest says which element it is done on. Everything
 * that builds or shows names (the crawler, the diagram, the expected regex)
 * goes through this module instead of assuming "Click_".
 *
 *   click    click the element
 *   hover    put the pointer over it (mouseover / mouseenter)
 *   unhover  take it away; it exists only as the way back from a hover that
 *            changes what can be done (an opened menu), never for a plain
 *            highlight, which does not change state
 */

/** Interaction kind -> prefix of its action names. */
const PREFIXES = { click: 'Click_', hover: 'Hover_', unhover: 'Unhover_' };

/** Kind assumed for a name written without a prefix (the expected regex). */
const DEFAULT_KIND = 'click';

const UNKNOWN = 'unknown_';

const prefixes = Object.values(PREFIXES).join('|');
const PREFIX_RE = new RegExp(`^(?:${prefixes})`);

/**
 * @param {'click'|'hover'|'unhover'} kind
 * @param {string} base - the element part of the name
 * @returns {string} "Click_vis", "Hover_vis", ...
 * @throws {Error} on an unknown kind
 */
function actionName(kind, base) {
  if (!Object.hasOwn(PREFIXES, kind)) throw new Error(`unknown action kind: ${kind}`);
  return PREFIXES[kind] + base;
}

/**
 * Name for an element with no readable identity (see createNaming in lib/crawl/naming.js).
 * @param {'click'|'hover'|'unhover'} kind
 * @param {number} n - running counter
 */
function internalName(kind, n) {
  return actionName(kind, `${UNKNOWN}${n}`);
}

/**
 * "Click_vis" -> "click".
 * @returns {'click'|'hover'|'unhover'|null} null when the name has no known prefix
 */
function kindOfAction(action) {
  return Object.keys(PREFIXES).find((kind) => action.startsWith(PREFIXES[kind])) ?? null;
}

/** "Click_vis" -> "vis". */
function shortAction(action) {
  return action.replace(PREFIX_RE, '');
}

/**
 * The name as it is displayed, or used inside a state name: clicks without
 * the prefix ("vis"), everything else with it ("Hover_vis"). Without the
 * prefix a hover on "vis" and a click on "vis" would read the same.
 */
function displayAction(action) {
  return kindOfAction(action) === 'click' ? shortAction(action) : action;
}

/**
 * The verb to use for the action in a message; an unprefixed name (a hand-written table) reads as a click.
 * @returns {'click'|'hover'|'unhover'}
 */
function verbOf(action) {
  return kindOfAction(action) ?? 'click';
}

/** "Hover_vis" -> "Unhover_vis": a hover and its way back are named as a pair. */
function unhoverOf(hoverAction) {
  return actionName('unhover', shortAction(hoverAction));
}

module.exports = {
  DEFAULT_KIND, actionName, internalName, kindOfAction, shortAction, displayAction, verbOf, unhoverOf,
};
