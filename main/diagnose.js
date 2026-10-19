/**
 * Diagnoses why the crawler cannot converge on a visualization:
 *   phase 1  reloads the page several times without clicking anything and
 *            compares the state fingerprints (is the starting state stable?);
 *   phase 2  clicks the first candidate that changes something and measures
 *            how long the page takes to settle (or whether it never does).
 *
 * Usage: node diagnose.js <folder-with-index.html> [waitMs=500] [rounds=5] [--containerSelector <css>]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { installPageHelpers, isActionable, measureSettle } = require('./crawler');

const PORT = 8935;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };

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

// First point where two readings differ (';' separates one element per
// fragment), with context, so thousands of characters need not be read by hand.
function firstDifference(a, b) {
  const partsA = a.split(';');
  const partsB = b.split(';');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    if (partsA[i] !== partsB[i]) {
      return { index: i, a: partsA[i] ?? '(no existe)', b: partsB[i] ?? '(no existe)' };
    }
  }
  return null;
}

(async () => {
  const args = process.argv.slice(2);
  const csIdx = args.indexOf('--containerSelector');
  const containerSelector = csIdx >= 0 ? args.splice(csIdx, 2)[1] : null;
  const vizDir = args[0];
  const waitMs = parseInt(args[1], 10) || 500;
  const rounds = parseInt(args[2], 10) || 5;

  if (!vizDir) {
    console.error('Uso: node diagnose.js <carpeta-con-index.html> [waitMs=500] [rondas=5] [--containerSelector <css>]');
    process.exit(1);
  }

  const resolvedDir = path.resolve(vizDir);
  const instrumentSrc = fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8');
  const initScripts = [];
  if (containerSelector) {
    initScripts.push(`window.__crawlerContainerSelector = ${JSON.stringify(containerSelector)};`);
  }
  initScripts.push(instrumentSrc);

  const server = await startServer(resolvedDir);
  const chromePath = await resolveChromePath();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  for (const src of initScripts) await page.addInitScript({ content: src });

  console.log(`recargando ${resolvedDir} ${rounds} veces, esperando ${waitMs}ms cada vez, sin clickear nada...\n`);

  const bufs = [];
  for (let i = 0; i < rounds; i++) {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForTimeout(waitMs);
    const buf = await page.evaluate(() => window.__crawlerStateDebug());
    bufs.push(buf);
    console.log(`ronda ${i + 1}: ${buf.length} caracteres de fingerprint`);
  }

  await browser.close();
  server.close();

  const allSame = bufs.every((b) => b === bufs[0]);

  console.log('');
  if (allSame) {
    console.log('ESTABLE en carga inicial: las', rounds, 'lecturas sin clickear nada son idénticas.');
  } else {
    console.log('INESTABLE ya en la carga inicial: el fingerprint cambia entre recargas SIN CLICKEAR NADA.');
    console.log('Esto confirma que el problema no es el crawler -- es que ni el estado de arranque');
    console.log('se repite, así que ninguna estrategia de crawling puede converger.\n');

    for (let i = 1; i < bufs.length; i++) {
      const diff = firstDifference(bufs[0], bufs[i]);
      if (diff) {
        console.log(`Primera diferencia entre ronda 1 y ronda ${i + 1} (elemento #${diff.index}):`);
        console.log('  ronda 1:', diff.a);
        console.log(`  ronda ${i + 1}:`, diff.b);
        console.log('');
      }
    }
  }

  // Phase 2: the initial load may be stable, yet what matters usually happens
  // AFTER a click (a D3 transition, a force simulation that starts there). The
  // first candidate is clicked once and the fingerprint is measured over time,
  // to see whether two consecutive readings ever match (it "settles") or never do.
  console.log('\n--- Fase 2: ¿se asienta después de un click? ---\n');

  const browser2 = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page2 = await browser2.newPage({ viewport: { width: 700, height: 700 } });
  await page2.addInitScript(installPageHelpers);
  for (const src of initScripts) await page2.addInitScript({ content: src });
  let pageErrors = 0;
  page2.on('pageerror', () => pageErrors++);
  const server2 = await startServer(resolvedDir);

  await page2.goto(`http://localhost:${PORT}/index.html`);
  await page2.waitForTimeout(waitMs);

  const clickableSelector = containerSelector
    ? `${containerSelector} [data-crawler-clickable]`
    : '[data-crawler-clickable]';
  const all = await page2.locator(clickableSelector).all();
  const actionable = [];
  for (const el of all) if (await isActionable(el)) actionable.push(el);
  console.log(`clickeables detectados: ${all.length} (${actionable.length} interactuables ahora)`);

  if (actionable.length === 0) {
    console.log('No se detectó ningún elemento clickeable interactuable (¿el selector automático no encontró listeners de click?). Salteando fase 2.');
  } else {
    // The first candidate may be a no-op (or may break: the root rect of an
    // icicle in the root state), so try until one changes something.
    const maxMs = 6000;
    const maxTries = Math.min(actionable.length, 10);
    let settledAt = 0;
    for (let i = 0; i < maxTries && settledAt === 0; i++) {
      const id = await actionable[i].getAttribute('data-crawler-id');
      const errorsBefore = pageErrors;
      settledAt = await measureSettle(
        page2,
        `[data-crawler-id="${id}"]`,
        () => page2.evaluate(() => window.__crawlerState()),
        { maxMs, onChange: (ms) => console.log(`  +${ms}ms: CAMBIÓ`) }
      );
      if (settledAt === 0) {
        const why = pageErrors > errorsBefore ? 'tiró un error en la página' : 'no cambió nada observable';
        console.log(`candidato ${id}: ${why}, probando el siguiente...`);
      }
    }

    console.log('');
    if (settledAt === 0) {
      console.log(`Ninguno de los primeros ${maxTries} candidatos cambió algo observable.`);
    } else if (settledAt !== null) {
      console.log(`Se asienta a los ~${settledAt}ms (último cambio observado). crawler.js no necesita este número`);
      console.log(`(usa tiempo virtual); si querés una pausa fija en tiempo real, usá algo por encima, p.ej. --settleMs ${Math.round(settledAt * 1.5) + 200}.`);
    } else {
      console.log('NUNCA se asentó en los', maxMs, 'ms que probamos.');
      console.log('Esto apunta a una animación/simulación continua (d3-force, algo con requestAnimationFrame');
      console.log('corriendo indefinidamente) más que a "hace falta esperar un poco más". Ahí, el fingerprint');
      console.log('automático basado en atributos del DOM no es la herramienta correcta: hace falta');
      console.log('window.__testState manual que capture SOLO lo que lógicamente importa (qué está');
      console.log('seleccionado/expandido), ignorando posiciones en píxeles que nunca se repiten exacto.');
    }
  }

  await browser2.close();
  server2.close();
})();
