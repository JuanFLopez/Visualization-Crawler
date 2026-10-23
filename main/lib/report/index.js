/**
 * Everything built AFTER the crawl, from the transition table: clean names,
 * the regex with cycles cut (and the exact ones), the comparison against an
 * expected regex (optional), the unexpected behaviors as series of events,
 * and the diagram. run.js uses it both at the end of a crawl and on an
 * already generated transitions.json.
 *
 * The sections of transitions.json live in their own modules (regexSection,
 * comparison); this one puts them together, in the order the file lists them.
 *
 * transitions.json (the `json` that buildReport returns), by key and in this order:
 *   initialState            the state the page starts in
 *   transitions             { state: { action: next state } }; a click that breaks the page leads to "__ERROR__"
 *   regex                   cycleCut (what the diagram shows), language and completeInteractions (the exact
 *                           ones), each null when omitted for size, plus cycles (tree / back / shortcut counts
 *                           and the shortcut transitions), each with its *Meaning text; explosion when one was omitted
 *   visibility?             { state: { action: fraction } } for clicks on partly visible elements
 *   partiallyVisibleClicks? the same, as a list sorted from the least visible
 *   hovers?                 hover actions with their observed effect, and the hovers that are not actions
 *   comparison?             only when an expected regex was given: which automata it matched, the differences
 *   issues                  unexpected behaviors as series of events (always present, maybe empty)
 * The text fields (*Meaning, messages, effects) are English prose; everything else is data.
 */

const { fromTransitionsJson } = require('../automaton');
const { toSVG } = require('../diagram/svg');
const { classifyEdges, cutDfa } = require('../cycles');
const { buildIssues, issuesLog } = require('../issues');
const { summarizeHovers, hoverNotes, hoverLines } = require('../hovers');
const { buildRegexSection } = require('./regexSection');
const { compareWithExpected } = require('./comparison');

// Default maxRegexLength: the flare icicle (252 states) gives ~87,000
// characters; above this the regex can no longer be read, and in a dense
// graph the next eliminated state multiplies it.
const DEFAULT_MAX_REGEX_LENGTH = 500000;

/**
 * The `partiallyVisibleClicks` section and its log lines: the transitions whose
 * clicked element was only partly visible when it was discovered (see
 * visibleFrac in lib/page/actionability.js), from the least visible to the most.
 * @param {Object<string, Object<string, string>>} transitions
 * @param {Object<string, Object<string, number>>} visibility - state -> action -> visible fraction
 * @returns {{json: Object, log: string[]}|null} null when every click was fully visible
 */
function partiallyVisibleSection(transitions, visibility) {
  const partial = [];
  for (const [state, byAction] of Object.entries(visibility)) {
    for (const [action, visible] of Object.entries(byAction)) {
      const to = transitions[state] && transitions[state][action];
      if (to !== undefined) partial.push({ state, action, to, visible });
    }
  }
  if (!partial.length) return null;
  partial.sort((a, b) => a.visible - b.visible);
  const nTransitions = Object.values(transitions).reduce((n, t) => n + Object.keys(t).length, 0);
  return {
    json: {
      meaning: 'transitions whose element was only partly visible when it was clicked (visible: approximate fraction of its area)',
      count: partial.length,
      ofTransitions: nTransitions,
      transitions: partial,
    },
    // ≈: measured with a 5x5 grid of points; 0 = no point fell in the visible part
    log: ['', `${partial.length} of ${nTransitions} transitions click elements that are only partly visible; the least visible ones:`,
      ...partial.slice(0, 5).map((p) => `    ${p.state} --${p.action}--> ${p.to}  (≈${Math.round(p.visible * 100)}% visible)`)],
  };
}

// Footer blocks of the diagram: the text under the graph, each { title, text, color? }.

/** The cut regex, or the notice that it was omitted for size (in amber). */
function cycleCutBlock(cycleCutRegex, omittedNotice, shortcuts) {
  return {
    title: `Regex with the cycles cut (complete interactions; ${shortcuts} shortcuts listed apart, see regex.cycles in transitions.json)`,
    text: cycleCutRegex ?? omittedNotice,
    color: cycleCutRegex == null ? '#a15c00' : undefined,
  };
}

/** The hover summary: one line per group of actions with the same effect. */
function hoverBlock(hovers) {
  const n = hovers.transient + hovers.structural + (hovers.broken || 0);
  return {
    title: `Hover (${n} ${n === 1 ? 'action with a visible effect' : 'actions with a visible effect'})`,
    text: hoverLines(hovers).join('\n'),
  };
}

/** The first issues (at most 6) in red, with what the expected regex was compared against. */
function issuesBlock(issues, { expectedRegex, matchedName, target }) {
  const shown = issues.slice(0, 6).map((i) => `${i.message}\n    ${i.detail}`);
  if (issues.length > shown.length) shown.push(`(and ${issues.length - shown.length} more in transitions.json)`);
  const against = expectedRegex && !matchedName ? ` (compared with: ${expectedRegex}, against the ${target.automaton} automaton)` : '';
  return { title: `Unexpected behavior${against}   (in red: the first series of events)`, text: shown.join('\n'), color: '#c33' };
}

/**
 * @param {{initialState: string, transitions: Object}} data - table as the crawler leaves it
 * @param {Object} [opts]
 * @param {string} [opts.expectedRegex] - regex to compare with what was observed
 * @param {boolean} [opts.prefixes=false] - compare against the PREFIXES of what
 *   expectedRegex describes (useful when the regex describes complete interactions)
 * @param {number} [opts.limit=10] - counterexamples to report per direction
 * @param {number} [opts.maxRegexLength=500000] - a longer regex is omitted
 *   (null in the JSON) and where it blew up is reported; Infinity = no limit
 * @param {boolean} [opts.traceRegex=false] - log the full state-elimination
 *   trace, even when nothing was cut
 * @returns {{ json: Object, svg: string, log: string[] }} json: the transitions.json described above;
 *   svg: the diagram (automaton.svg); log: the lines run.js prints, in order
 */
function buildReport(data, { expectedRegex = null, prefixes = false, limit = 10, maxRegexLength = DEFAULT_MAX_REGEX_LENGTH, traceRegex = false } = {}) {
  const log = [];
  const dfa = fromTransitionsJson(data);
  const visibility = data.visibility || {};
  const cls = classifyEdges(dfa);
  const cut = cutDfa(dfa, cls);

  const regexSection = buildRegexSection({ dfa, cut, cls, visibility, maxRegexLength, traceRegex });
  const { cycleCutRegex, completeRegex } = regexSection;
  const json = { initialState: data.initialState, transitions: data.transitions, regex: regexSection.regex };
  log.push(...regexSection.log);

  if (Object.keys(visibility).length) json.visibility = visibility;
  const partial = partiallyVisibleSection(data.transitions, visibility);
  if (partial) {
    json.partiallyVisibleClicks = partial.json;
    log.push(...partial.log);
  }

  // Hovers: the ones that change something visible are actions (a loop of the
  // state, or a state of their own when they open something); the rest are
  // listed apart as what is NOT an action. In --from mode they arrive already
  // summarized.
  const hovers = data.hovers || summarizeHovers({
    transitions: data.transitions,
    effects: data.effects || {},
    ignored: data.ignoredHovers || [],
  });
  if (hovers) {
    json.hovers = hovers;
    log.push('', `hover: ${hovers.transient} transient (a loop on the state), ${hovers.structural} structural (change state)${hovers.broken ? `, ${hovers.broken} that break the page` : ''}`,
      ...hoverLines(hovers).map((l) => `    ${l}`));
  }

  log.push('', `cycles: ${cls.counts.back} transitions go back to an ancestor (close a cycle), ${cls.counts.shortcut} are shortcuts to another branch`
    + ` -- the regex with cycles cut has ${cycleCutRegex == null ? 'OMITTED' : `${cycleCutRegex.length} characters`}`
    + ` (exact: ${completeRegex == null ? 'OMITTED' : `${completeRegex.length} characters`})`);

  // the diagram shows only the cut regex; the exact ones stay in the JSON
  const footer = [cycleCutBlock(cycleCutRegex, json.regex.cycleCutOmitted, cls.counts.shortcut)];
  if (hovers) footer.push(hoverBlock(hovers));

  let comparison = null;
  if (expectedRegex) {
    comparison = compareWithExpected({ expectedRegex, prefixes, limit, dfa, cut });
    json.comparison = comparison.comparison;
    log.push(...comparison.log);
  }

  // Events are always rebuilt over the FULL automaton (what really happens in
  // the visualization), even when the comparison was against the cut one.
  const issues = buildIssues({
    dfa, cls, expected: comparison && comparison.expected, diff: comparison && comparison.reported, target: comparison && comparison.target,
  });
  json.issues = issues;
  if (issues.length) log.push('', ...issuesLog(issues));
  else if (expectedRegex) log.push('', 'no unexpected behaviors.');

  const matchedName = comparison && comparison.matchedName;
  if (issues.length) footer.unshift(issuesBlock(issues, { expectedRegex, matchedName, target: comparison && comparison.target }));
  if (matchedName) footer.unshift({ title: `Comparison with: ${expectedRegex}`, text: `EQUIVALENT (${matchedName})`, color: '#1a7f37' });

  const highlightPath = issues.length ? issues[0].sequence : [];
  const svg = toSVG(dfa, { footer, highlightPath, notes: hoverNotes(hovers) });
  return { json, svg, log };
}

module.exports = { buildReport };
