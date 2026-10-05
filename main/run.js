/**
 * Punto de entrada del crawler. Dos formas de usarlo:
 *
 *  - Como MÓDULO (pensado para una GUI): `const { run } = require('./run')`
 *    y `await run({ vizDir, regex, onLog, onProgress })`. No escribe a la
 *    consola ni termina el proceso: avisa por callbacks, devuelve un
 *    resultado estructurado y, ante un problema, tira un Error.
 *
 *  - Por LÍNEA DE COMANDOS: `node run.js <carpeta> [opciones]` (ver
 *    usage()). Es un envoltorio fino sobre run().
 *
 * En los dos casos hay dos modos de origen:
 *   - crawl:       se explora la visualización (carpeta con index.html).
 *   - transitions: se re-analiza un transitions.json ya generado, sin
 *                  abrir el browser (para comparar contra otro regex, o
 *                  regenerar el diagrama).
 * y la comparación contra un regex esperado es opcional en ambos.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { crawl, ERROR_STATE } = require('./crawler');
const { prettifyStates } = require('./lib/labels');
const { buildReport } = require('./lib/report');
const { compileRegex } = require('./lib/regex');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml' };

// opciones del crawler que se pueden pisar (sobre config.js de la viz)
const CRAWLER_OPTIONS = ['settleMs', 'discoverySettleMs', 'maxStates', 'maxSteps', 'containerSelector', 'backSelector', 'clickableSelector'];

// puerto 0 = el sistema elige uno libre: varias corridas (o una GUI con
// varias pestañas) no se pisan entre sí
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
 * Valida un regex sin correr nada (para que una GUI marque errores de
 * sintaxis mientras se escribe).
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
  delete require.cache[require.resolve(configPath)]; // releer si cambió entre corridas
  return require(configPath);
}

/**
 * @param {Object} opts
 * @param {string} [opts.vizDir] - carpeta con index.html (modo crawl)
 * @param {string} [opts.fromTransitions] - transitions.json (o su carpeta) ya generado (modo sin crawl).
 *   Exactamente uno de vizDir / fromTransitions.
 * @param {string} [opts.outDir] - dónde escribir transitions.json y automaton.svg
 *   (default: vizDir, o la carpeta de fromTransitions)
 * @param {boolean} [opts.writeFiles=true] - false: solo devolver el resultado
 * @param {string} [opts.regex] - regex esperado a comparar (opcional)
 * @param {boolean} [opts.regexPrefixes=false] - comparar contra los prefijos del regex
 * @param {number} [opts.diffLimit=10] - contraejemplos por dirección
 * @param {number} [opts.maxRegexLength=500000] - regex más largos se omiten (null) y se
 *   informa dónde explotaron (regex.explosion); Infinity = sin tope
 * @param {boolean} [opts.traceRegex=false] - loguear la traza de la eliminación de estados
 * @param {boolean} [opts.resume=true] - retomar checkpoint.json si existe; false lo descarta
 * @param {boolean} [opts.includeLinks=false] - detectar también <a>/[href] como clickeables
 * @param {Object} [opts.crawler] - pisa config.js: settleMs, discoverySettleMs, maxStates,
 *   maxSteps, containerSelector, backSelector, clickableSelector
 * @param {(msg: string) => void} [opts.onLog]
 * @param {(p: {elapsedMs: number, state: string, actions: number, knownStates: number}) => void} [opts.onProgress]
 *
 * @returns {Promise<{
 *   mode: 'crawl' | 'transitions',
 *   initialState: string,
 *   transitions: Object,
 *   regex: { language: string|null, completeInteractions: string|null,
 *            languageOmitted?: string, completeInteractionsOmitted?: string, explosion?: Object, ... },
 *   comparison: null | { equivalent: boolean, onlyInCrawler: string[], onlyInExpected: string[], ... },
 *   partiallyVisibleClicks: null | { count: number, ofTransitions: number, transitions: Object[] },
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

  // validar el regex ANTES de crawlear: un error de sintaxis no debería
  // descubrirse recién al final de un crawl largo
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
    const { initialState, transitions, visibility } = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (!initialState || !transitions) throw new Error(`${input} no tiene el formato de transitions.json (faltan initialState/transitions)`);
    data = { initialState, transitions };
    if (visibility) data.visibility = visibility;
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
    partiallyVisibleClicks: report.json.partiallyVisibleClicks || null,
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

  // el checkpoint vive junto a la salida; sin escritura de archivos no hay checkpoint
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
    const { transitions, initialState, visibility, labels, renamed, usedManualState, truncated } = await crawl({
      fixtureUrl: `http://127.0.0.1:${server.address().port}/index.html`,
      chromePath,
      initScripts,
      resume,
      ...config,
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

    let data = { initialState, transitions, visibility };
    if (!usedManualState) {
      const pretty = prettifyStates({ ...data, labels });
      onLog(pretty.hierarchical
        ? 'estados nombrados por su lugar en la jerarquía de datos (columnas del diagrama = niveles)'
        : 'estados nombrados por el camino de clicks que los descubrió (no se detectó una jerarquía)');
      data = { initialState: pretty.initialState, transitions: pretty.transitions, visibility: pretty.visibility };
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

Comparación (opcional; sin --regex solo se genera el regex observado):
  --regex "<expr>"          regex esperado: tokens separados por espacio, | * + ? {n,m} ( );
                            el prefijo Click_ es opcional ("vis circle" = "Click_vis Click_circle")
  --regexFile <archivo>     igual, leído de un archivo (evita escapar | y * en la consola)
  --regexPrefixes           comparar contra los PREFIJOS del regex (si describe interacciones completas)
  --diffLimit <n>           contraejemplos a mostrar por dirección (default 10)

Regex observado:
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
  --fresh                   ignorar (y borrar) un checkpoint.json previo

Código de salida: 0 ok / equivalentes, 1 error, 2 el regex esperado difiere de lo observado.`);
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
      case '--fresh': opts.resume = false; break;
      case '--settleMs': case '--discoverySettleMs': case '--maxStates': case '--maxSteps':
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

  // con --json, stdout queda reservado para el resultado
  const log = opts.json ? (m) => console.error(m) : (m) => console.log(m);
  try {
    const result = await run({ ...opts, onLog: log });
    if (opts.json) {
      const { svg, ...rest } = result; // el SVG ya está en files.svg; no inflar stdout
      process.stdout.write(JSON.stringify(rest, null, 2) + '\n');
    } else {
      log(`\nestados: ${result.stats.states} · transiciones a ERROR: ${result.stats.errorTransitions.length} · ${(result.stats.elapsedMs / 1000).toFixed(1)}s`);
      log(`regex (interacciones completas): ${result.regex.completeInteractions ?? result.regex.completeInteractionsOmitted}`);
    }
    if (result.comparison && !result.comparison.equivalent) process.exitCode = 2;
  } catch (e) {
    console.error(`ERROR: ${e.message || e}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { run, validateRegex, parseArgs };
