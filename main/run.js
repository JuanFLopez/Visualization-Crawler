const fs = require('fs');
const path = require('path');
const http = require('http');
const { crawl, ERROR_STATE } = require('./crawler');
const { fromTransitionsJson } = require('./lib/automaton');
const { toSVG } = require('./lib/diagram');
const { prettifyStates } = require('./lib/labels');

const PORT = 8934;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };

function usage() {
  console.error('Uso: node run.js <carpeta-con-index.html> [opciones]');
  console.error('Ejemplo: node run.js examples/sunburst-manual');
  console.error('         node run.js C:\\ruta\\a\\mi-visualizacion --settleMs 2500 --discoverySettleMs 2500');
  console.error('');
  console.error('Opciones (pisan lo que diga config.js, si existe):');
  console.error('  --out <carpeta>          dónde guardar transitions.json/automaton.svg (default: la misma carpeta)');
  console.error('  --settleMs <ms>          pausa FIJA en tiempo real tras cada click (default: tiempo virtual, se adelanta el reloj hasta que termina la animación)');
  console.error('  --discoverySettleMs <ms> pausa antes de listar candidatos de un estado recién visitado');
  console.error('  --maxStates <n>          tope de estados a descubrir');
  console.error('  --maxSteps <n>           tope duro de interacciones totales');
  console.error('  --include-links          no excluir <a>/[href] de la detección automática (se excluyen por defecto)');
    console.error('  --containerSelector <css> acotar detección y estado a este contenedor (ej. "#sb")');
  process.exit(1);
}


function parseCliOverrides(args) {
  const numericFlags = ['settleMs', 'discoverySettleMs', 'maxStates', 'maxSteps'];
  const overrides = {};
  for (const flag of numericFlags) {
    const idx = args.indexOf(`--${flag}`);
    if (idx >= 0 && args[idx + 1] !== undefined) {
      const value = Number(args[idx + 1]);
      if (Number.isNaN(value)) {
        console.error(`--${flag} espera un número, se recibió "${args[idx + 1]}"`);
        process.exit(1);
      }
      overrides[flag] = value;
    }
  }
    const stringFlags = ['containerSelector'];
  for (const flag of stringFlags) {
    const idx = args.indexOf(`--${flag}`);
    if (idx >= 0 && args[idx + 1] !== undefined) overrides[flag] = args[idx + 1];
  }
  return overrides;
}

function startServer(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url === '/' ? '/index.html' : req.url);
      const filePath = path.join(dir, rel);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
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

(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith('--')) usage();

  const vizDir = path.resolve(args[0]);
  const indexPath = path.join(vizDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.error(`no se encontró ${indexPath}`);
    usage();
  }

  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : vizDir;
  fs.mkdirSync(outDir, { recursive: true });

  const configPath = path.join(vizDir, 'config.js');
  const fileConfig = fs.existsSync(configPath) ? require(configPath) : {};
  const cliOverrides = parseCliOverrides(args);
  const userConfig = { ...fileConfig, ...cliOverrides };

  if (!userConfig.backSelector) {
    console.log(`analizando ${vizDir} -- sin config.js/backSelector -> modo genérico (detección automática, recarga+replay)`);
  } else {
    console.log(`analizando ${vizDir} -- config.js con backSelector -> modo rápido (navegación por ancestro común)`);
  }
  if (Object.keys(cliOverrides).length > 0) {
    console.log('parámetros pisados por línea de comandos:', cliOverrides);
  }

  const instrumentSrc = fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8');
    const includeLinks = args.includes('--include-links');
  const initScripts = [];
  if (includeLinks) {
    initScripts.push('window.__crawlerIncludeLinks = true;');
    console.log('--include-links: los <a>/[href] SÍ se van a detectar como clickeables');
  }
  if (userConfig.containerSelector) {
    initScripts.push(`window.__crawlerContainerSelector = ${JSON.stringify(userConfig.containerSelector)};`);
    console.log(`acotado al contenedor: ${userConfig.containerSelector}`);
  }
  initScripts.push(instrumentSrc);

  const CHECKPOINT_PATH = path.join(outDir, 'checkpoint.json');
  const TRANSITIONS_PATH = path.join(outDir, 'transitions.json');
  const AUTOMATON_SVG_PATH = path.join(outDir, 'automaton.svg');

  const server = await startServer(vizDir);
  const chromePath = await resolveChromePath();

  let resume = null;
  if (fs.existsSync(CHECKPOINT_PATH)) {
    resume = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    console.log(`retomando checkpoint: ${resume.graph.length} estados ya conocidos, ${resume.queue.length} en cola`);
  }

  const t0 = Date.now();

  try {
    if (userConfig.settleMs == null) {
      console.log('tiempo virtual: tras cada click/carga se adelanta el reloj de la página hasta que termina la animación (pasá --settleMs para una pausa fija en tiempo real)');
    }
    const { transitions, initialState, usedManualState, truncated } = await crawl({
      fixtureUrl: `http://localhost:${PORT}/index.html`,
      chromePath,
      initScripts,
      resume,
      ...userConfig,
      onStateExpanded: (state, trans, snapshot) => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[${elapsed}s] estado expandido: "${state}" (${Object.keys(trans).length} acciones) -- total conocido: ${snapshot.graph.length}`);
        fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(snapshot));
      },
    });

    const states = Object.keys(transitions);
    const errorTransitions = [];
    for (const [state, trans] of Object.entries(transitions)) {
      for (const [action, next] of Object.entries(trans)) {
        if (next === ERROR_STATE) errorTransitions.push({ state, action });
      }
    }

    if (truncated) {
      console.log(`\n=== CRAWL INCOMPLETO: se alcanzó maxStates (${states.length} estados) con estados sin expandir ===`);
      console.log('el autómata de abajo es PARCIAL -- volvé a correr con un --maxStates mayor.');
    } else {
      console.log('\n=== CRAWL COMPLETO ===');
    }
    console.log('estado inicial:', initialState);
    console.log('estados descubiertos:', states.length);
    console.log('tiempo de esta corrida:', ((Date.now() - t0) / 1000).toFixed(1), 's');
    console.log('transiciones a ERROR_STATE:', errorTransitions.length);
    if (errorTransitions.length) console.log(JSON.stringify(errorTransitions, null, 2));


    let outState = initialState;
    let outTransitions = transitions;
    if (!usedManualState) {
      const pretty = prettifyStates({ initialState, transitions });
      outState = pretty.initialState;
      outTransitions = pretty.transitions;
      console.log('nombres de estado legibles aplicados (fingerprint automático -> camino de acciones)');
    } else {
      console.log('estado ya legible vía window.__testState -- sin renombrar');
    }
    fs.writeFileSync(TRANSITIONS_PATH, JSON.stringify({ initialState: outState, transitions: outTransitions }, null, 2));
    console.log(`tabla completa guardada en ${TRANSITIONS_PATH}`);

    
    const dfa = fromTransitionsJson({ initialState: outState, transitions: outTransitions });
    const svg = toSVG(dfa, { width: 900, height: 700 });
    fs.writeFileSync(AUTOMATON_SVG_PATH, svg);
    console.log(`diagrama del autómata guardado en ${AUTOMATON_SVG_PATH}`);

    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  } catch (e) {
    console.error('CRAWL INTERRUMPIDO (progreso en checkpoint.json -- volvé a correr con los mismos argumentos para retomar):', e.message || e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
