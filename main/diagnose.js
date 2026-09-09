/**
 * Diagnóstico para cuando el crawler nunca converge (sigue "descubriendo"
 * estados nuevos sin parar). Recarga la MISMA página (sin clickear nada)
 * varias veces seguidas, y compara el fingerprint crudo de cada lectura.
 * Si en la raíz -- sin tocar nada -- el fingerprint ya cambia entre
 * recargas, el problema no es el crawler: es que el estado "observado" no
 * es estable, y hace falta encontrar por qué antes de seguir.
 *
 * Uso:
 *   node diagnose.js <carpeta-con-index.html> [waitMs] [rondas]
 *
 * Ejemplo:
 *   node diagnose.js "C:\...\toyprototype" 1500 6
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

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

// primer punto donde dos lecturas (separadas por ';' = un elemento por
// fragmento) difieren, con contexto, para no tener que leer miles de
// caracteres a mano.
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
  const vizDir = process.argv[2];
  const waitMs = parseInt(process.argv[3], 10) || 500;
  const rounds = parseInt(process.argv[4], 10) || 5;

  if (!vizDir) {
    console.error('Uso: node diagnose.js <carpeta-con-index.html> [waitMs=500] [rondas=5]');
    process.exit(1);
  }

  const resolvedDir = path.resolve(vizDir);
  const instrumentSrc = fs.readFileSync(path.join(__dirname, 'instrument.js'), 'utf8');

  const server = await startServer(resolvedDir);
  const chromePath = await resolveChromePath();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  await page.addInitScript({ content: instrumentSrc });

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

  // Fase 2: la carga inicial puede ser estable, pero lo interesante suele
  // pasar DESPUÉS de un click (una transición D3, una simulación de
  // fuerzas que arranca ahí). Clickeamos el primer candidato una sola vez
  // y medimos el fingerprint en el tiempo, para ver si en algún momento
  // dos lecturas consecutivas coinciden (se "asienta") o si nunca lo hace.
  console.log('\n--- Fase 2: ¿se asienta después de un click? ---\n');

  const browser2 = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page2 = await browser2.newPage({ viewport: { width: 700, height: 700 } });
  await page2.addInitScript({ content: instrumentSrc });
  const server2 = await startServer(resolvedDir);

  await page2.goto(`http://localhost:${PORT}/index.html`);
  await page2.waitForTimeout(waitMs);

  const firstClickable = await page2.locator('[data-crawler-clickable]').first();
  const count = await page2.locator('[data-crawler-clickable]').count();
  if (count === 0) {
    console.log('No se detectó ningún elemento clickeable (¿el selector automático no encontró listeners de click?). Salteando fase 2.');
  } else {
    await firstClickable.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const checkpoints = [100, 300, 600, 1000, 2000, 4000];
    let prev = null;
    let settledAt = null;
    for (const ms of checkpoints) {
      await page2.waitForTimeout(ms - (checkpoints[checkpoints.indexOf(ms) - 1] || 0));
      const buf = await page2.evaluate(() => window.__crawlerStateDebug());
      const changed = prev !== null && buf !== prev;
      console.log(`  +${ms}ms: ${changed ? 'CAMBIÓ respecto a la lectura anterior' : (prev === null ? '(primera lectura)' : 'igual a la lectura anterior')}`);
      if (prev !== null && buf === prev && settledAt === null) settledAt = ms;
      prev = buf;
    }

    console.log('');
    if (settledAt !== null) {
      console.log(`Se asienta alrededor de los ${settledAt}ms. Usá un settleMs/discoverySettleMs por`);
      console.log('encima de ese valor (con margen) en tu config.js y debería converger.');
    } else {
      console.log('NUNCA se asentó en los', checkpoints[checkpoints.length - 1], 'ms que probamos.');
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
