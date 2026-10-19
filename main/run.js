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
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { crawl, ERROR_STATE } = require('./crawler');
const { prettifyStates } = require('./lib/labels');
const { buildReport } = require('./lib/report');
const { compileRegex } = require('./lib/regex');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml' };

// crawler options that can be overridden (on top of the visualization's config.js)
const CRAWLER_OPTIONS = ['settleMs', 'discoverySettleMs', 'maxStates', 'maxSteps', 'containerSelector', 'backSelector', 'clickableSelector', 'hover', 'hoverableSelector', 'maxDelegated'];

// Port 0 lets the system pick a free one, so several runs (or a GUI with
// several tabs) do not step on each other.
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]);
      const filePath = path.join(dir, rel);
      if (!filePath.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function resolveChromePath() {
  if (process.platform !== 'linux') return undefined;
  try {
    const chromium = require('@sparticuz/chromium');
    return await chromium.executablePath();
  } catch (e) {
    return undefined;
  }
}

/**
 * Validates a regex without running anything (so a GUI can flag syntax errors
 * while the user types).
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

function loadVizConfig(vizDir) {
  const configPath = path.join(vizDir, 'config.js');
  if (!fs.existsSync(configPath)) return {};
  delete require.cache[require.resolve(configPath)]; // re-read it if it changed between runs
  return require(configPath);
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
 * @param {boolean} [opts.resume=true] - resume checkpoint.json when it exists; false discards it
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
 *   issues: { kind: 'error'|'faltante'|'noEsperado', message: string, detail: string, sequence: string[],
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
    resume: allowResume = true,
    includeLinks = false,
    crawler: crawlerOverrides = {},
    onLog = () => {},
    onProgress = () => {},
  } = opts;

  if (!!vizDirIn === !!fromTransitions) {
    throw new Error('indicá exactamente uno de: vizDir (crawlear una visualización) o fromTransitions (re-analizar un transitions.json)');
  }

  // Validate the regex BEFORE crawling: a syntax error should not be found
  // only at the end of a long crawl.
  if (regex) {
    const v = validateRegex(regex);
    if (!v.ok) throw new Error(`el regex esperado no es válido: ${v.error}`);
    onLog(`regex esperado a comparar: ${regex}${regexPrefixes ? ' (por prefijos)' : ''}`);
  }

  const t0 = Date.now();
  let mode, data, stats, outDir;

  if (fromTransitions) {
    mode = 'transitions';
    let input = path.resolve(fromTransitions);
    if (fs.existsSync(input) && fs.statSync(input).isDirectory()) input = path.join(input, 'transitions.json');
    if (!fs.existsSync(input)) throw new Error(`no se encontró ${input}`);
    const { initialState, transitions, visibility, hovers } = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (!initialState || !transitions) throw new Error(`${input} no tiene el formato de transitions.json (faltan initialState/transitions)`);
    data = { initialState, transitions };
    if (visibility) data.visibility = visibility;
    if (hovers) data.hovers = hovers; // already summarized: re-analyzing must not lose the notes
    outDir = outDirIn ? path.resolve(outDirIn) : path.dirname(input);
    onLog(`re-analizando ${input} (sin crawlear)`);
    stats = { truncated: false };
  } else {
    mode = 'crawl';
    const vizDir = path.resolve(vizDirIn);
    if (!fs.existsSync(path.join(vizDir, 'index.html'))) throw new Error(`no se encontró ${path.join(vizDir, 'index.html')}`);
    outDir = outDirIn ? path.resolve(outDirIn) : vizDir;
    const crawled = await crawlViz({ vizDir, outDir, writeFiles, allowResume, includeLinks, crawlerOverrides, onLog, onProgress, t0 });
    data = crawled.data;
    stats = crawled.stats;
  }

  const report = buildReport(data, { expectedRegex: regex, prefixes: regexPrefixes, limit: diffLimit, maxRegexLength, traceRegex });
  report.log.forEach((l) => onLog(l));

  const errorTransitions = [];
  for (const [state, trans] of Object.entries(report.json.transitions)) {
    for (const [action, next] of Object.entries(trans)) {
      if (next === ERROR_STATE) errorTransitions.push({ state, action });
    }
  }

  let files = null;
  if (writeFiles) {
    fs.mkdirSync(outDir, { recursive: true });
    files = { transitions: path.join(outDir, 'transitions.json'), svg: path.join(outDir, 'automaton.svg') };
    fs.writeFileSync(files.transitions, JSON.stringify(report.json, null, 2));
    fs.writeFileSync(files.svg, report.svg);
    onLog(`guardado: ${files.transitions}`);
    onLog(`guardado: ${files.svg}`);
  }

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

async function crawlViz({ vizDir, outDir, writeFiles, allowResume, includeLinks, crawlerOverrides, onLog, onProgress, t0 }) {
  const config = { ...loadVizConfig(vizDir) };
  for (const k of CRAWLER_OPTIONS) if (crawlerOverrides[k] != null) config[k] = crawlerOverrides[k];

  onLog(config.backSelector
    ? `analizando ${vizDir} -- con backSelector -> modo rápido (navegación por ancestro común)`
    : `analizando ${vizDir} -- sin backSelector -> modo genérico (detección automática, recarga+replay)`);
  if (config.settleMs == null) onLog('tiempo virtual: tras cada click/carga se adelanta el reloj de la página hasta que termina la animación');

  const initScripts = [];
  if (includeLinks) {
    initScripts.push('window.__crawlerIncludeLinks = true;');
    onLog('los <a>/[href] SÍ se van a detectar como clickeables');
  }
  if (config.containerSelector) {
    initScripts.push(`window.__crawlerContainerSelector = ${JSON.stringify(config.containerSelector)};`);
    onLog(`acotado al contenedor: ${config.containerSelector}`);
  }
  initScripts.push(fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8'));

  // The checkpoint lives next to the output; with no file writing there is no checkpoint.
  const checkpointPath = writeFiles ? path.join(outDir, 'checkpoint.json') : null;
  let resume = null;
  if (checkpointPath && fs.existsSync(checkpointPath)) {
    if (allowResume) {
      resume = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      onLog(`retomando checkpoint: ${resume.graph.length} estados ya conocidos, ${resume.queue.length} en cola`);
    } else {
      fs.unlinkSync(checkpointPath);
      onLog('checkpoint anterior descartado');
    }
  }
  if (checkpointPath) fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer(vizDir);
  const chromePath = await resolveChromePath();
  try {
    const { transitions, initialState, visibility, labels, effects, ignoredHovers, renamed, usedManualState, truncated } = await crawl({
      fixtureUrl: `http://127.0.0.1:${server.address().port}/index.html`,
      chromePath,
      initScripts,
      resume,
      ...config,
      onLog,
      onStateExpanded: (state, trans, snapshot) => {
        const progress = { elapsedMs: Date.now() - t0, state, actions: Object.keys(trans).length, knownStates: snapshot.graph.length };
        onProgress(progress);
        onLog(`[${(progress.elapsedMs / 1000).toFixed(1)}s] estado expandido: "${state}" (${progress.actions} acciones) -- total conocido: ${progress.knownStates}`);
        if (checkpointPath) fs.writeFileSync(checkpointPath, JSON.stringify(snapshot));
      },
    });

    onLog(truncated
      ? `CRAWL INCOMPLETO: se alcanzó maxStates con estados sin expandir -- el autómata es PARCIAL, subí maxStates`
      : 'CRAWL COMPLETO');
    for (const [from, to] of Object.entries(renamed)) {
      onLog(`acción renombrada: "${from}" -> "${to}" (el elemento muestra un nombre distinto según el estado, p.ej. un dato que se re-liga en cada click)`);
    }

    let data = { initialState, transitions, visibility, effects, ignoredHovers };
    if (!usedManualState) {
      const pretty = prettifyStates({ ...data, labels });
      onLog(pretty.hierarchical
        ? 'estados nombrados por su lugar en la jerarquía de datos (columnas del diagrama = niveles)'
        : 'estados nombrados por el camino de clicks que los descubrió (no se detectó una jerarquía)');
      data = { initialState: pretty.initialState, transitions: pretty.transitions, visibility: pretty.visibility, effects: pretty.effects, ignoredHovers };
    }
    if (checkpointPath && fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);
    return { data, stats: { truncated, usedManualState } };
  } catch (e) {
    if (checkpointPath && fs.existsSync(checkpointPath)) {
      e.message = `${e.message} (progreso guardado en ${checkpointPath} -- volvé a correr para retomar)`;
      e.checkpoint = checkpointPath;
    }
    throw e;
  } finally {
    server.close();
  }
}

function usage() {
  console.error(`Uso:
  node run.js <carpeta-con-index.html> [opciones]     crawlea la visualización
  node run.js --from <transitions.json|carpeta> [...]  re-analiza una salida previa, sin crawlear

Ejemplos:
  node run.js examples/sunburst-amplio
  node run.js examples/sunburst-amplio --regex "((vis | util) circle)*" --regexPrefixes
  node run.js --from examples/sunburst-amplio --regexFile esperado.txt

Regex observado: el diagrama muestra el regex con los CICLOS CORTADOS (jerarquía + volver hacia
arriba; los atajos a otra rama van aparte en regex.cycles). transitions.json trae además los dos
regex exactos (language, completeInteractions), que en grafos densos pueden quedar omitidos.

Hover: además de clickear, el crawler prueba poner el puntero sobre cada elemento que reacciona a
mouseover/mouseenter. Un hover entra al regex como Hover_<elemento> solo si cambia algo visible -- aunque
sea un resaltado, y el efecto queda anotado en transitions.json (hovers). Los que no hacen nada visible
no son acciones: se listan en hovers.ignored. Si el hover abre algo (un menú) lleva a otro estado, y su
vuelta es Unhover_<elemento>. Con --no-hover se prueban solo los clicks.
  Se ven los hovers hechos con addEventListener (lo que hace selection.on de D3), con handlers en la propiedad o
  el atributo (el.onmouseover = fn, onmouseover="..."), con :hover de CSS (se fuerza el estado en el navegador,
  sin mover ningún mouse), y los de movimiento (mousemove/pointermove: se prueban en el centro y en el borde, y
  se avisa si el efecto depende de dónde se apunta). Un listener delegado en un contenedor (que mira
  event.target) se prueba sobre las marcas de D3 que tiene adentro, hasta --maxDelegated.
  El tooltip nativo del navegador (un <title> o title="") se ignora a propósito y no hay opción para contarlo:
  D3 no genera tooltips (nunca crea un <title>), lo dibuja el navegador sin listener y sin cambiar el DOM, así que
  su efecto no se puede observar y sería un hover inventado. El texto del <title> sí se usa para nombrar acciones.

Comparación (opcional; sin --regex solo se genera el regex observado). El regex esperado se
compara contra el autómata completo y contra el de ciclos cortados (cada uno como todo prefijo
realizable y como interacciones completas): pasa si coincide exactamente con alguno. Cada diferencia, y cada
click que rompe la página, se informa como "comportamiento inesperado": la serie de eventos
(estado, click, estado siguiente) que lo reproduce desde el estado inicial.
  --regex "<expr>"          regex esperado: tokens separados por espacio, | * + ? {n,m} ( );
                            el prefijo Click_ es opcional ("vis circle" = "Click_vis Click_circle")
  --regexFile <archivo>     igual, leído de un archivo (evita escapar | y * en la consola)
  --regexPrefixes           comparar contra los PREFIJOS del regex (si describe interacciones completas)
  --diffLimit <n>           contraejemplos a mostrar por dirección (default 10)

Tamaño del regex:
  --maxRegexLength <n>      omitir el regex si supera n caracteres e informar dónde explota
                            (default 500000; 0 = sin tope)
  --traceRegex              loguear la traza de la eliminación de estados (tamaño paso a paso)

Salida:
  --out <carpeta>           dónde guardar transitions.json/automaton.svg (default: la carpeta de origen)
  --no-write                no escribir archivos
  --json                    imprimir el resultado como JSON por stdout (los mensajes van a stderr)

Crawler (pisan config.js de la visualización):
  --settleMs <ms>           pausa FIJA en tiempo real tras cada click (default: tiempo virtual)
  --discoverySettleMs <ms>  pausa antes de listar candidatos de un estado recién visitado
  --maxStates <n>           tope de estados a descubrir
  --maxSteps <n>            tope duro de interacciones totales
  --containerSelector <css> acotar detección y estado a este contenedor (ej. "#sb")
  --include-links           no excluir <a>/[href] de la detección automática
  --no-hover                no probar hovers (solo clicks)
  --maxDelegated <n>        tope de marcas a probar por listener delegado (default 50; 0 = no probar delegados)
  --fresh                   ignorar (y borrar) un checkpoint.json previo

Código de salida: 0 ok / equivalentes, 1 error, 2 el regex esperado difiere de lo observado
o algún click rompe la página.`);
}

function parseArgs(argv) {
  const opts = { crawler: {} };
  const rest = [];
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} espera un valor`);
    return argv[i + 1];
  };
  const num = (v, flag) => {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`${flag} espera un número, se recibió "${v}"`);
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
      case '--fresh': opts.resume = false; break;
      case '--settleMs': case '--discoverySettleMs': case '--maxStates': case '--maxSteps': case '--maxDelegated':
        opts.crawler[a.slice(2)] = num(need(i, a), a); i++; break;
      case '--containerSelector': opts.crawler.containerSelector = need(i, a); i++; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`opción desconocida: ${a}`);
        rest.push(a);
    }
  }
  if (rest.length > 1) throw new Error(`argumentos de más: ${rest.slice(1).join(' ')}`);
  if (rest.length === 1) opts.vizDir = rest[0];
  return opts;
}

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
      log(`\nestados: ${result.stats.states} · transiciones a ERROR: ${result.stats.errorTransitions.length} · comportamientos inesperados: ${result.issues.length} · ${(result.stats.elapsedMs / 1000).toFixed(1)}s`);
      log(`regex (ciclos cortados): ${result.regex.cycleCut ?? result.regex.cycleCutOmitted}`);
    }
    if ((result.comparison && !result.comparison.equivalent) || result.issues.some((i) => i.kind === 'error')) process.exitCode = 2;
  } catch (e) {
    console.error(`ERROR: ${e.message || e}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { run, validateRegex, parseArgs };
