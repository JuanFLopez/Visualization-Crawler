/**
 * Values shared by the crawler, the analysis and the diagram, defined once so
 * that every module agrees on them.
 */

/** The state a click that makes the page throw leads to. It is a sink: it has no outgoing transitions. */
const ERROR_STATE = '__ERROR__';

/** Separates the segments of a hierarchical state name, as in "root > vis > operator" (built by lib/labels.js). */
const HIERARCHY_SEPARATOR = ' > ';

/**
 * The two automata an expected regex is compared against: the one with the
 * cycles cut (the one the diagram shows) and the full one. The values appear in
 * transitions.json (`comparison`).
 */
const AUTOMATON = { cut: 'cut', full: 'full' };

module.exports = { ERROR_STATE, HIERARCHY_SEPARATOR, AUTOMATON };
