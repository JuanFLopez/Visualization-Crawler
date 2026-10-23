/**
 * Entry point of the crawler. Two ways to use it:
 *
 *  - As a MODULE (meant for a GUI): `const { run } = require('./run')` and
 *    `await run({ vizDir, regex, onLog, onProgress })`. It writes nothing to
 *    the console and does not end the process: it reports through callbacks,
 *    returns a structured result and throws an Error on a problem.
 *
 *  - From the COMMAND LINE: `node run.js <folder> [options]` (see usage()).
 *    It is a thin wrapper around run().
 *
 * Either way there are two source modes:
 *   - crawl:       the visualization is explored (a folder with index.html).
 *   - transitions: an already generated transitions.json is re-analyzed
 *                  without opening the browser (to compare against another
 *                  regex, or to regenerate the diagram).
 * and the comparison against an expected regex is optional in both.
 *
 * The pipeline:
 *   crawl (crawler.js, in a headless browser)  ->  readable state names (lib/labels.js)
 *     ->  report (lib/report: regexes, comparison, issues, diagram)  ->  transitions.json + automaton.svg
 * In transitions mode the first two steps are skipped: the table is read from
 * the file instead.
 *
 * Per-visualization configuration: a `config.js` next to the visualization's
 * index.html may export an object with crawl options (see CRAWLER_OPTIONS and
 * "Configuration" in the README). The `crawler` option of run() and the
 * matching command-line flags override it.
 *
 * Exit codes of the command line: 0 ok (or the expected regex matched),
 * 1 error, 2 the expected regex differs from what was observed or some click
 * breaks the page.
 */
const fs = require('fs');
const path = require('path');
const { crawl } = require('./crawler');
const { ERROR_STATE } = require('./lib/constants');
const { startServer, resolveChromePath } = require('./lib/host');
const { prettifyStates } = require('./lib/labels');
const { buildReport } = require('./lib/report');
const { KIND } = require('./lib/issues');
const { compileRegex } = require('./lib/regex/compile');

// Crawler options that can come from the visualization's config.js and be overridden on top of it:
//   settleMs            fixed real-time pause after every gesture (default: virtual time)
//   discoverySettleMs   the same, before listing the candidates of a newly visited state
//   maxStates           states to discover before stopping (the result is then marked incomplete)
//   maxSteps            hard cap on interactions, a safety net against an unstable state key
//   containerSelector   CSS selector: restrict detection and state to this container
//   backSelector        CSS selector of an element that goes "up one level": enables fast navigation
//   clickableSelector   what counts as clickable (default: what instrument.js marked)
//   hoverableSelector   what counts as hoverable (default: what instrument.js marked)
//   hover               false to probe clicks only
//   maxDelegated        cap on the D3 marks probed per delegated listener (0 = none)
// A config.js may also export any other option of crawl(), for example stateKeyFn.
const CRAWLER_OPTIONS = ['settleMs', 'discoverySettleMs', 'maxStates', 'maxSteps', 'containerSelector', 'backSelector', 'clickableSelector', 'hover', 'hoverableSelector', 'maxDelegated'];

/**
 * Validates a regex without running anything (so a GUI can flag syntax errors
 * while the user types).
 * @param {string} src - the expected regex, in the token syntax of lib/regex
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateRegex(src) {
  try {
    compileRegex(src);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The visualization's own crawler options, from its optional config.js.
 * @returns {Object} the exported object, or {} when there is no config.js
 */
function loadVizConfig(vizDir) {
  const configPath = path.join(vizDir, 'config.js');
  if (!fs.existsSync(configPath)) return {};
  delete require.cache[require.resolve(configPath)]; // re-read it if it changed between runs
  return require(configPath);
}

/**
 * Reads a transitions.json (or the folder that has it) for re-analysis. Only the
 * parts the report is built from are kept (the table, the visibility, the hover
 * summary); everything else is derived again.
 * @param {string} fromTransitions - the file, or the folder that contains it
 * @param {string} [outDirIn] - where to write; defaults to the folder of the input
 * @returns {{ data: Object, outDir: string }} outDir: where to write by default, next to the input
 */
function loadTransitions(fromTransitions, outDirIn, onLog) {
  let input = path.resolve(fromTransitions);
  if (fs.existsSync(input) && fs.statSync(input).isDirectory()) input = path.join(input, 'transitions.json');
  if (!fs.existsSync(input)) throw new Error(`not found: ${input}`);
  const { initialState, transitions, visibility, hovers } = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (!initialState || !transitions) throw new Error(`${input} is not in the transitions.json format (initialState/transitions are missing)`);
  const data = { initialState, transitions };
  if (visibility) data.visibility = visibility;
  if (hovers) data.hovers = hovers; // already summarized: re-analyzing must not lose the notes
  onLog(`re-analyzing ${input} (no crawl)`);
  return { data, outDir: outDirIn ? path.resolve(outDirIn) : path.dirname(input) };
}

/** The transitions that lead to __ERROR__: a click that breaks the page. */
function findErrorTransitions(transitions) {
  const found = [];
  for (const [state, trans] of Object.entries(transitions)) {
    for (const [action, next] of Object.entries(trans)) {
      if (next === ERROR_STATE) found.push({ state, action });
    }
  }
  return found;
}

/**
 * Writes transitions.json and automaton.svg (creating the folder if needed).
 * @param {{json: Object, svg: string}} report - from buildReport
 * @returns {{transitions: string, svg: string}} the paths written
 */
function writeOutputs(outDir, report, onLog) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = { transitions: path.join(outDir, 'transitions.json'), svg: path.join(outDir, 'automaton.svg') };
  fs.writeFileSync(files.transitions, JSON.stringify(report.json, null, 2));
  fs.writeFileSync(files.svg, report.svg);
  onLog(`saved: ${files.transitions}`);
  onLog(`saved: ${files.svg}`);
  return files;
}

/**
 * @param {Object} opts
 * @param {string} [opts.vizDir] - folder with index.html (crawl mode)
 * @param {string} [opts.fromTransitions] - an already generated transitions.json (or its folder), no crawl.
 *   Exactly one of vizDir / fromTransitions.
 * @param {string} [opts.outDir] - where to write transitions.json and automaton.svg
 *   (default: vizDir, or the folder of fromTransitions)
 * @param {boolean} [opts.writeFiles=true] - false: only return the result
 * @param {string} [opts.regex] - expected regex to compare against (optional)
 * @param {boolean} [opts.regexPrefixes=false] - compare against the regex's prefixes
 * @param {number} [opts.diffLimit=10] - counterexamples per direction
 * @param {number} [opts.maxRegexLength=500000] - longer regexes are omitted (null) and where they
 *   blew up is reported (regex.explosion); Infinity = no limit
 * @param {boolean} [opts.traceRegex=false] - log the state-elimination trace
 * @param {boolean} [opts.includeLinks=false] - also detect <a> / [href] as clickable
 * @param {Object} [opts.crawler] - overrides config.js: settleMs, discoverySettleMs, maxStates,
 *   maxSteps, containerSelector, backSelector, clickableSelector, hover (false: clicks only),
 *   hoverableSelector, maxDelegated
 * @param {(msg: string) => void} [opts.onLog]
 * @param {(p: {elapsedMs: number, state: string, actions: number, knownStates: number}) => void} [opts.onProgress]
 *
 * @returns {Promise<{
 *   mode: 'crawl' | 'transitions',
 *   initialState: string,
 *   transitions: Object,
 *   regex: { cycleCut: string|null, cycles: {tree, back, shortcuts, shortcutTransitions},
 *            language: string|null, completeInteractions: string|null,
 *            cycleCutOmitted?: string, languageOmitted?: string, completeInteractionsOmitted?: string, explosion?: Object, ... },
 *   comparison: null | { equivalent: boolean, onlyInCrawler: string[], onlyInExpected: string[], ... },
 *   issues: { kind: 'error'|'missing'|'unexpected', message: string, detail: string, sequence: string[],
 *             events: {step, state, action, to, edge}[], failingStep: number, occurrences: number }[],
 *   partiallyVisibleClicks: null | { count: number, ofTransitions: number, transitions: Object[] },
 *   hovers: null | { transient: number, structural: number, actions: Object, ignored?: Object[] } - the hover actions
 *             (with their effect noted) and the hovers discarded for doing nothing visible
 *   svg: string,
 *   stats: { states: number, errorTransitions: {state, action}[], truncated: boolean, elapsedMs: number },
 *   files: null | { transitions: string, svg: string },
 * }>}
 */
async function run(opts = {}) {
  const {
    vizDir: vizDirIn,
    fromTransitions,
    outDir: outDirIn,
    writeFiles = true,
    regex = null,
    regexPrefixes = false,
    diffLimit = 10,
    maxRegexLength,
    traceRegex = false,
    includeLinks = false,
    crawler: crawlerOverrides = {},
    onLog = () => {},
    onProgress = () => {},
  } = opts;

  if (!!vizDirIn === !!fromTransitions) {
    throw new Error('specify exactly one of: vizDir (crawl a visualization) or fromTransitions (re-analyze a transitions.json)');
  }

  // Validate the regex BEFORE crawling: a syntax error should not be found
  // only at the end of a long crawl.
  if (regex) {
    const v = validateRegex(regex);
    if (!v.ok) throw new Error(`the expected regex is not valid: ${v.error}`);
    onLog(`expected regex to compare against: ${regex}${regexPrefixes ? ' (by prefixes)' : ''}`);
  }

  const t0 = Date.now();
  let mode, data, stats, outDir;

  if (fromTransitions) {
    mode = 'transitions';
    ({ data, outDir } = loadTransitions(fromTransitions, outDirIn, onLog));
    stats = { truncated: false };
  } else {
    mode = 'crawl';
    const vizDir = path.resolve(vizDirIn);
    if (!fs.existsSync(path.join(vizDir, 'index.html'))) throw new Error(`not found: ${path.join(vizDir, 'index.html')}`);
    outDir = outDirIn ? path.resolve(outDirIn) : vizDir;
    const crawled = await crawlViz({ vizDir, includeLinks, crawlerOverrides, onLog, onProgress, t0 });
    data = crawled.data;
    stats = crawled.stats;
  }

  const report = buildReport(data, { expectedRegex: regex, prefixes: regexPrefixes, limit: diffLimit, maxRegexLength, traceRegex });
  report.log.forEach((l) => onLog(l));

  const errorTransitions = findErrorTransitions(report.json.transitions);
  const files = writeFiles ? writeOutputs(outDir, report, onLog) : null;

  return {
    mode,
    initialState: report.json.initialState,
    transitions: report.json.transitions,
    regex: report.json.regex,
    comparison: report.json.comparison || null,
    issues: report.json.issues,
    partiallyVisibleClicks: report.json.partiallyVisibleClicks || null,
    hovers: report.json.hovers || null,
    svg: report.svg,
    stats: {
      ...stats,
      states: Object.keys(report.json.transitions).length,
      errorTransitions,
      elapsedMs: Date.now() - t0,
    },
    files,
  };
}

/**
 * The crawl mode of run(): starts a local server for the visualization, crawls it
 * with crawler.js and gives the states readable names.
 * @param {Object} p
 * @param {string} p.vizDir - absolute path of the folder with index.html
 * @param {boolean} p.includeLinks - also treat <a> / [href] as interactive
 * @param {Object} p.crawlerOverrides - the `crawler` option of run(); wins over config.js
 * @param {(msg: string) => void} p.onLog
 * @param {Function} p.onProgress - called after every state expanded
 * @param {number} p.t0 - when the run started (Date.now()), for the elapsed times
 * @returns {Promise<{data: Object, stats: {truncated: boolean, usedManualState: boolean}}>}
 *   data: the tables buildReport takes; truncated: maxStates cut the crawl short
 */
async function crawlViz({ vizDir, includeLinks, crawlerOverrides, onLog, onProgress, t0 }) {
  const config = { ...loadVizConfig(vizDir) };
  for (const k of CRAWLER_OPTIONS) if (crawlerOverrides[k] != null) config[k] = crawlerOverrides[k];

  onLog(config.backSelector
    ? `analyzing ${vizDir} -- with backSelector -> fast mode (navigation through the common ancestor)`
    : `analyzing ${vizDir} -- without backSelector -> generic mode (automatic detection, reload + replay)`);
  if (config.settleMs == null) onLog('virtual time: after every click/load the page clock is advanced until the animation ends');

  const initScripts = [];
  if (includeLinks) {
    initScripts.push('window.__crawlerIncludeLinks = true;');
    onLog('<a>/[href] elements WILL be detected as clickable');
  }
  if (config.containerSelector) {
    initScripts.push(`window.__crawlerContainerSelector = ${JSON.stringify(config.containerSelector)};`);
    onLog(`restricted to the container: ${config.containerSelector}`);
  }
  initScripts.push(fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8'));

  const server = await startServer(vizDir);
  const chromePath = await resolveChromePath();
  try {
    const { transitions, initialState, visibility, labels, effects, ignoredHovers, renamed, usedManualState, truncated } = await crawl({
      fixtureUrl: `http://127.0.0.1:${server.address().port}/index.html`,
      chromePath,
      initScripts,
      ...config,
      onLog,
      onStateExpanded: (state, trans, knownStates) => {
        const progress = { elapsedMs: Date.now() - t0, state, actions: Object.keys(trans).length, knownStates };
        onProgress(progress);
        onLog(`[${(progress.elapsedMs / 1000).toFixed(1)}s] state expanded: "${state}" (${progress.actions} actions) -- total known: ${progress.knownStates}`);
      },
    });

    onLog(truncated
      ? `CRAWL INCOMPLETE: maxStates was reached with unexpanded states -- the automaton is PARTIAL, raise maxStates`
      : 'CRAWL COMPLETE');
    for (const [from, to] of Object.entries(renamed)) {
      onLog(`action renamed: "${from}" -> "${to}" (the element shows a different name depending on the state, e.g. a datum that is re-bound on every click)`);
    }

    let data = { initialState, transitions, visibility, effects, ignoredHovers };
    if (!usedManualState) {
      const pretty = prettifyStates({ ...data, labels });
      onLog(pretty.hierarchical
        ? 'states named by their place in the data hierarchy (diagram columns = levels)'
        : 'states named by the click path that discovered them (no hierarchy was detected)');
      data = { initialState: pretty.initialState, transitions: pretty.transitions, visibility: pretty.visibility, effects: pretty.effects, ignoredHovers };
    }
    return { data, stats: { truncated, usedManualState } };
  } finally {
    server.close();
  }
}

/** Prints the help text to stderr. */
function usage() {
  console.error(`Usage:
  node run.js <folder-with-index.html> [options]       crawl the visualization
  node run.js --from <transitions.json|folder> [...]   re-analyze a previous output, without crawling

Examples:
  node run.js examples/sunburst-amplio
  node run.js examples/sunburst-amplio --regex "((vis | util) circle)*" --regexPrefixes
  node run.js --from examples/sunburst-amplio --regexFile esperado.txt

Observed regex: the diagram shows the regex with the CYCLES CUT (hierarchy + going back
up; shortcuts to another branch are listed apart in regex.cycles). transitions.json also carries the two
exact regexes (language, completeInteractions), which may be omitted on dense graphs.

Hover: besides clicking, the crawler tries putting the pointer over every element that reacts to
mouseover/mouseenter. A hover enters the regex as Hover_<element> only if it changes something visible -- even
a highlight, and its effect is noted in transitions.json (hovers). The ones that do nothing visible
are not actions: they are listed in hovers.ignored. If the hover opens something (a menu) it leads to another state, and its
way back is Unhover_<element>. With --no-hover only clicks are tried.
  Hovers made with addEventListener (what D3's selection.on does) are found, and so are handlers in the property or
  the attribute (el.onmouseover = fn, onmouseover="..."), CSS :hover (the state is forced in the browser,
  without moving any mouse), and move hovers (mousemove/pointermove: tried at the center and at the edge, and
  a warning says when the effect depends on where it is aimed). A listener delegated on a container (which looks at
  event.target) is tried on the D3 marks inside it, up to --maxDelegated.
  The browser's native tooltip (a <title> or title="") is ignored on purpose and there is no option to count it:
  D3 does not generate tooltips (it never creates a <title>), the browser draws it with no listener and no DOM change, so
  its effect cannot be observed and it would be an invented hover. The <title> text is still used to name actions.

Comparison (optional; without --regex only the observed regex is generated). The expected regex is
compared against the full automaton and against the one with cycles cut (each as every performable prefix and
as complete interactions): it passes if it matches exactly one of them. Every difference, and every
click that breaks the page, is reported as "unexpected behavior": the series of events
(state, click, next state) that reproduces it from the initial state.
  --regex "<expr>"          expected regex: tokens separated by spaces, | * + ? {n,m} ( );
                            the Click_ prefix is optional ("vis circle" = "Click_vis Click_circle")
  --regexFile <file>        same, read from a file (avoids escaping | and * in the shell)
  --regexPrefixes           compare against the PREFIXES of the regex (if it describes complete interactions)
  --diffLimit <n>           counterexamples to show per direction (default 10)

Regex size:
  --maxRegexLength <n>      omit the regex if it exceeds n characters and report where it blows up
                            (default 500000; 0 = no limit)
  --traceRegex              log the state elimination trace (size step by step)

Output:
  --out <folder>            where to save transitions.json/automaton.svg (default: the source folder)
  --no-write                do not write files
  --json                    print the result as JSON on stdout (messages go to stderr)

Crawler (override the visualization's config.js):
  --settleMs <ms>           FIXED real-time pause after every click (default: virtual time)
  --discoverySettleMs <ms>  pause before listing the candidates of a newly visited state
  --maxStates <n>           cap on the states to discover
  --maxSteps <n>            hard cap on total interactions
  --containerSelector <css> restrict detection and state to this container (e.g. "#sb")
  --include-links           do not exclude <a>/[href] from automatic detection
  --no-hover                do not probe hovers (clicks only)
  --maxDelegated <n>        cap on the marks to probe per delegated listener (default 50; 0 = do not probe delegated ones)

Exit code: 0 ok / equivalent, 1 error, 2 the expected regex differs from what was observed
or some click breaks the page.`);
}

/**
 * Command-line arguments -> the options of run(). Crawler flags land in `opts.crawler`.
 * @param {string[]} argv - process.argv without node and the script
 * @returns {Object} the options; also `help` and `json`, which only the command line uses
 * @throws {Error} for an unknown option, a missing value or a non-numeric number
 */
function parseArgs(argv) {
  const opts = { crawler: {} };
  const rest = [];
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} expects a value`);
    return argv[i + 1];
  };
  const num = (v, flag) => {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`${flag} expects a number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--from': opts.fromTransitions = need(i, a); i++; break;
      case '--out': opts.outDir = need(i, a); i++; break;
      case '--regex': opts.regex = need(i, a); i++; break;
      case '--regexFile': opts.regex = fs.readFileSync(need(i, a), 'utf8').trim(); i++; break;
      case '--regexPrefixes': opts.regexPrefixes = true; break;
      case '--diffLimit': opts.diffLimit = num(need(i, a), a); i++; break;
      case '--maxRegexLength': opts.maxRegexLength = num(need(i, a), a) || Infinity; i++; break;
      case '--traceRegex': opts.traceRegex = true; break;
      case '--no-write': opts.writeFiles = false; break;
      case '--json': opts.json = true; break;
      case '--include-links': opts.includeLinks = true; break;
      case '--no-hover': opts.crawler.hover = false; break;
      case '--settleMs': case '--discoverySettleMs': case '--maxStates': case '--maxSteps': case '--maxDelegated':
        opts.crawler[a.slice(2)] = num(need(i, a), a); i++; break;
      case '--containerSelector': opts.crawler.containerSelector = need(i, a); i++; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
        rest.push(a);
    }
  }
  if (rest.length > 1) throw new Error(`extra arguments: ${rest.slice(1).join(' ')}`);
  if (rest.length === 1) opts.vizDir = rest[0];
  return opts;
}

/** The command line: parses the arguments, runs, prints, and sets the exit code (see the header). */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usage();
    process.exitCode = 1;
    return;
  }
  if (opts.help || (!opts.vizDir && !opts.fromTransitions)) {
    usage();
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  // with --json, stdout is reserved for the result
  const log = opts.json ? (m) => console.error(m) : (m) => console.log(m);
  try {
    const result = await run({ ...opts, onLog: log });
    if (opts.json) {
      const { svg, ...rest } = result; // the SVG is already in files.svg; do not bloat stdout
      process.stdout.write(JSON.stringify(rest, null, 2) + '\n');
    } else {
      log(`\nstates: ${result.stats.states} · transitions to ERROR: ${result.stats.errorTransitions.length} · unexpected behaviors: ${result.issues.length} · ${(result.stats.elapsedMs / 1000).toFixed(1)}s`);
      log(`regex (cycles cut): ${result.regex.cycleCut ?? result.regex.cycleCutOmitted}`);
    }
    if ((result.comparison && !result.comparison.equivalent) || result.issues.some((i) => i.kind === KIND.error)) process.exitCode = 2;
  } catch (e) {
    console.error(`ERROR: ${e.message || e}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { run, validateRegex, parseArgs };
