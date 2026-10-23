/**
 * Comparison of the observed automaton against an expected regex: which of the
 * four candidate automata it matches (or is closest to), and the sequences in
 * which they differ.
 */

const { prefixClosure, completeInteractionsDfa } = require('../automaton');
const { compileRegex, tokenize, literalsOf } = require('../regex');
const { diff } = require('../diff');
const { DEFAULT_KIND, actionName } = require('../actions');
const { AUTOMATON } = require('../constants');

/**
 * Lets the expected regex be written without the "Click_" prefix ("vis c31"
 * instead of "Click_vis Click_c31"): a token that is not in the alphabet but
 * is with the prefix gets completed.
 */
function normalizeExpected(src, alphabet) {
  const literals = literalsOf(src);
  const completed = {};
  const toks = tokenize(src).map((t) => {
    const full = actionName(DEFAULT_KIND, t);
    if (literals.has(t) && !alphabet.has(t) && alphabet.has(full)) {
      completed[t] = full;
      return full;
    }
    return t;
  });
  return { src: toks.join(' '), completed };
}

/**
 * The expected regex may describe the full automaton or the cut one (the one
 * the diagram shows), and each either as every realizable prefix or as
 * complete interactions: matching any of them exactly is enough. With
 * --regexPrefixes the expected one is already a prefix closure, and only makes
 * sense against "language".
 * @param {import('../automaton').DFA} expected - compiled from the expected regex
 * @returns {{automaton: string, form: 'language'|'completeInteractions', dfa: import('../automaton').DFA, diff: ReturnType<typeof diff>}[]}
 *   the four (or two) candidates, in the order that breaks ties: cut before full, interactions before language
 */
function diffAgainstTargets(expected, { dfa, cut, prefixes, limit }) {
  const forms = prefixes ? ['language'] : ['completeInteractions', 'language'];
  const rankLimit = Math.max(limit, 50);
  const targets = [];
  for (const [automaton, base] of [[AUTOMATON.cut, cut], [AUTOMATON.full, dfa]]) {
    for (const form of forms) {
      const tdfa = form === 'language' ? base : completeInteractionsDfa(base);
      targets.push({ automaton, form, dfa: tdfa, diff: diff(tdfa, expected, { limit: rankLimit }) });
    }
  }
  return targets;
}

// how a candidate automaton is named in the log: "cut automaton · complete interactions"
const targetName = (t) => `${t.automaton} automaton · ${t.form === 'language' ? 'language (every prefix)' : 'complete interactions'}`;

/** The log lines of a comparison: one row per candidate automaton, the verdict, and the warnings about unknown or unused symbols. */
function comparisonLog({ mode, targets, matched, target, reported, limit, unknownSymbols, unusedSymbols }) {
  const count = (t, list) => `${list.length}${t.diff.truncated ? '+' : ''}`;
  const log = ['', `=== COMPARISON with the expected regex (${mode}) ===`];
  for (const t of targets) {
    log.push(`  ${targetName(t).padEnd(46)} ${t.diff.equivalent ? 'EQUIVALENT' : `DIFFERENT (${count(t, t.diff.onlyInA)} / ${count(t, t.diff.onlyInB)})`}`);
  }
  log.push('    (in parentheses: sequences the crawler allows and the regex does not / the regex allows and the crawler does not)');
  if (matched) {
    log.push(`RESULT: EQUIVALENT (matches the ${targetName(matched)})`);
  } else {
    log.push(`RESULT: DIFFERENT -- unexpected behaviors relative to the closest one: ${targetName(target)}`);
    if (reported.truncated) log.push(`  (at most ${limit} per direction are considered, the shortest ones)`);
  }
  if (unknownSymbols.length) log.push(`  WARNING: the regex uses symbols the crawler never saw (typo?): ${unknownSymbols.join(', ')}`);
  if (unusedSymbols.length) log.push(`  observed actions the regex does not mention: ${unusedSymbols.join(', ')}`);
  return log;
}

/**
 * @param {Object} p
 * @param {import('../automaton').DFA} p.dfa - observed automaton (full, uncut)
 * @param {import('../automaton').DFA} p.cut - the same with only its tree and back transitions
 * @returns {{
 *   comparison: Object,      // the `comparison` section of transitions.json
 *   log: string[],
 *   expected: import('../automaton').DFA,
 *   reported: {equivalent: boolean, onlyInA: string[][], onlyInB: string[][], truncated: boolean}, // differences against `target`, capped at `limit`
 *   target: Object,          // the candidate automaton it matched, or the closest one
 *   matchedName: string|null // short name of the matched candidate, null when none matched
 * }}
 */
function compareWithExpected({ expectedRegex, prefixes, limit, dfa, cut }) {
  const { src, completed } = normalizeExpected(expectedRegex, dfa.alphabet);
  let expected = compileRegex(src, dfa.alphabet);
  if (prefixes) expected = prefixClosure(expected);

  const targets = diffAgainstTargets(expected, { dfa, cut, prefixes, limit });
  // The closest one: fewest differences; on a tie the order above wins (cut
  // before full, interactions before language).
  const size = (t) => t.diff.onlyInA.length + t.diff.onlyInB.length;
  const matched = targets.find((t) => t.diff.equivalent) || null;
  const target = matched || targets.reduce((best, t) => (size(t) < size(best) ? t : best));
  const reported = {
    equivalent: target.diff.equivalent,
    onlyInA: target.diff.onlyInA.slice(0, limit),
    onlyInB: target.diff.onlyInB.slice(0, limit),
    truncated: target.diff.truncated || target.diff.onlyInA.length > limit || target.diff.onlyInB.length > limit,
  };

  const usedSymbols = literalsOf(src);
  const unknownSymbols = [...usedSymbols].filter((s) => !dfa.alphabet.has(s));
  const usesWildcard = tokenize(src).includes('.');
  const unusedSymbols = usesWildcard ? [] : [...dfa.alphabet].filter((s) => !usedSymbols.has(s));
  const fmt = (seq) => (seq.length ? seq.join(' ') : '() (empty sequence)');

  const mode = prefixes ? 'prefixes of the expected regex' : 'standard semantics (complete sequences)';
  const comparison = {
    expected: expectedRegex,
    mode,
    equivalent: !!matched,
    matched: matched && { automaton: matched.automaton, form: matched.form },
    targets: targets.map((t) => ({
      automaton: t.automaton, form: t.form, equivalent: t.diff.equivalent,
      onlyInCrawler: t.diff.onlyInA.length, onlyInExpected: t.diff.onlyInB.length, truncated: t.diff.truncated,
    })),
    reportedAgainst: { automaton: target.automaton, form: target.form },
    onlyInCrawler: reported.onlyInA.map(fmt),
    onlyInExpected: reported.onlyInB.map(fmt),
    truncated: reported.truncated,
    unknownSymbols,
    symbolsNotInExpected: unusedSymbols,
  };
  if (Object.keys(completed).length) comparison.completedTokens = completed;

  const matchedName = matched && `${matched.automaton} automaton · ${matched.form === 'language' ? 'language' : 'complete interactions'}`;
  const log = comparisonLog({ mode, targets, matched, target, reported, limit, unknownSymbols, unusedSymbols });
  return { comparison, log, expected, reported, target, matchedName };
}

module.exports = { compareWithExpected };
