/**
 * DEPTH-FIRST EXPLORATION: every new state is expanded the moment it is
 * discovered (the page is already standing there, no navigation needed).
 * Once done, its transitions are known, and in almost any zoomable
 * visualization one of them leads "backwards", so returning to the previous
 * state rarely requires a reload.
 *
 * Expanding a state means: stand in it, list its actionable candidates (clicks
 * first, then hovers), and for each one that has no transition yet, perform it,
 * record where it led and, if that is a new state, expand it right away. Every
 * function here takes the crawl context `ctx` described in crawler.js
 * (CrawlContext).
 */

const { ERROR_STATE } = require('../constants');
const { IGNORE_REASON } = require('../hovers');
const { gestureKey } = require('./gestures');
const { newNode, ensureField } = require('./graph');

/**
 * Records what the report needs to know about a candidate: its readable name (to
 * name the states by their place in the hierarchy) and, for a click on a partly
 * visible element, how much of it was visible.
 * @param {import('./graph').GraphNode} node - the state being expanded
 * @param {string} action
 * @param {import('./gestures').Gesture} gesture
 * @param {import('../page/discovery').Candidate} info
 */
function noteCandidate(node, action, gesture, { visibleFrac, readable, tag }) {
  ensureField(node, 'labels')[action] = { readable, tag };
  // Only the ones that are partly visible (rounded to 2 decimals): they are
  // what the report flags (see measure in lib/page/actionability.js).
  if (gesture.kind === 'click' && visibleFrac != null && Math.round(visibleFrac * 100) < 100) {
    ensureField(node, 'visibility')[action] = Math.round(visibleFrac * 100) / 100;
  }
}

/**
 * Performs a click from `state`, records where it led (a new state is expanded at once; a page error leads to
 * __ERROR__) and leaves the navigator knowing where the page is.
 */
async function expandClick(ctx, state, node, action, gesture) {
  const { session, graph, nav, settleMs, maxStates } = ctx;
  await nav.navigateTo(state, settleMs);
  await session.perform(gesture, settleMs);
  nav.current = null;

  const nextState = session.errors.length > 0 ? ERROR_STATE : await session.readState();
  node.transitions[action] = nextState;
  node.gestures[action] = gesture;
  nav.current = nextState;

  if (nextState !== ERROR_STATE && !graph.has(nextState)) {
    graph.set(nextState, newNode([...node.path, gesture]));
    if (graph.size <= maxStates) await expand(ctx, nextState);
  }
}

// `pass` carries what is learned across the hovers of one state: whether the
// page drifts (looked at once, before the first hover) and the hovers with no
// effect of their own, whose listener may be a container's (delegated).
async function expandHover(ctx, state, node, action, gesture, info, found, pass) {
  const { probe, log } = ctx;
  if (pass.drifting === null) {
    pass.drifting = await probe.pageDrifts(state);
    if (pass.drifting) log('hover: the page changes by itself over time; what a hover does cannot be told apart from that, so the hovers of this state are skipped');
  }
  if (pass.drifting) {
    ensureField(node, 'inert')[action] = IGNORE_REASON.pageDrifts;
    return;
  }
  const result = await probe.probeHover(state, node, action, gesture, found, info);
  if (result === 'inert' && info.sources.some((s) => s === 'listener' || s === 'inline')) {
    pass.containers.push([action, gesture]);
  }
}

/**
 * Expands `state` and, depth-first, every new state it discovers.
 * @param {Object} ctx - the crawl context (see CrawlContext in crawler.js)
 * @param {string} state - a state of ctx.graph that has not been expanded
 */
async function expand(ctx, state) {
  const { session, graph, nav, nameFor, selectors, discoverySettleMs, maxDelegated, probe, countStep, onStateExpanded } = ctx;
  const node = graph.get(state);

  await nav.navigateTo(state, discoverySettleMs);
  const found = await session.discoverCandidates(selectors, nameFor);
  // With the pointer over something (a state a hover led to) only the clicks
  // that hover enables, and the element's own, are followed: to click anything
  // else the user has to take the pointer off, and that is already the way
  // back (unhover). No more hovers are probed from there either.
  const candidates = node.pointer
    ? found.filter(([, g]) => g.kind === 'click' && (g.sel === node.pointer.sel || node.enabled.includes(gestureKey(g))))
    : found;

  const pass = { drifting: null, containers: [] };
  for (const [action, gesture, info] of candidates) {
    if (action in node.transitions) continue;
    noteCandidate(node, action, gesture, info);
    countStep();
    if (gesture.kind === 'hover') await expandHover(ctx, state, node, action, gesture, info, found, pass);
    else await expandClick(ctx, state, node, action, gesture);
  }

  if (pass.containers.length > 0 && maxDelegated > 0) await probe.probeDelegated(state, node, found, pass.containers);

  node.expanded = true;
  if (onStateExpanded) onStateExpanded(state, node.transitions, graph.size);
}

module.exports = { expand };
