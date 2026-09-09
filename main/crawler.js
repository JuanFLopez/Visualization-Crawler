/**
 * En vez de leer el código de clicked() a mano esto DESCUBRE la tabla de
 * transiciones explorando la visualización corriendo de verdad: desde cada
 * estado alcanzado, prueba cada elemento clickeable, mira a qué estado
 * lleva (o si rompe), y sigue explorando estados nuevos hasta que no queda
 * nada por descubrir.
 *
 * DOS MODOS de navegación entre estados:
 *
 *  - RÁPIDO (con `backSelector`): asume semántica de jerarquía con una
 *    acción determinista de "subir un nivel" (zoom in/out, breadcrumbs).
 *    Navega por ancestro común -- sube al padre común, baja por el resto
 *    del camino -- y nunca recarga la página durante el crawl. Requiere
 *    que el usuario lo indique a mano vía config.js (ver README).
 *
 *  - GENÉRICO (sin `backSelector`, modo por defecto): no asume nada sobre
 *    la semántica. Para volver a un estado, recarga la página y reproduce
 *    el camino completo desde la raíz. Más lento, pero funciona con
 *    cualquier visualización, incluidas las que no tienen un "volver" fijo.
 *
 * DETECCIÓN AUTOMÁTICA (por defecto, sin instrumentar nada a mano): si no
 * se pasan `clickableSelector`/`stateKeyFn`, se usan los que arma
 * instrument.js -- `[data-crawler-clickable]` para candidatos y
 * `window.__crawlerState()` (fingerprint del DOM) para el estado. Si el
 * usuario definió su propio `window.__testState`, ese tiene prioridad
 * (instrumentación manual más precisa).
 *
 * GRAFO DECORADO: cada estado descubierto se guarda en `graph` junto con
 * su camino desde el estado inicial y una marca `visited`. Un estado
 * jamás se vuelve a expandir una vez visitado -- eso es lo único que hace
 * falta para que el crawl termine incluso si el grafo real tiene ciclos.
 * Como red de seguridad adicional, ante un stateKeyFn/fingerprint
 * inestable hay un tope duro de pasos (maxSteps) que aborta en vez de
 * crecer sin límite.
 */

// Paquete completo `playwright` (no `playwright-core`): trae y gestiona su
// propio Chromium multiplataforma -- necesita `npx playwright install
// chromium` una vez, pero después `chromePath` puede quedar undefined y
// funciona igual en Windows/Mac/Linux.
const { chromium } = require('playwright');

const ERROR_STATE = '__ERROR__';

let _unknownCounter = 0;

async function _actionName(el) {
  const name = await el.getAttribute('data-name');
  if (name) return `Click_${name}`;
  const cls = (await el.getAttribute('class')) || '';
  if (cls.includes('center-circle')) return 'Click_BACK';

  // Sin instrumentación manual: buscamos algo humano ya presente en el
  // propio elemento -- <title> hijo (la convención SVG para tooltips,
  // muy común en D3), aria-label, atributo title, o su propio texto. Se
  // chequea EN VIVO al momento de descubrir el candidato (no al momento
  // de detectar el listener), porque en D3 es común que el <title> se
  // agregue en una línea posterior a .on("click", ...).
  const readable = await el.evaluate((node) => {
    const t = node.querySelector(':scope > title');
    if (t && t.textContent.trim()) return t.textContent.trim();
    const aria = node.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const titleAttr = node.getAttribute('title');
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();
    const text = node.textContent && node.textContent.trim();
    if (text && text.length > 0 && text.length <= 40) return text;
    return null;
  });
  if (readable) {
    // si viene como ruta de ancestros ("root / A"), nos quedamos con el
    // último segmento -- el nombre del propio nodo alcanza como acción.
    const cleaned = readable.split('/').pop().trim().replace(/\s+/g, '_');
    if (cleaned) return `Click_${cleaned}`;
  }

  const crawlerId = await el.getAttribute('data-crawler-id');
  if (crawlerId) return `Click_${crawlerId}`;
  return `Click_unknown_${_unknownCounter++}`;
}

async function _selectorFor(el) {
  const name = await el.getAttribute('data-name');
  if (name) return `[data-name="${name}"]`;
  const cls = (await el.getAttribute('class')) || '';
  if (cls.includes('center-circle')) return 'circle.center-circle';
  const crawlerId = await el.getAttribute('data-crawler-id');
  if (crawlerId) return `[data-crawler-id="${crawlerId}"]`;
  throw new Error('elemento clickeable sin identidad estable');
}

/**
 * @param {Object} opts
 * @param {string} opts.fixtureUrl
 * @param {string} [opts.chromePath] - si se omite, usa el Chromium que trae Playwright.
 * @param {string} [opts.clickableSelector='[data-crawler-clickable]']
 * @param {(rawState: any) => string} [opts.stateKeyFn=(raw)=>raw]
 * @param {string[]} [opts.initScripts] - código JS a inyectar antes de que
 *   corra la página del usuario (vía page.addInitScript), p.ej. el
 *   contenido de instrument.js para detección automática.
 * @param {string} [opts.backSelector] - ver modos arriba. Si se omite,
 *   modo genérico (recarga + replay).
 * @param {number} [opts.settleMs] - si se omite (o se pasa explícitamente
 *   null), se calibra automáticamente clickeando un candidato y midiendo
 *   cuándo el estado deja de cambiar (mismo principio que diagnose.js) --
 *   pensado para no depender de un número fijo que varía según la
 *   máquina. Pasar un valor explícito lo saltea.
 * @param {number} [opts.discoverySettleMs] - settle usado específicamente
 *   al re-entrar a un estado antes de listar sus candidatos. Por defecto,
 *   igual al settleMs (calibrado o explícito).
 * @param {number} [opts.maxStates=200]
 * @param {number} [opts.maxSteps=5000] - tope duro de interacciones totales.
 * @param {(state, transitions, snapshot) => void} [opts.onStateExpanded] -
 *   hook de progreso/checkpoint.
 * @param {(settleMs: number) => void} [opts.onCalibrated] - se llama una
 *   vez, solo si hubo que calibrar, con el valor resultante.
 * @param {Object} [opts.resume] - { graph: [[state,node],...], queue: string[], initialState }
 *   generado por un checkpoint previo (ver snapshot en onStateExpanded).
 * @returns {Promise<{transitions: Object, initialState: string}>}
 */
async function crawl({
  fixtureUrl,
  chromePath,
  clickableSelector = '[data-crawler-clickable]',
  stateKeyFn = (raw) => raw,
  initScripts = [],
  backSelector = null,
  settleMs = null,
  discoverySettleMs = null,
  maxStates = 200,
  maxSteps = 5000,
  onStateExpanded = null,
  onCalibrated = null,
  resume = null,
}) {
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  for (const src of initScripts) await page.addInitScript({ content: src });

  let errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  async function clickSelector(sel, wait) {
    errors = [];
    await page.$eval(sel, (el) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    await page.waitForTimeout(wait);
  }

  // única carga de página en modo rápido: al arrancar (o al resumir un
  // checkpoint). En modo genérico, se vuelve a llamar en cada navigateTo().
  async function initialLoad(wait) {
    errors = [];
    await page.goto(fixtureUrl);
    await page.waitForTimeout(wait);
  }

  async function readState() {
    const raw = await page.evaluate(() => {
      if (typeof window.__testState !== 'undefined') return window.__testState;
      if (typeof window.__crawlerState === 'function') return window.__crawlerState();
      return null;
    });
    if (raw === null) {
      throw new Error(
        'no se pudo leer el estado: definí window.__testState en tu código, ' +
        'o pasá instrument.js en initScripts para detección automática.'
      );
    }
    return stateKeyFn(raw);
  }

  // Calibración automática de settleMs: si no vino explícito, medimos
  // cuánto tarda en "asentarse" el estado observado después de un click
  // (mismo principio que diagnose.js) y usamos eso -- así no depende de
  // un número fijo elegido a ojo, que en otra máquina (más lenta/rápida)
  // puede quedar corto o innecesariamente largo.
  async function calibrateSettle() {
    await initialLoad(300);
    const before = await readState();

    const candidatesRaw = await page.locator(clickableSelector).all();
    let firstClickableSel = null;
    for (const el of candidatesRaw) {
      const isActionable = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return cs.pointerEvents !== 'none' && cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      if (isActionable) { firstClickableSel = await _selectorFor(el); break; }
    }
    if (!firstClickableSel) {
      throw new Error(
        'no se detectó ningún elemento clickeable para calibrar settleMs -- ' +
        '¿la visualización llegó a dibujarse? (revisá dependencias externas, ' +
        'CDNs, fetch de datos, etc. -- correr diagnose.js ayuda a ver esto)'
      );
    }

    errors = [];
    await page.$eval(firstClickableSel, (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const checkpoints = [100, 300, 600, 1000, 2000, 4000];
    let prev = null;
    let settledAt = null;
    let elapsed = 0;
    for (const ms of checkpoints) {
      await page.waitForTimeout(ms - elapsed);
      elapsed = ms;
      const cur = await readState();
      if (prev !== null && cur === prev) { settledAt = ms; break; }
      prev = cur;
    }

    if (settledAt === null) {
      throw new Error(
        `el estado observado nunca se asentó en los ${checkpoints[checkpoints.length - 1]}ms de calibración ` +
        `(sigue cambiando después de un click sin volver a repetirse). Esto apunta a una animación o ` +
        `simulación continua (d3-force, algo con requestAnimationFrame corriendo indefinidamente) más que ` +
        `a "hace falta esperar un poco más" -- ahí, la detección automática de estado no es la herramienta ` +
        `correcta: instrumentá window.__testState a mano, capturando solo lo lógicamente relevante. ` +
        `(pasá settleMs explícito para saltear esta calibración si igual querés forzar una corrida).`
      );
    }

    const calibrated = Math.round(settledAt * 1.5) + 200; // margen sobre el punto medido
    await initialLoad(calibrated); // volver a un estado limpio antes de arrancar el crawl real
    const after = await readState();
    if (after !== before) {
      // no debería pasar (recargamos desde cero), pero por las dudas: si
      // ni siquiera la carga inicial es estable, mejor fallar acá con un
      // mensaje claro que dejar que el crawl real explore sin límite.
      throw new Error(
        'el estado inicial no es estable entre recargas (dos cargas limpias de la misma página dieron ' +
        'estados distintos) -- esto no se arregla con settleMs. Correr diagnose.js para más detalle.'
      );
    }
    return calibrated;
  }

  if (settleMs === null) {
    settleMs = await calibrateSettle();
    if (onCalibrated) onCalibrated(settleMs);
  }
  discoverySettleMs = discoverySettleMs ?? settleMs;

  // grafo decorado: state -> { path: selector[], visited: bool, transitions: {} }
  let graph, initialState, queue, currentState;

  if (resume) {
    graph = new Map(resume.graph);
    initialState = resume.initialState;
    queue = [...resume.queue];
    await initialLoad(discoverySettleMs);
    currentState = await readState();
    if (!graph.has(currentState)) {
      throw new Error(
        `el checkpoint no contiene el estado raíz actual ("${currentState}") -- ` +
        `¿la fixture cambió entre corridas?`
      );
    }
  } else {
    graph = new Map();
    await initialLoad(discoverySettleMs);
    initialState = await readState();
    graph.set(initialState, { path: [], visited: false, transitions: {} });
    currentState = initialState;
    queue = [initialState];
  }

  // Navega la página persistente desde currentState hasta target.
  // Con backSelector: sube al ancestro común y baja por el resto del
  // camino, sin recargar. Sin backSelector (modo genérico): recarga y
  // reproduce el camino completo desde la raíz.
  async function navigateTo(target, wait) {
    if (currentState === target) return;

    const targetNode = graph.get(target);
    if (!targetNode) throw new Error(`estado desconocido: ${target}`);

    if (backSelector && currentState !== ERROR_STATE && graph.has(currentState)) {
      const curPath = graph.get(currentState).path;
      const tgtPath = targetNode.path;
      let i = 0;
      while (i < curPath.length && i < tgtPath.length && curPath[i] === tgtPath[i]) i++;
      const upSteps = curPath.length - i;
      const downSelectors = tgtPath.slice(i);

      for (let k = 0; k < upSteps; k++) await clickSelector(backSelector, wait);
      for (const sel of downSelectors) await clickSelector(sel, wait);
      currentState = target;
      return;
    }

    // modo genérico
    await initialLoad(wait);
    for (const sel of targetNode.path) await clickSelector(sel, wait);
    currentState = target;
  }

  let steps = 0;

  while (queue.length > 0 && graph.size < maxStates) {
    const state = queue.shift();
    const node = graph.get(state);
    if (!node || node.visited || state === ERROR_STATE) continue;
    node.visited = true;

    await navigateTo(state, discoverySettleMs);
    const candidatesRaw = await page.locator(clickableSelector).all();
    // Filtro genérico (no específico de D3): un elemento con
    // pointer-events:none, display:none o visibility:hidden no es
    // realmente interactuable AHORA, aunque en algún momento se le haya
    // adjuntado un listener de click (eso es justo lo que pasa con los
    // arcos fuera de foco de un sunburst zoomable). Sin este filtro, el
    // modo automático descubre "transiciones fantasma" que un usuario
    // real nunca podría disparar clickeando.
    const candidates = [];
    for (const el of candidatesRaw) {
      const isActionable = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return cs.pointerEvents !== 'none' && cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      if (isActionable) candidates.push(el);
    }
    const found = [];
    const seenNames = new Set();
    for (const el of candidates) {
      let action = await _actionName(el);
      if (seenNames.has(action)) {
        // colisión de nombres legibles (dos elementos distintos con el
        // mismo texto/último segmento) -- desambiguar con el id estable
        // en vez de perder silenciosamente una transición.
        const crawlerId = await el.getAttribute('data-crawler-id');
        action = crawlerId ? `${action}(${crawlerId})` : `${action}_${_unknownCounter++}`;
      }
      seenNames.add(action);
      found.push([action, await _selectorFor(el)]);
    }

    for (const [action, sel] of found) {
      steps++;
      if (steps > maxSteps) {
        await browser.close();
        throw new Error(
          `maxSteps (${maxSteps}) excedido -- probable estado inestable ` +
          `(rompe la marca de "visitado") o un grafo genuinamente enorme.`
        );
      }

      await navigateTo(state, settleMs); // volver exactamente al estado que se está expandiendo
      await clickSelector(sel, settleMs);
      currentState = null; // desconocido hasta leer

      const nextState = errors.length > 0 ? ERROR_STATE : await readState();
      node.transitions[action] = nextState;
      currentState = nextState;

      if (nextState !== ERROR_STATE && !graph.has(nextState)) {
        graph.set(nextState, { path: [...node.path, sel], visited: false, transitions: {} });
        queue.push(nextState);
      }
    }

    if (onStateExpanded) {
      onStateExpanded(state, node.transitions, {
        graph: Array.from(graph.entries()),
        queue: [...queue],
        initialState,
      });
    }
  }

  await browser.close();

  const transitions = {};
  for (const [state, node] of graph) transitions[state] = node.transitions;
  return { transitions, initialState };
}

module.exports = { crawl, ERROR_STATE };
