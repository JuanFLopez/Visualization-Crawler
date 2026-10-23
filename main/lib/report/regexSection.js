/**
 * The `regex` section of transitions.json: the regex with cycles cut (the one
 * the diagram shows) and the two exact ones, plus the notices for any that
 * were omitted for size.
 */

const { completeInteractionsDfa } = require('../automaton');
const { dfaToRegexTrace } = require('../regex');
const { ERROR_STATE } = require('../constants');
const { verbOf } = require('../actions');
const { explosionInfo, explosionLog, traceLog } = require('./explosion');

/**
 * Regex of the "complete" interactions: the ones that end back at the initial
 * state (or in a state from which there is no way back). Every valid sequence
 * is a prefix of one of these. It is usually much shorter and more readable
 * than the exact language, which also has to describe every half-done
 * interaction.
 * @param {import('../automaton').DFA} dfa
 * @param {number} maxLength - the regex is omitted (null) beyond this many characters
 * @returns {{trace: ReturnType<typeof dfaToRegexTrace>, stronglyConnected: boolean}}
 *   stronglyConnected: every state can get back to the initial one, so the only complete interactions end there
 */
function completeInteractionsRegex(dfa, maxLength) {
  const loops = completeInteractionsDfa(dfa);
  return { trace: dfaToRegexTrace(loops, { exclude: [ERROR_STATE], maxLength }), stronglyConnected: loops.accepting.size === 1 };
}

/** The notice that replaces a regex omitted for size (regex.*Omitted in transitions.json). */
function omittedText(info) {
  return `omitted: the regex exceeds ${info.maxLength} characters (it grows exponentially when eliminating the states ` +
    `of the dense core: ${info.denseCore.join(', ') || '(all)'}). The transition table and the comparison ` +
    'against an expected regex are not affected. See regex.explosion in transitions.json.';
}

/**
 * @param {Object} p
 * @param {import('../automaton').DFA} p.dfa - observed automaton (full, uncut)
 * @param {import('../automaton').DFA} p.cut - the same with only its tree and back transitions
 * @param {ReturnType<import('../cycles').classifyEdges>} p.cls
 * @param {Object} p.visibility - state -> action -> visible fraction (for the explosion diagnosis)
 * @returns {{ regex: Object, log: string[], cycleCutRegex: string|null, completeRegex: string|null }}
 */
function buildRegexSection({ dfa, cut, cls, visibility, maxRegexLength, traceRegex }) {
  const hasPointer = [...dfa.alphabet].some((a) => verbOf(a) !== 'click');
  const cycleCut = completeInteractionsRegex(cut, maxRegexLength);
  const exactTrace = dfaToRegexTrace(dfa, { exclude: [ERROR_STATE], maxLength: maxRegexLength });
  const complete = completeInteractionsRegex(dfa, maxRegexLength);

  const regex = {
    syntax: 'tokens separated by spaces; | union, * + ? {n,m} repetition, ( ) grouping, () empty string',
    cycleCut: cycleCut.trace.regex,
    cycleCutMeaning: 'complete interactions with the cycles cut: going down the hierarchy and back up (zoom out, back, background); '
      + 'shortcuts (jumps to a state of another branch) are not expanded in the regex and are listed in regex.cycles.shortcutTransitions',
    cycles: {
      meaning: 'spanning tree from the initial state (by hierarchical name when there is one, otherwise by BFS): '
        + 'tree = from parent to child, back = to an ancestor (closes a cycle), shortcut = to another branch',
      tree: cls.counts.tree,
      back: cls.counts.back,
      shortcuts: cls.counts.shortcut,
      shortcutTransitions: cls.shortcuts,
    },
    language: exactTrace.regex,
    languageMeaning: `standard semantics: matches EXACTLY the sequences of ${hasPointer ? 'interactions (clicks and hovers)' : 'clicks'} that can be performed from the initial state (without the ones that break the page)`,
    completeInteractions: complete.trace.regex,
    completeInteractionsMeaning: complete.stronglyConnected
      ? 'sequences that return to the initial state; every performable sequence is a prefix of one of these'
      : 'sequences that return to the initial state or end in a state from which there is no way back; every performable sequence is a prefix of one of these',
  };

  const log = [];
  const explosion = {};
  for (const [name, trace, source] of [['cycleCut', cycleCut.trace, cut], ['language', exactTrace, dfa], ['completeInteractions', complete.trace, dfa]]) {
    if (traceRegex) log.push('', ...traceLog(name, trace));
    if (!trace.aborted) continue;
    explosion[name] = explosionInfo(trace, source, visibility, maxRegexLength);
    regex[`${name}Omitted`] = omittedText(explosion[name]);
    log.push('', ...explosionLog(name, explosion[name]));
  }
  if (Object.keys(explosion).length) regex.explosion = explosion;

  return { regex, log, cycleCutRegex: regex.cycleCut, completeRegex: regex.completeInteractions };
}

module.exports = { buildRegexSection };
