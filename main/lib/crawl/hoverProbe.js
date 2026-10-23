/**
 * HOVER: besides clicks, elements that react to the pointer entering or
 * moving over them are probed, with a pointer simulated through events (like
 * the clicks, the browser's mouse is never moved). They are found through an
 * addEventListener (what D3's selection.on does), through a handler in a
 * property or an attribute, through a stylesheet :hover (the state is FORCED
 * through the DevTools protocol, see cssHoverSession.js), and through a
 * listener delegated on a container, probing the D3 marks inside it. A hover
 * enters the automaton only when it changes something visible: a hover that
 * does nothing, or that sits on something a user could not touch, is not an
 * interaction and is not invented. A highlight or a tooltip is one more action
 * of the same state (a loop) with its effect noted; a hover that opens
 * something or leaves a change leads to another state, with its unhover back.
 * Move-type hovers are probed at the center and at the edge, and a warning
 * says when the effect depends on where the pointer is. What a probe means is
 * decided in lib/hovers.js.
 *
 * Native browser tooltips (an SVG <title> child or a title="" attribute) are
 * deliberately NOT hover actions, and there is no option to count them. D3
 * has no tooltip code (7.9.0 never creates a <title>); the browser draws the
 * tooltip itself, with no listener and no DOM change, so no effect can ever
 * be observed. A hover that cannot be verified would be a phantom. The <title>
 * text is still used to NAME actions (see readableOf in lib/page/discovery.js).
 */

const { ERROR_STATE } = require('../constants');
const { sameJson } = require('../util');
const { unhoverOf } = require('../actions');
const { IGNORE_REASON, classifyProbe, describeEffect, selfKeyOf } = require('../hovers');
const { hover, unhover, gestureKey } = require('./gestures');
const { NO_SETTLE } = require('./settle');
const { selectorFor } = require('./naming');
const { newNode, ensureField } = require('./graph');

/**
 * @param {Object} ctx - the crawl's shared context (see crawler.js): session,
 *   graph, nav, nameFor, selectors, log, backSelector, settleMs, maxStates,
 *   maxDelegated, countStep and expand (a structural hover discovers a state
 *   that has to be expanded right away).
 * @returns {{ pageDrifts: Function, probeHover: Function, probeDelegated: Function }}
 */
function createHoverProbe(ctx) {
  const { session, graph, nav, nameFor, selectors, log, backSelector, settleMs, maxStates, maxDelegated, countStep } = ctx;
  let fastModeWarned = false; // the fast-mode warning, once
  let cssBlockedWarned = false;

  // `baseline`: the reference snapshot the page computes style changes against
  // (see __crawlerEffects); it is requested only with the one taken BEFORE a hover.
  const readEffects = (baseline = false) => session.page.evaluate((b) => window.__crawlerEffects(b), baseline);

  // The page's :hover rules: scanned after every load, before the reference snapshot.
  async function scanCss() {
    const blocked = await session.page.evaluate(() => { window.__crawlerScanCss(); return window.__crawlerCssBlocked || 0; });
    if (blocked > 0 && !cssBlockedWarned) {
      cssBlockedWarned = true;
      log(`hover: ${blocked} cross-origin stylesheet(s) cannot be read; their :hover rules are not seen`);
    }
  }

  // Does the page change by itself over time (a clock, a loose animation)? If
  // so there is no way to know whether what changed after a hover was caused by
  // the hover: all of them would look effective. It is checked by letting time
  // pass without touching anything.
  async function pageDrifts(state) {
    await nav.navigateTo(state, settleMs);
    await scanCss();
    const before = await readEffects(true);
    try {
      await session.settle(settleMs);
    } catch (e) {
      if (e.code === NO_SETTLE) return true;
      throw e;
    }
    return !sameJson(before, await readEffects());
  }

  // Puts the pointer over the element of `gesture` in `state`, looks at what
  // changed and takes it off. `where` = 'edge' aims away from the center.
  // Returns what was observed, or { problem } when the hover could not be done,
  // or { broke } when it threw an exception in the page.
  async function observeHover(state, gesture, found, where) {
    await nav.navigateTo(state, settleMs);
    // What is observed is compared with what was in `state`: if navigation did
    // not get there (fast mode does not verify it), the comparison is worthless.
    if ((await session.readState()) !== state) return { problem: IGNORE_REASON.navigationMissed };
    nav.current = state;
    await scanCss();
    const before = await readEffects(true);
    try {
      if ((await session.perform(gesture, settleMs, { where })) === false) return { problem: IGNORE_REASON.notInteractable };
      if (session.errors.length > 0) return { broke: true };
      const after = await readEffects();
      // With the pointer over it: the state key and what can be done, but only
      // if something changed (otherwise the hover is dropped and it is not needed).
      const changed = !sameJson(before, after);
      const hoveredKey = changed ? await session.readState() : null;
      const whileHovered = changed ? await session.discoverCandidates(selectors, nameFor) : [];
      // the snapshot key of the touched element (left by __crawlerEffects): lets a change be reported as "its own"
      const selfKey = changed ? await session.page.evaluate(() => window.__crawlerSelfKey || null) : null;
      await session.perform(unhover(gesture.sel), settleMs);
      if (session.errors.length > 0) return { broke: true };
      return { before, after, restored: await readEffects(), hoveredKey, whileHovered, selfKey };
    } catch (e) {
      if (e.code !== NO_SETTLE) throw e;
      return { problem: IGNORE_REASON.neverSettles };
    }
  }

  // observeHover, and for an element with move listeners (`info.moves`) whose
  // effect may depend on where the pointer is, a second observation away from
  // the center. `positional` says the two differ.
  async function observeAtPositions(state, gesture, found, info) {
    let seen = await observeHover(state, gesture, found);
    let positional = false;
    if (info.moves && !seen.problem && !seen.broke && sameJson(seen.before, seen.restored)) {
      const far = await observeHover(state, gesture, found, 'edge');
      if (far.broke) {
        seen = far;
      } else if (!far.problem) {
        const nearChanged = !sameJson(seen.before, seen.after);
        const farChanged = !sameJson(far.before, far.after);
        positional = nearChanged !== farChanged || (nearChanged && !sameJson(seen.after, far.after));
        if (!nearChanged && farChanged) seen = far; // the effect shows up at another point: the action exists
      }
    }
    return { seen, positional };
  }

  // What the hover did, as it goes into transitions.json.
  function effectOf(seen, verdict, positional, gesture, found) {
    const effect = describeEffect(seen.before, seen.after, seen.selfKey || selfKeyOf(gesture.sel));
    const namesOf = (gestureKeys) => [...found, ...seen.whileHovered]
      .filter(([, g]) => gestureKeys.includes(gestureKey(g))).map(([a]) => a);
    if (!verdict.reverted) effect.persistent = true;
    if (positional) effect.positional = true;
    if (verdict.revealed.length) effect.reveals = namesOf(verdict.revealed);
    if (verdict.hidden.length) effect.hides = namesOf(verdict.hidden);
    return effect;
  }

  // The hover opened something or left a change: it leads to another state, the
  // one with the pointer over it, with its way back. Returns 'effect' or 'problem'.
  async function recordStructural({ state, node, action, gesture, hoveredKey, verdict, effect, ignore }) {
    if (backSelector) {
      // fast mode navigates through the common ancestor: it cannot follow a hover that changes state
      ignore(IGNORE_REASON.structuralInFastMode);
      if (!fastModeWarned) {
        fastModeWarned = true;
        log(`hover: "${action}" changes what can be done, but fast mode (backSelector) cannot follow a hover that changes state; ` +
          'those are skipped (see hovers.ignored in transitions.json)');
      }
      nav.current = verdict.reverted ? state : null;
      return 'problem';
    }
    const leftKey = verdict.reverted ? state : await session.readState();
    node.transitions[action] = hoveredKey;
    node.gestures[action] = gesture;
    ensureField(node, 'effects')[action] = effect;
    nav.current = leftKey;

    // If taking the pointer off leaves the same key, the state is the same with
    // or without it (the hover left a change): there is no "state with the
    // pointer over it" and no way back to take; an unhover from a state to
    // itself would be a step a user cannot repeat.
    const withPointer = leftKey !== hoveredKey;
    let hovered = graph.get(hoveredKey);
    const isNew = !hovered;
    if (isNew) {
      hovered = newNode([...node.path, gesture]);
      if (withPointer) Object.assign(hovered, { pointer: gesture, enabled: verdict.revealed });
      graph.set(hoveredKey, hovered);
    }
    // The way back exists when that state is one with the pointer over it (if
    // the same look is reached by clicking, taking the pointer off does nothing).
    if (withPointer && hovered.pointer) {
      const back = unhoverOf(action);
      hovered.transitions[back] = leftKey;
      hovered.gestures[back] = unhover(gesture.sel);
    }
    const leftIsNew = leftKey !== state && !graph.has(leftKey);
    if (leftIsNew) graph.set(leftKey, newNode([...hovered.path, unhover(gesture.sel)]));
    if (isNew && graph.size <= maxStates) await ctx.expand(hoveredKey);
    if (leftIsNew && graph.size <= maxStates) await ctx.expand(leftKey);
    return 'effect';
  }

  // Probes the hover `gesture` in `state` and decides what it is (see lib/hovers.js):
  //  - if nothing visible changes it is NOT an action and is dropped;
  //  - if it is a highlight or a tooltip (what can be done does not change) it
  //    is one more action of the same state, with its effect noted;
  //  - if it opens something or leaves a change, it leads to another state, with
  //    its way back.
  // Except in that last case, the page is left with the pointer outside.
  // `info.moves`: the element has move listeners, whose effect may depend on
  // where the pointer is, so it is probed at the center and away from it.
  // `quiet`: do not note "no effect" (the marks of a delegated listener are
  // counted together on the container). Returns 'effect', 'inert' or 'problem'.
  async function probeHover(state, node, action, gesture, found, info = {}, { quiet = false } = {}) {
    const ignore = (reason) => {
      if (quiet && reason === IGNORE_REASON.noVisibleEffect) return;
      ensureField(node, 'inert')[action] = reason;
    };

    const { seen, positional } = await observeAtPositions(state, gesture, found, info);
    if (seen.problem) {
      ignore(seen.problem);
      nav.current = null;
      return 'problem';
    }
    if (seen.broke) {
      node.transitions[action] = ERROR_STATE;
      node.gestures[action] = gesture;
      nav.current = ERROR_STATE;
      return 'effect';
    }

    const { before, after, restored, hoveredKey, whileHovered } = seen;
    const keys = (list) => list.map(([, g]) => gestureKey(g));
    const verdict = classifyProbe({
      state, hoveredKey, before, after, restored, actionsBefore: keys(found), actionsHovered: keys(whileHovered),
    });
    if (verdict.type === 'inert') {
      ignore(IGNORE_REASON.noVisibleEffect);
      nav.current = verdict.reverted ? state : null;
      return 'inert';
    }

    const effect = effectOf(seen, verdict, positional, gesture, found);
    if (verdict.type === 'decorative') {
      node.transitions[action] = state;
      node.gestures[action] = gesture;
      ensureField(node, 'effects')[action] = effect;
      // if it did not revert, the key may be another one (the change only shows after leaving)
      nav.current = verdict.reverted ? state : await session.readState();
      return 'effect';
    }
    return recordStructural({ state, node, action, gesture, hoveredKey, verdict, effect, ignore });
  }

  // A DELEGATED listener (a single one, on a container, that looks at
  // event.target) does nothing when probed on the container itself: the target
  // is the container. For those, the D3 marks inside are probed (see
  // __crawlerMarks): the event starts at the mark and bubbles up to the
  // listener, with the mark's coordinates, so it works for handlers that read
  // event.target.__data__ as well as ones that look at the position.
  async function probeDelegated(state, node, found, containers) {
    for (const [action, gesture] of containers) {
      await nav.navigateTo(state, settleMs);
      const { marks, total } = await session.page.evaluate(([sel, limit]) => window.__crawlerMarks(sel, limit), [gesture.sel, maxDelegated]);
      if (marks.length === 0) continue;
      let probed = 0, effective = 0;
      for (const info of marks) {
        const markGesture = hover(selectorFor(info));
        const markAction = nameFor(info, markGesture);
        if (markAction in node.transitions) continue;
        ensureField(node, 'labels')[markAction] = { readable: info.readable, tag: info.tag };
        countStep();
        probed++;
        if ((await probeHover(state, node, markAction, markGesture, found, info, { quiet: true })) === 'effect') effective++;
      }
      node.inert[action] = `no effect of its own; ${probed}${total > probed ? ` of ${total}` : ''} inner elements probed (${effective} with an effect)`;
    }
  }

  return { pageDrifts, probeHover, probeDelegated };
}

module.exports = { createHoverProbe };
