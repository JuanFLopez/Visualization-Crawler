/**
 * Diagnosis and log text for a regex that was cut for size (see
 * dfaToRegexTrace in lib/regex): where state elimination blew up, and the
 * trace of how it got there.
 */

/**
 * Diagnosis of a regex that was cut for size: the step where it blew up, how
 * it had been growing, which states were left (the dense core), and how many
 * of the transitions inside that core are clicks on partially visible
 * elements, the typical reason a hierarchical graph becomes dense
 * (neighbouring circles peeking out of the corners of a zoom).
 * @param {{steps: Object[], remaining: string[]}} trace - from dfaToRegexTrace, aborted
 * @param {import('../automaton').DFA} dfa - the automaton the regex was being built from
 * @param {Object<string, Object<string, number>>} visibility - state -> action -> visible fraction
 * @param {number} maxLength - the limit that was exceeded
 * @returns {Object} the `explosion` entry of transitions.json for this regex
 */
function explosionInfo(trace, dfa, visibility, maxLength) {
  const steps = trace.steps;
  const last = steps[steps.length - 1];
  const growth = steps.slice(-12).map((s, i, arr) => {
    const prev = i > 0 ? arr[i - 1].totalSize : (steps[steps.length - arr.length - 1] || { totalSize: 0 }).totalSize;
    return { step: s.step, state: s.state, totalSize: s.totalSize, factor: prev > 0 ? +(s.totalSize / prev).toFixed(2) : null };
  });
  const core = new Set(trace.remaining);
  let coreTransitions = 0, corePartial = 0;
  for (const s of core) {
    for (const [a, to] of dfa.transitions.get(s) || []) {
      if (!core.has(to)) continue;
      coreTransitions++;
      if (visibility[s] && visibility[s][a] !== undefined) corePartial++;
    }
  }
  return {
    maxLength,
    abortedAtStep: last ? last.step : 0,
    totalSteps: dfa.states().length,
    sizeWhenAborted: last ? last.totalSize : null,
    growth,
    denseCore: trace.remaining,
    denseCoreTransitions: coreTransitions,
    denseCorePartiallyVisibleClicks: corePartial,
  };
}

/**
 * Log lines for an omitted regex.
 * @param {string} name - 'cycleCut', 'language' or 'completeInteractions'
 * @param {ReturnType<typeof explosionInfo>} info
 * @returns {string[]}
 */
function explosionLog(name, info) {
  const lines = [
    `regex "${name}" OMITTED: exceeded ${info.maxLength} characters at step ${info.abortedAtStep} of ${info.totalSteps} of the state elimination (${info.sizeWhenAborted} characters).`,
    '  growth over the last steps (eliminated state -> total size of the remaining edges):',
    ...info.growth.map((g) => `    step ${String(g.step).padStart(3)}  ${g.state.padEnd(36)} ${String(g.totalSize).padStart(10)}${g.factor ? `  (x${g.factor})` : ''}`),
  ];
  if (info.denseCore.length) {
    lines.push(`  dense core (states left uneliminated): ${info.denseCore.join(', ')}`);
    lines.push(`  ${info.denseCoreTransitions} transitions inside the core, ${info.denseCorePartiallyVisibleClicks} of them on partially visible elements`);
  }
  return lines;
}

/**
 * The whole state-elimination trace as a table (the --traceRegex option).
 * @param {string} name - which regex it belongs to
 * @param {{steps: Object[]}} trace - from dfaToRegexTrace
 * @returns {string[]}
 */
function traceLog(name, trace) {
  return [
    `state elimination trace (regex "${name}"):`,
    `  ${'step'.padStart(4)}  ${'state'.padEnd(36)} ${'in'.padStart(3)} x ${'out'.padEnd(3)} ${'loop'.padStart(7)}  ${'total size'.padStart(12)}`,
    ...trace.steps.map((s) => `  ${String(s.step).padStart(4)}  ${s.state.padEnd(36)} ${String(s.preds).padStart(3)} x ${String(s.succs).padEnd(3)} ${String(s.loopSize).padStart(7)}  ${String(s.totalSize).padStart(12)}`),
  ];
}

module.exports = { explosionInfo, explosionLog, traceLog };
