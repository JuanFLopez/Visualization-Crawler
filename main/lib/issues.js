/**
 * Unexpected behaviors, rebuilt as SERIES OF EVENTS over the observed
 * automaton: from the initial state, what was clicked in each state, where it
 * led and at which step something did not go as expected.
 *
 * Three origins (the `kind` of each issue, see KIND):
 *   - error:      a click broke the page (a transition to __ERROR__). Always
 *                 reported, with or without an expected regex, together with
 *                 the shortest path that reproduces it.
 *   - unexpected: the visualization allows a sequence the expected regex does
 *                 not admit (onlyInA of lib/diff.js).
 *   - missing:    the expected regex admits a sequence the visualization does
 *                 not allow (onlyInB): at some step the click is not
 *                 available, or it breaks the page.
 *
 * Several counterexamples that fail in the same place (same state, same
 * action) are the same problem: they are grouped and the shortest series is
 * shown (diff is BFS, so that is the first one).
 *
 * @typedef {Object} IssueEvent one step of a series of events
 * @property {number} step - 1-based
 * @property {string} state - the state the action was performed in
 * @property {string} action
 * @property {string|null} to - the next state; null when the action was not offered, __ERROR__ when it broke the page
 * @property {'tree'|'back'|'shortcut'|null} edge - see lib/cycles.js
 */

const { ERROR_STATE, AUTOMATON } = require('./constants');
const { displayAction, shortAction, verbOf } = require('./actions');
const { compositeKey } = require('./util');

/** The `kind` of an issue in transitions.json. */
const KIND = { error: 'error', missing: 'missing', unexpected: 'unexpected' };

/** Why a replayed sequence stops: the action is not offered in that state, or it breaks the page. */
const STOP = { notAvailable: 'notAvailable', error: 'error' };

/** Why a `missing` issue exists although the visualization does allow the sequence. */
const GAP = { shortcut: 'shortcut', notReturned: 'notReturned' };

const HEADLINE = 'Unexpected behavior occurs when this series of events happens';
const NO_EVENTS = '(none: do nothing)';

/**
 * Walks `seq` over the observed automaton.
 * @param {import('./automaton').DFA} dfa
 * @param {string[]} seq - actions, from the initial state
 * @param {ReturnType<import('./cycles').classifyEdges>} cls - to tell back edges and shortcuts apart
 * @returns {{ events: IssueEvent[], failure: null | {step: number, state: string, action: string, reason: 'notAvailable'|'error'} }}
 *   events includes the failing step (to: null when the click was not there, __ERROR__ when it broke the page)
 */
function replay(dfa, seq, cls) {
  const events = [];
  let cur = dfa.initial;
  for (let i = 0; i < seq.length; i++) {
    const action = seq[i];
    const next = dfa.step(cur, action);
    const event = { step: i + 1, state: cur, action, to: next, edge: next === null ? null : cls.kindOf(cur, action) };
    events.push(event);
    if (next === null || next === ERROR_STATE) {
      return { events, failure: { step: i + 1, state: cur, action, reason: next === null ? STOP.notAvailable : STOP.error } };
    }
    cur = next;
  }
  return { events, failure: null };
}

/**
 * First step (1-based) at which the expected regex stops admitting the sequence, or null if it admits it to the end.
 * @param {import('./automaton').DFA} expected
 */
function expectedDivergence(expected, seq) {
  let cur = expected.initial;
  for (let i = 0; i < seq.length; i++) {
    cur = cur === null ? null : expected.step(cur, seq[i]);
    if (cur === null) return i + 1;
  }
  return null;
}

// shortest path (in clicks) from the initial state to `target`, read off a dfa.bfs() tree
function shortestPath(tree, target) {
  if (!tree.depth.has(target)) return null;
  const path = [];
  for (let c = target; tree.parent.has(c); c = tree.parent.get(c)) path.unshift(tree.via.get(c));
  return path;
}

/**
 * The sentence that explains why a series of events is an issue. `incomplete`: the series ends in a state the
 * expected regex does not accept as finished; `alsoExpected`: an `error` the expected regex admits;
 * `reason` (see GAP) and `form` ('language' or 'completeInteractions') refine the wording.
 * @param {string} kind - see KIND
 * @param {IssueEvent|{action: string, state: string}} event - the failing step
 */
function describe(kind, failingStep, event, { incomplete = false, alsoExpected = false, reason = null, form = 'language' } = {}) {
  const a = `"${shortAction(event.action)}"`; // with the verb in front ("hover") the prefix is redundant
  const verb = verbOf(event.action);
  if (kind === KIND.error) {
    return `the page throws an exception on ${verb} ${a} in "${event.state}" (step ${failingStep})` +
      (alsoExpected ? '; the expected regex admits this sequence' : '');
  }
  if (kind === KIND.missing) {
    if (reason === GAP.shortcut) {
      return `the expected regex uses the shortcut ${a} at step ${failingStep}; it exists in the visualization but not in the automaton with cycles cut`;
    }
    if (reason === GAP.notReturned) {
      return `the expected regex considers the interaction finished at "${event.to}", but from there the visualization has not yet returned to the initial state`;
    }
    return `the expected regex admits ${verb} ${a} at step ${failingStep}, but in "${event.state}" the visualization does not offer it`;
  }
  if (incomplete) {
    return form === 'completeInteractions'
      ? 'the series returns to the initial state (a complete interaction), but the expected regex does not accept it'
      : 'the visualization allows ending here, but the expected regex does not accept the sequence as complete' +
        ' (if the regex describes complete interactions, compare with --regexPrefixes)';
  }
  return `the visualization allows ${verb} ${a} in "${event.state}" (step ${failingStep}), but the expected regex does not admit it`;
}

/**
 * @param {Object} p
 * @param {import('./automaton').DFA} p.dfa - observed automaton (full, uncut)
 * @param {ReturnType<import('./cycles').classifyEdges>} p.cls
 * @param {import('./automaton').DFA} [p.expected] - DFA of the expected regex (already prefix-closed when it applies)
 * @param {{onlyInA: string[][], onlyInB: string[][]}} [p.diff] - against `target`
 * @param {{automaton: 'full'|'cut', form: 'language'|'completeInteractions'}} [p.target] - what it was compared
 *   against; the events are rebuilt over `dfa` (the full one) either way
 * @returns {{kind: string, message: string, detail: string, sequence: string[], events: IssueEvent[], failingStep: number, occurrences: number}[]}
 *   errors first, then missing, then unexpected; shortest series first within each
 */
function buildIssues({ dfa, cls, expected = null, diff = null, target = null }) {
  target = target || { automaton: AUTOMATON.full, form: 'language' };
  const byKey = new Map();
  const add = (key, issue) => {
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...issue, occurrences: 1 }); return; }
    prev.occurrences++;
    if (issue.sequence.length < prev.sequence.length) Object.assign(prev, { ...issue, occurrences: prev.occurrences });
  };

  const tree = dfa.bfs({ skip: [ERROR_STATE] });
  for (const [state, m] of dfa.transitions) {
    for (const [action, to] of m) {
      if (to !== ERROR_STATE) continue;
      const path = shortestPath(tree, state);
      if (!path) continue;
      const seq = [...path, action];
      const { events, failure } = replay(dfa, seq, cls);
      add(compositeKey(KIND.error, state, action), { kind: KIND.error, sequence: seq, events, failingStep: failure.step });
    }
  }

  if (diff) {
    for (const seq of diff.onlyInB) {
      const { events, failure } = replay(dfa, seq, cls);
      if (!failure) {
        // The visualization does allow it: the difference belongs to the
        // automaton it was compared against (a shortcut the cut one lacks,
        // or an interaction the regex considers complete without having
        // returned).
        const shortcut = target.automaton === AUTOMATON.cut ? events.find((e) => e.edge === 'shortcut') : null;
        if (shortcut) {
          add(compositeKey(KIND.missing, shortcut.state, shortcut.action), { kind: KIND.missing, sequence: seq, events, failingStep: shortcut.step, reason: GAP.shortcut });
        } else if (events.length) {
          const last = events[events.length - 1];
          add(compositeKey(KIND.missing, last.to, ''), { kind: KIND.missing, sequence: seq, events, failingStep: last.step, reason: GAP.notReturned });
        }
        continue;
      }
      const kind = failure.reason === STOP.error ? KIND.error : KIND.missing;
      const key = compositeKey(kind, failure.state, failure.action);
      if (kind === KIND.error && byKey.has(key)) { byKey.get(key).alsoExpected = true; continue; }
      add(key, { kind, sequence: seq, events, failingStep: failure.step, alsoExpected: kind === KIND.error });
    }
    for (const seq of diff.onlyInA) {
      const { events } = replay(dfa, seq, cls);
      const step = expectedDivergence(expected, seq);
      const incomplete = step === null;
      const failingStep = incomplete ? seq.length : step;
      const at = incomplete ? (events.length ? events[events.length - 1].to : dfa.initial) : events[step - 1].state;
      const key = compositeKey(KIND.unexpected, at, incomplete ? '' : seq[step - 1]);
      add(key, { kind: KIND.unexpected, sequence: seq, events, failingStep, incomplete });
    }
  }

  const order = { [KIND.error]: 0, [KIND.missing]: 1, [KIND.unexpected]: 2 };
  return [...byKey.values()]
    .sort((a, b) => order[a.kind] - order[b.kind] || a.sequence.length - b.sequence.length)
    .map(({ kind, sequence, events, failingStep, occurrences, incomplete, alsoExpected, reason }) => {
      const failing = events[failingStep - 1];
      const opts = { incomplete, alsoExpected, reason, form: target.form };
      const detail = failing
        ? describe(kind, failingStep, failing, opts)
        : describe(kind, 0, { action: '', state: dfa.initial }, { ...opts, incomplete: true });
      const series = sequence.length ? sequence.map(displayAction).join(' → ') : NO_EVENTS;
      return { kind, message: `${HEADLINE}: ${series}`, detail, sequence, events, failingStep, occurrences };
    });
}

/** One line of the log for a step: "2. in "root": click "B" -> "root > B"   (goes back: closes a cycle)". */
function eventLine(e, failingStep) {
  const head = `${e.step}. in "${e.state}": ${verbOf(e.action)} "${shortAction(e.action)}"`;
  let tail;
  if (e.to === null) tail = '-> not available in this state';
  else if (e.to === ERROR_STATE) tail = '-> ERROR: the page threw an exception';
  else tail = `-> "${e.to}"`;
  const notes = [];
  if (e.edge === 'back') notes.push('goes back: closes a cycle');
  if (e.edge === 'shortcut') notes.push('shortcut: not in the regex with cycles cut');
  if (e.step === failingStep) notes.push('<-- here');
  return `${head} ${tail}${notes.length ? `   (${notes.join('; ')})` : ''}`;
}

/**
 * Log lines for a list of issues from buildIssues().
 * @param {ReturnType<typeof buildIssues>} issues
 * @returns {string[]} empty when there are no issues
 */
function issuesLog(issues) {
  if (!issues.length) return [];
  const lines = [`=== UNEXPECTED BEHAVIOR (${issues.length}) ===`];
  issues.forEach((issue, i) => {
    lines.push(`[${i + 1}] ${HEADLINE}:`);
    if (!issue.events.length) lines.push(`      ${NO_EVENTS}`);
    issue.events.forEach((e) => lines.push(`      ${eventLine(e, issue.failingStep)}`));
    lines.push(`    ${issue.detail}${issue.occurrences > 1 ? ` (${issue.occurrences} counterexamples fail at this same place)` : ''}`);
  });
  return lines;
}

module.exports = { KIND, buildIssues, issuesLog };
