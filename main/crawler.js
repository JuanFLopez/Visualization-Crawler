/**
 * Crawler: explores a D3 visualization by performing gestures (clicks and
 * hovers) and builds the graph of its states, a DFA whose alphabet is the set
 * of actions.
 *
 * This file wires the crawl together; each concern has its own module:
 *   lib/crawl/session.js      the page: virtual time, automatic state detection, performing gestures
 *   lib/crawl/navigator.js    getting back to a state (fast mode with a backSelector, or reload + replay)
 *   lib/crawl/expand.js       depth-first exploration of a state's clicks and hovers
 *   lib/crawl/hoverProbe.js   probing hovers (listeners, inline handlers, CSS :hover, delegated)
 *   lib/crawl/graph.js        the graph of discovered states and the final tables
 *   lib/crawl/naming.js       naming the actions after their elements
 *   lib/page/                 the helpers that run inside the page
 *
 * A state is never expanded again once it has been, and that alone makes the crawl
 * terminate even when the real graph has cycles. As an extra safety net, an
 * unstable stateKeyFn / fingerprint hits a hard step limit (maxSteps) that
 * aborts instead of growing without bound.
 *
 * crawl() knows nothing about files, regexes or diagrams: run.js turns the raw
 * tables it returns into the report.
 *
 * Every part of the crawl shares one context object, built in runCrawl:
 *
 * @typedef {Object} CrawlContext
 * @property {ReturnType<import('./lib/crawl/session').createSession>} session - the page
 * @property {Map<string, import('./lib/crawl/graph').GraphNode>} graph - the states discovered so far
 * @property {ReturnType<import('./lib/crawl/navigator').createNavigator>} nav - moves the page; `nav.current` is where it is
 * @property {ReturnType<import('./lib/crawl/hoverProbe').createHoverProbe>} probe - probes hovers
 * @property {(info: Object, gesture: Object) => string} nameFor - the name of an action; the same element always gets the same one
 * @property {{click: string, hover: string|null, container: string|null, css: boolean}} selectors - what to look for
 * @property {(msg: string) => void} log
 * @property {string|null} backSelector - fast navigation mode when set
 * @property {number|null} settleMs - fixed wait after a gesture, null = virtual time
 * @property {number|null} discoverySettleMs - the same, for re-entering a state before listing its candidates
 * @property {number} maxStates - states to discover before stopping (the result is then truncated)
 * @property {number} maxDelegated - D3 marks to probe per delegated listener
 * @property {Function|null} onStateExpanded - progress hook
 * @property {() => void} countStep - counts an interaction; throws past maxSteps
 * @property {(state: string) => Promise<void>} expand - expands a state (used when a hover discovers one)
 */

const { launchBrowser } = require('./lib/host');
const { createSession } = require('./lib/crawl/session');
const { createNaming, renameUnstableActions } = require('./lib/crawl/naming');
const { createNavigator } = require('./lib/crawl/navigator');
const { createHoverProbe } = require('./lib/crawl/hoverProbe');
const { expand } = require('./lib/crawl/expand');
const { newNode, collectResult } = require('./lib/crawl/graph');

/**
 * @param {Object} opts
 * @param {string} opts.fixtureUrl
 * @param {string} [opts.chromePath] - Playwright's bundled Chromium when omitted.
 * @param {string} [opts.clickableSelector='[data-crawler-clickable]']
 * @param {boolean} [opts.hover=true] - also probe hovers (elements with a
 *   mouseover / mouseenter / pointerover / pointerenter listener). A hover
 *   enters the automaton only when it changes something visible (see lib/hovers.js).
 * @param {string} [opts.hoverableSelector='[data-crawler-hoverable]']
 * @param {number} [opts.maxDelegated=50] - cap on the D3 marks probed for each
 *   delegated listener (0 = do not probe delegated listeners)
 * @param {(msg: string) => void} [opts.onLog] - crawl warnings (hovers that are skipped)
 * @param {(rawState: any) => string} [opts.stateKeyFn=(raw)=>raw]
 * @param {string[]} [opts.initScripts] - JS code to inject before the user's page
 *   runs (through page.addInitScript), e.g. the contents of instrument.js for
 *   automatic detection.
 * @param {string} [opts.backSelector] - fast navigation mode (see
 *   lib/crawl/navigator.js). Generic mode (reload + replay) when omitted.
 * @param {number} [opts.settleMs] - FIXED pause after every gesture. When
 *   omitted (or null) the wait is adaptive: until the state stops changing, no
 *   requests are in flight and no animation frames are requested (see
 *   window.__crawlerActivity in instrument.js).
 * @param {number} [opts.discoverySettleMs] - settle used specifically when
 *   re-entering a state before listing its candidates. Defaults to settleMs
 *   (fixed or adaptive).
 * @param {number} [opts.maxStates=1000] - when reached, the result is returned
 *   with `truncated: true`.
 * @param {number} [opts.maxSteps=20000] - hard cap on total interactions.
 * @param {(state: string, transitions: Object, knownStates: number) => void} [opts.onStateExpanded] -
 *   progress hook, called every time a state has been expanded.
 * @returns {Promise<{transitions: Object, initialState: string, visibility: Object, renamed: Object, usedManualState: boolean, truncated: boolean}>}
 *   visibility: state -> action -> visible fraction, only for clicks on
 *   elements that were partly visible (see measure in lib/page/actionability.js)
 *   renamed: action -> new name, for the ones that showed a different name
 *   depending on the state (see renameUnstableActions)
 *   labels: state -> action -> full readable name of the element IN that state
 *   (e.g. "flare/vis/operator"); lib/labels.js uses it to name the states by
 *   their place in the hierarchy
 *   effects: state -> hover action -> what changes (see describeEffect in lib/hovers.js)
 *   ignoredHovers: [{ action, reason, states }] hovers with a listener that are
 *   NOT an action (they do nothing visible, never settle, the page changes by itself...)
 */
async function crawl(opts) {
  const browser = await launchBrowser(opts.chromePath);
  try {
    return await runCrawl(browser, opts);
  } finally {
    await browser.close();
  }
}

/**
 * Two clean loads of the same page must give the same state: if they do not,
 * no crawling strategy can converge.
 * @param {CrawlContext['session']} session
 * @param {number|null} wait - settle time after each load
 * @throws {Error} when the two loads give different states
 */
async function checkStableStart(session, wait) {
  await session.initialLoad(wait);
  const first = await session.readState();
  await session.initialLoad(wait);
  if ((await session.readState()) !== first) {
    throw new Error(
      'the initial state is not stable between reloads (two clean loads of the same page gave ' +
      'different states) -- settleMs does not fix this. Run diagnose.js for more detail.'
    );
  }
}

/**
 * The page is standing in the initial state: a graph with only that one.
 * @returns {Promise<{graph: Map<string, Object>, initialState: string, current: string}>}
 */
async function startFresh(session) {
  const initialState = await session.readState();
  return { graph: new Map([[initialState, newNode()]]), initialState, current: initialState };
}

/**
 * A counter of the interactions of the crawl.
 * @returns {() => void} call it once per candidate tried; it throws when the total passes `maxSteps`
 */
function createStepCounter(maxSteps) {
  let steps = 0;
  return function countStep() {
    steps++;
    if (steps > maxSteps) {
      throw new Error(
        `maxSteps (${maxSteps}) exceeded -- probably an unstable state ` +
        `(the same state keeps coming back under a different key) or a genuinely huge graph.`
      );
    }
  };
}

/**
 * The crawl itself, on an open browser: checks the start is stable, expands the
 * initial state (which expands everything reachable, depth-first), then reads the
 * result off the graph. Options and result are those of crawl().
 * @param {import('playwright').Browser} browser
 */
async function runCrawl(browser, {
  fixtureUrl,
  containerSelector = null,
  clickableSelector = containerSelector ? `${containerSelector} [data-crawler-clickable]` : '[data-crawler-clickable]',
  hover = true,
  hoverableSelector = containerSelector ? `${containerSelector} [data-crawler-hoverable]` : '[data-crawler-hoverable]',
  maxDelegated = 50,
  stateKeyFn = (raw) => raw,
  initScripts = [],
  backSelector = null,
  settleMs = null,
  discoverySettleMs = null,
  maxStates = 1000,
  maxSteps = 20000,
  onStateExpanded = null,
  onLog = null,
}) {
  discoverySettleMs = discoverySettleMs ?? settleMs;
  const session = await createSession(browser, {
    fixtureUrl, initScripts, stateKeyFn, virtualTime: settleMs == null || discoverySettleMs == null,
  });
  const log = onLog || (() => {});

  await checkStableStart(session, discoverySettleMs);
  const { graph, initialState, current } = await startFresh(session);

  // Without instrument.js (manual state with window.__testState) there is no
  // way to see whether a hover changed anything, and without that a real hover
  // cannot be told from one that does nothing: better to probe none than to
  // invent them.
  if (hover && !(await session.hasEffectsSnapshot())) {
    hover = false;
    log('hover: without instrument.js there is no way to see what a hover changes; hovers are not probed');
  }

  // What every part of the crawl shares. `nav` owns the state the page is in.
  const ctx = {
    session,
    graph,
    nameFor: createNaming(),
    selectors: {
      click: clickableSelector,
      hover: hover ? hoverableSelector : null,
      container: containerSelector,
      css: hover, // stylesheet :hover rules
    },
    log,
    backSelector,
    settleMs,
    discoverySettleMs,
    maxStates,
    maxDelegated,
    onStateExpanded,
    countStep: createStepCounter(maxSteps),
  };
  ctx.nav = createNavigator({ session, graph, backSelector, current });
  ctx.probe = createHoverProbe(ctx);
  ctx.expand = (state) => expand(ctx, state);

  await ctx.expand(initialState);

  // states were discovered but not expanded: cut short by maxStates
  const truncated = [...graph.values()].some((n) => !n.expanded);
  const renamed = Object.fromEntries(renameUnstableActions(graph));
  const { transitions, visibility, labels, effects, ignoredHovers } = collectResult(graph);
  return { transitions, initialState, visibility, labels, effects, ignoredHovers, renamed, usedManualState: session.usedManualState, truncated };
}

module.exports = { crawl };
