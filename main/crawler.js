/**
 * DOS MODOS de navegación entre estados:
 *
 *  - RÁPIDO (con `backSelector`): asume semántica de jerarquía con una
 *    acción determinista de "subir un nivel" (zoom in/out, breadcrumbs).
 *    Navega por ancestro común -- sube al padre común, baja por el resto
 *    del camino -- y nunca recarga la página durante el crawl. Requiere
 *    que el usuario lo indique a mano vía config.js (ver README).
 *
 *  - GENÉRICO (sin `backSelector`, modo por defecto): no asume nada sobre
 *    la semántica. Para volver a un estado usa transiciones ya observadas
 *    si las hay; si no, recarga la página y reproduce el camino completo
 *    desde la raíz. Funciona con cualquier visualización, incluidas las
 *    que no tienen un "volver" fijo.
 *
 * EXPLORACIÓN EN PROFUNDIDAD: cada estado nuevo se expande en el momento
 * en que se lo descubre (la página ya está parada ahí, no hay que
 * navegar). Al terminar, sus transiciones ya son conocidas -- y en casi
 * cualquier visualización zoomable alguna lleva "hacia atrás" -- así que
 * volver al estado anterior rara vez requiere recargar.
 *
 * TIEMPO VIRTUAL (por defecto, sin settleMs): el reloj de la página se
 * reemplaza por uno falso (page.clock de Playwright) y tras cada click se
 * adelanta hasta que la animación termina. Una transición D3 de 750ms se
 * resuelve en unos pocos ms reales, y sin depender de la velocidad de la
 * máquina.
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

const { chromium } = require('playwright');

const ERROR_STATE = '__ERROR__';

let _unknownCounter = 0;

// espera en tiempo virtual (cuando no se pasa settleMs fijo): se salta el
// reloj de a CHUNK_MS y se considera asentado cuando no hay requests en
// vuelo y no se pidió ningún frame de animación en los últimos QUIET_MS
// (virtuales). Cada salto es fastForward, no runFor: dispara cada timer
// vencido UNA vez en lugar de reproducir los ~60 frames intermedios por
// segundo -- una transición D3 llega a su estado final en 2-3 frames,
// que es lo único que mira el fingerprint. Una simulación por ticks
// (d3-force) avanza un tick por salto, de ahí el tope en saltos y no en
// tiempo. La red sí corre en tiempo real: se sondea cada POLL_MS.
const POLL_MS = 20;
const CHUNK_MS = 1000;
const QUIET_MS = 100;
const MAX_CHUNKS = 1000;
const NETWORK_MAX_MS = 15000;

/**
 * Helpers que corren DENTRO de la página. Se instalan con
 * page.addInitScript(installPageHelpers) -- una función autocontenida,
 * sin closures de Node -- para que funcionen aunque no se use
 * instrument.js (instrumentación manual con window.__testState).
 */
function installPageHelpers() {
  // Un elemento es interactuable AHORA si un usuario real podría
  // clickearlo: no basta con que tenga un listener. Además de
  // pointer-events/display/visibility, hace un hit-test real
  // (elementFromPoint) sobre la parte visible del elemento -- recortada
  // al viewport y al <svg> que lo contiene -- así quedan afuera los
  // elementos trasladados fuera del viewBox (los nodos fuera de foco de
  // un icicle/treemap zoomable), los tapados por otro elemento, y los de
  // área nula, sin que la visualización tenga que marcarlos con
  // pointer-events:none como hace el sunburst.
  // Además de si es interactuable, mide `visibleFrac`: qué fracción
  // (aproximada) del elemento cae dentro del <svg> que lo contiene. Un
  // elemento clickeable con visibleFrac < 1 es p.ej. un círculo vecino
  // que asoma en la esquina de un circle pack zoomeado: clickearlo es
  // legítimo, pero esas transiciones "laterales" vuelven denso el grafo
  // (y explosivo el regex), así que el reporte las señala. No cuenta lo
  // que queda fuera de la ventana (se ve scrolleando: un icicle es más
  // alto que el viewport del crawler) ni lo tapado por otros elementos
  // (en un circle pack los hijos tapan al padre y eso no es "no verse").
  // Fuera de un <svg> vale 1. null = no se pudo medir (forma demasiado
  // fina para la grilla).
  function measure(node) {
    const no = { actionable: false, visibleFrac: 0 };
    const cs = getComputedStyle(node);
    if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') return no;

    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = node.getBoundingClientRect();
    let left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    let right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight);

    let svg = node.ownerSVGElement;
    while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
    const frame = svg ? svg.getBoundingClientRect() : null;
    if (frame) {
      left = Math.max(left, frame.left); top = Math.max(top, frame.top);
      right = Math.min(right, frame.right); bottom = Math.min(bottom, frame.bottom);
    }
    // al menos 1x1 px CSS visible: además de no ser clickeable de verdad,
    // por debajo de eso aparecen "astillas" de redondeo (un rect que
    // empieza justo en el borde del <svg> deja 0.001px "adentro")
    if (right - left < 1 || bottom - top < 1) return no;

    const { pts: points, total, inFrame } = samplePoints(node, { left, top, right, bottom }, frame);
    let visibleFrac = 1;
    if (node instanceof SVGGeometryElement) {
      visibleFrac = total > 0 ? inFrame / total : null;
    } else if (frame) {
      const w = Math.min(r.right, frame.right) - Math.max(r.left, frame.left);
      const h = Math.min(r.bottom, frame.bottom) - Math.max(r.top, frame.top);
      visibleFrac = (Math.max(w, 0) * Math.max(h, 0)) / Math.max(r.width * r.height, 1e-9);
    }
    // forma SVG demasiado fina para que caiga algún punto de la grilla
    // adentro: ya sabemos que es visible y está dentro del recorte, así
    // que la damos por clickeable en vez de perder la transición
    if (points.length === 0) return { actionable: node instanceof SVGGeometryElement, visibleFrac };
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === node || node.contains(hit))) return { actionable: true, visibleFrac };
    }
    return no;
  }

  // Puntos de pantalla, dentro de `clip`, donde probar el hit-test. Para
  // formas SVG, solo puntos que caen DENTRO de la forma (isPointInFill):
  // el centro de la caja de un arco de sunburst suele caer en el hueco
  // del anillo, no en el arco; para visibleFrac, `total` cuenta los
  // puntos de la forma antes de recortar e `inFrame` los que caen dentro
  // de `frame` (el <svg>, sin importar la ventana). Para el resto (HTML,
  // <g>), una grilla sobre la parte visible de la caja.
  function samplePoints(node, clip, frame) {
    const N = 5;
    const pts = [];
    let total = 0, inFrame = 0;
    const inClip = (x, y) => x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom;
    const inFrameRect = (x, y) => !frame || (x >= frame.left && x < frame.right && y >= frame.top && y < frame.bottom);
    const m = node instanceof SVGGeometryElement ? node.getScreenCTM() : null;
    if (m) {
      const bb = node.getBBox();
      const cs = getComputedStyle(node);
      const useFill = cs.fill !== 'none';
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const local = new DOMPoint(bb.x + bb.width * (i + 0.5) / N, bb.y + bb.height * (j + 0.5) / N);
          if (!(useFill ? node.isPointInFill(local) : node.isPointInStroke(local))) continue;
          total++;
          const s = local.matrixTransform(m);
          if (inFrameRect(s.x, s.y)) inFrame++;
          if (inClip(s.x, s.y)) pts.push([s.x, s.y]);
        }
      }
      return { pts, total, inFrame };
    }
    const w = clip.right - clip.left, h = clip.bottom - clip.top;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) pts.push([clip.left + w * (i + 0.5) / N, clip.top + h * (j + 0.5) / N]);
    }
    return { pts, total: pts.length, inFrame: pts.length };
  }

  // Lo que hace falta para nombrar una acción, leído EN VIVO al momento
  // de descubrir el candidato (no al momento de detectar el listener),
  // porque en D3 es común que el <title> se agregue en una línea
  // posterior a .on("click", ...).
  // De un <title> solo cuenta la primera línea: el tooltip típico de D3
  // es "flare/vis\n432,629" (ruta + valor), y el valor no identifica al
  // nodo -- solo ensucia el nombre de la acción.
  function titleText(t) {
    if (!t) return null;
    const first = t.textContent.split('\n').map((l) => l.trim()).find(Boolean);
    return first || null;
  }

  function readableOf(node) {
    const own = titleText(node.querySelector(':scope > title'));
    if (own) return own;
    // patrón "celda" de D3: <g><rect (clickeable)/><text/><title/></g> --
    // el tooltip es hermano, no hijo. Solo si el padre es un <g>: más
    // arriba ya no describe a este elemento en particular.
    const parent = node.parentElement;
    if (parent && parent.tagName.toLowerCase() === 'g') {
      const pt = titleText(parent.querySelector(':scope > title'));
      if (pt) return pt;
    }
    const aria = node.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const titleAttr = node.getAttribute('title');
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();
    const text = node.textContent && node.textContent.trim();
    if (text && text.length > 0 && text.length <= 40) return text;
    return datumText(node);
  }

  // Nombre a partir del dato que D3 ligó al elemento (`__data__`, lo que
  // setean .data() y .datum()). Hace falta cuando el elemento clickeable
  // no tiene <title> ni texto propio y la etiqueta visible es OTRO
  // elemento ligado al mismo dato -- p.ej. el circle pack: los <circle>
  // y los <text> están en grupos separados, unidos solo por el dato.
  // Para un nodo de d3.hierarchy se arma el camino de ancestros
  // ("flare/vis/data"), con la misma forma que los tooltips típicos, así
  // _nameOptions elige el sufijo más corto que no esté tomado.
  function datumText(node) {
    const d = node.__data__;
    if (d == null || typeof d !== 'object') return nameOfDatum(d);
    if (typeof d.depth === 'number' && 'parent' in d && d.data != null) {
      const parts = [];
      for (let x = d; x; x = x.parent) {
        const n = nameOfDatum(x.data);
        if (n == null) break;
        parts.unshift(n);
      }
      return parts.length ? parts.join('/') : null;
    }
    // d3.pie y similares envuelven el dato original en .data
    return nameOfDatum(d) ?? (d.data != null ? nameOfDatum(d.data) : null);
  }

  function nameOfDatum(d) {
    if (typeof d === 'number') return String(d);
    if (typeof d === 'string') return d.trim() || null;
    if (d == null || typeof d !== 'object') return null;
    for (const k of ['name', 'label', 'title', 'id', 'key', 'text']) {
      const v = d[k];
      if (typeof v === 'number' || (typeof v === 'string' && v.trim())) return String(v).trim();
    }
    return null;
  }

  window.__crawlerIsActionable = function (node) {
    const sx = window.scrollX, sy = window.scrollY;
    const ok = measure(node).actionable;
    window.scrollTo(sx, sy);
    return ok;
  };

  // todos los candidatos interactuables en UNA sola ida y vuelta al
  // browser (con cientos de elementos, consultar uno por uno desde Node
  // domina el tiempo de cada estado).
  window.__crawlerCandidates = function (selector) {
    const sx = window.scrollX, sy = window.scrollY;
    const out = [];
    for (const node of document.querySelectorAll(selector)) {
      const { actionable, visibleFrac } = measure(node);
      if (!actionable) continue;
      out.push({
        dataName: node.getAttribute('data-name'),
        cls: node.getAttribute('class') || '',
        crawlerId: node.getAttribute('data-crawler-id'),
        readable: readableOf(node),
        tag: node.tagName.toLowerCase(),
        // el <svg> exterior con su propio click: en D3 suele ser "click en
        // el fondo" (p.ej. alejar el zoom hasta la raíz en el circle pack)
        isRootSvg: node instanceof SVGSVGElement && !node.ownerSVGElement,
        visibleFrac,
      });
    }
    window.scrollTo(sx, sy);
    return out;
  };
}

// Nombres posibles para la acción, del más corto al más específico.
function _nameOptions(info) {
  if (info.dataName) return [info.dataName];
  if (info.cls.includes('center-circle')) return ['BACK'];

  const options = [];

  if (info.readable) {

    const segments = info.readable
      .replace(/\s+[-+]?\d[\d.,]*%?$/, '') 
      .split('/')
      .map((s) => s.trim().replace(/\s+/g, '_'))
      .filter(Boolean);
    for (let k = 1; k <= segments.length; k++) options.push(segments.slice(-k).join('/'));
  } else if (info.isRootSvg) {
    options.push('background');
  }
  if (info.crawlerId) options.push(info.crawlerId);
  return options;
}

// Un elemento cuyo nombre legible CAMBIA según el estado no puede llevar
// ninguno de esos nombres: el símbolo es del elemento, no del estado. El
// caso típico es el círculo central del sunburst, al que cada click le
// re-liga como dato el padre del foco (parent.datum(p.parent)) -- en cada
// estado "dice" otro nodo. Al terminar el crawl, esas acciones pasan a
// llamarse por su etiqueta SVG/HTML ("Click_circle"). Se lee de
// node.labels, que guarda lo visto en cada estado (y viaja en el
// checkpoint, así que funciona también al retomar).
function renameUnstableActions(graph) {
  const seen = new Map(); // acción -> { readables: Set, tag }
  for (const node of graph.values()) {
    for (const [action, { readable, tag }] of Object.entries(node.labels || {})) {
      if (!seen.has(action)) seen.set(action, { readables: new Set(), tag });
      seen.get(action).readables.add(readable);
    }
  }
  const taken = new Set();
  for (const node of graph.values()) for (const a of Object.keys(node.transitions)) taken.add(a);

  const rename = new Map();
  for (const [action, { readables, tag }] of seen) {
    if (readables.size < 2) continue;
    // '#n' y no '_n': lib/names.js saca los sufijos "_<número>"
    let name = `Click_${tag}`;
    for (let k = 2; taken.has(name); k++) name = `Click_${tag}#${k}`;
    taken.delete(action);
    taken.add(name);
    rename.set(action, name);
  }
  if (rename.size === 0) return rename;

  const renameKeys = (obj) => {
    if (!obj) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[rename.get(k) ?? k] = v;
    return out;
  };
  for (const node of graph.values()) {
    node.transitions = renameKeys(node.transitions);
    node.selectors = renameKeys(node.selectors);
    node.visibility = renameKeys(node.visibility);
    node.labels = renameKeys(node.labels);
  }
  return rename;
}

// El nombre de una acción es del ELEMENTO, no del estado: el mismo
// elemento tiene que ser el mismo símbolo del alfabeto en todos los
// estados (si no, el autómata y su regex no significan nada). Por eso
// se asigna una sola vez por crawl y se reusa.
function createNaming(graph = null) {
  const bySelector = new Map();
  const taken = new Set();
  // al retomar un checkpoint, respetar los nombres ya usados
  if (graph) {
    for (const [, node] of graph) {
      for (const [action, sel] of Object.entries(node.selectors || {})) {
        bySelector.set(sel, action);
        taken.add(action);
      }
    }
  }
  return function nameFor(info, sel) {
    if (bySelector.has(sel)) return bySelector.get(sel);
    let name = null;
    for (const opt of _nameOptions(info)) {
      if (!taken.has(`Click_${opt}`)) { name = `Click_${opt}`; break; }
    }
    if (!name) name = `Click_unknown_${_unknownCounter++}`;
    bySelector.set(sel, name);
    taken.add(name);
    return name;
  };
}

function _selectorFor(info) {
  if (info.dataName) return `[data-name="${info.dataName}"]`;
  if (info.cls.includes('center-circle')) return 'circle.center-circle';
  if (info.crawlerId) return `[data-crawler-id="${info.crawlerId}"]`;
  throw new Error('elemento clickeable sin identidad estable');
}

// Filtro genérico de "interactuable ahora" para un locator suelto (lo usa
// diagnose.js). Requiere installPageHelpers en la página.
function isActionable(locator) {
  return locator.evaluate((node) => window.__crawlerIsActionable(node));
}

// Candidatos interactuables del estado actual, ya nombrados:
// [[accion, selector, info], ...]. Requiere installPageHelpers en la página.
async function discoverCandidates(page, clickableSelector, nameFor) {
  const infos = await page.evaluate((sel) => window.__crawlerCandidates(sel), clickableSelector);
  return infos.map((info) => {
    const sel = _selectorFor(info);
    return [nameFor(info, sel), sel, info];
  });
}

/**
 * Clickea `sel` y mide cuándo deja de cambiar el estado: lee cada
 * `pollMs` y considera "asentado" cuando pasan `quietMs` sin cambios.
 * Devuelve el instante (ms desde el click) del último cambio observado,
 * o null si sigue cambiando al llegar a `maxMs`. Lo usa diagnose.js.
 */
async function measureSettle(page, sel, readFn, { pollMs = 50, quietMs = 400, maxMs = 6000, onChange = null } = {}) {
  let prev = await readFn();
  await page.$eval(sel, (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const t0 = Date.now();
  let lastChange = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(pollMs);
    const cur = await readFn();
    const now = Date.now() - t0;
    if (cur !== prev) {
      lastChange = now;
      prev = cur;
      if (onChange) onChange(now);
    } else if (now - lastChange >= quietMs) {
      return lastChange;
    }
  }
  return null;
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
 * @param {number} [opts.settleMs] - pausa FIJA tras cada click. Si se
 *   omite (o es null), la espera es adaptativa: después de cada click o
 *   carga se espera hasta que el estado deja de cambiar, no quedan
 *   requests en vuelo y no se piden frames de animación (ver
 *   window.__crawlerActivity en instrument.js) -- así no depende de un
 *   número elegido a ojo, ni de qué elemento se clickee para medirlo.
 * @param {number} [opts.discoverySettleMs] - settle usado específicamente
 *   al re-entrar a un estado antes de listar sus candidatos. Por defecto,
 *   igual al settleMs (fijo o adaptativo).
 * @param {number} [opts.maxStates=1000] - si se alcanza, el resultado se
 *   devuelve con `truncated: true`.
 * @param {number} [opts.maxSteps=20000] - tope duro de interacciones totales.
 * @param {(state, transitions, snapshot) => void} [opts.onStateExpanded] -
 *   hook de progreso/checkpoint.
 * @param {Object} [opts.resume] - { graph: [[state,node],...], queue: string[], initialState }
 *   generado por un checkpoint previo (ver snapshot en onStateExpanded).
 * @returns {Promise<{transitions: Object, initialState: string, visibility: Object, renamed: Object, usedManualState: boolean, truncated: boolean}>}
 *   visibility: estado -> acción -> fracción visible, solo para los clicks sobre
 *   elementos que se veían en parte (ver measure en installPageHelpers)
 *   renamed: acción -> nuevo nombre, para las que mostraban un nombre distinto
 *   según el estado (ver renameUnstableActions)
 *   labels: estado -> acción -> nombre legible completo del elemento EN ese
 *   estado (p.ej. "flare/vis/operator"); lib/labels.js lo usa para nombrar
 *   los estados por su lugar en la jerarquía
 */
async function crawl(opts) {
  const browser = await chromium.launch({
    executablePath: opts.chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    return await _crawl(browser, opts);
  } finally {
    await browser.close();
  }
}

async function _crawl(browser, {
  fixtureUrl,
  containerSelector = null,
  clickableSelector = containerSelector ? `${containerSelector} [data-crawler-clickable]` : '[data-crawler-clickable]',
  stateKeyFn = (raw) => raw,
  initScripts = [],
  backSelector = null,
  settleMs = null,
  discoverySettleMs = null,
  maxStates = 1000,
  maxSteps = 20000,
  onStateExpanded = null,
  resume = null,
}) {
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  discoverySettleMs = discoverySettleMs ?? settleMs;
  if (settleMs == null || discoverySettleMs == null) await page.clock.install();
  await page.addInitScript(installPageHelpers);
  for (const src of initScripts) await page.addInitScript({ content: src });

  let errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {})); 

  let usedManualState = false; 

  async function readState() {
    const state = await page.evaluate(() => {
      try {
        if (typeof window.__testState !== 'undefined') return { raw: window.__testState, manual: true };
        if (typeof window.__crawlerState === 'function') return { raw: window.__crawlerState(), manual: false };
        return null;
      } catch (e) {
      
        return { raw: `estado ilegible: ${e.message}`, unreadable: true };
      }
    });
    if (state === null) {
      throw new Error(
        'no se pudo leer el estado: definí window.__testState en tu código, ' +
        'o pasá instrument.js en initScripts para detección automática.'
      );
    }
    if (state.unreadable) throw new Error(state.raw);
    if (state.manual) usedManualState = true;
    return stateKeyFn(state.raw);
  }

  function activity() {
    return page.evaluate(() => (typeof window.__crawlerActivity === 'function'
      ? window.__crawlerActivity()
      : { pendingRequests: 0, msSinceFrame: Infinity }));
  }

  async function virtualSettle() {
    const t0 = Date.now();
    let chunks = 0;
    for (;;) {
      const a = await activity();
      if (a.pendingRequests > 0) {
        if (Date.now() - t0 > NETWORK_MAX_MS) {
          throw new Error(`hay requests que no vuelven después de ${NETWORK_MAX_MS}ms (¿un recurso externo caído?)`);
        }
        await page.waitForTimeout(POLL_MS);
        continue;
      }
      if (chunks > 0 && a.msSinceFrame >= QUIET_MS) return;
      if (chunks >= MAX_CHUNKS) {
        throw new Error(
          `la página siguió animando ${MAX_CHUNKS * CHUNK_MS / 1000}s (virtuales) después de una interacción. Esto apunta ` +
          `a una animación continua (algo con requestAnimationFrame corriendo indefinidamente) más que a ` +
          `"hace falta esperar un poco más" -- ahí, la detección automática de estado no es la herramienta ` +
          `correcta: instrumentá window.__testState a mano, capturando solo lo lógicamente relevante ` +
          `(o pasá --settleMs fijo para forzar una corrida en tiempo real).`
        );
      }
      await page.clock.fastForward(CHUNK_MS);
      chunks++;
    }
  }


  function settle(wait) {
    return wait == null ? virtualSettle() : page.waitForTimeout(wait);
  }

  async function clickSelector(sel, wait) {
    errors = [];
    await page.$eval(sel, (el) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    await settle(wait);
  }


  async function initialLoad(wait) {
    errors = [];
    await page.goto(fixtureUrl);
    await settle(wait);
  }

  if (!resume) {
    await initialLoad(discoverySettleMs);
    const first = await readState();
    await initialLoad(discoverySettleMs);
    if ((await readState()) !== first) {
      throw new Error(
        'el estado inicial no es estable entre recargas (dos cargas limpias de la misma página dieron ' +
        'estados distintos) -- esto no se arregla con settleMs. Correr diagnose.js para más detalle.'
      );
    }
  }

  // grafo decorado: state -> { path: selector[], visited: bool, transitions: {}, selectors: {} }
  // (selectors: acción -> selector, para poder rehacer transiciones ya
  // conocidas al navegar sin recargar; ver knownRoute)
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
    initialState = await readState();
    graph.set(initialState, { path: [], visited: false, transitions: {}, selectors: {} });
    currentState = initialState;
    queue = [initialState];
  }

  const nameFor = createNaming(graph);


  function knownRoute(from, to) {
    if (!graph.has(from)) return null;
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length > 0) {
      const s = q.shift();
      if (s === to) break;
      const n = graph.get(s);
      if (!n || !n.selectors) continue; // checkpoints viejos no guardaban selectores
      for (const [action, next] of Object.entries(n.transitions)) {
        if (next === ERROR_STATE || prev.has(next) || !n.selectors[action]) continue;
        prev.set(next, [s, n.selectors[action]]);
        q.push(next);
      }
    }
    if (!prev.has(to)) return null;
    const route = [];
    for (let step = prev.get(to); step; step = prev.get(step[0])) route.unshift(step[1]);
    return route;
  }


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
    if (currentState && currentState !== ERROR_STATE) {
      const route = knownRoute(currentState, target);
      if (route && route.length <= targetNode.path.length) {
        for (const sel of route) await clickSelector(sel, wait);
        if (errors.length === 0 && (await readState()) === target) {
          currentState = target;
          return;
        }
       
      }
    }
    await initialLoad(wait);
    for (const sel of targetNode.path) await clickSelector(sel, wait);
    currentState = target;
  }

  let steps = 0;

  function snapshot() {
    return {
      graph: Array.from(graph.entries()),
      
      queue: [...graph.keys()].filter((s) => !graph.get(s).expanded),
      initialState,
    };
  }

  // Expande `state` y, en profundidad, cada estado nuevo que descubra.
  async function expand(state) {
    const node = graph.get(state);
    node.visited = true;
    node.selectors = node.selectors || {};

    await navigateTo(state, discoverySettleMs);
    const found = await discoverCandidates(page, clickableSelector, nameFor);

    for (const [action, sel, { visibleFrac, readable, tag }] of found) {
      if (action in node.transitions) continue;
      node.labels = node.labels || {};
      node.labels[action] = { readable, tag };
      // solo las que se ven en parte (redondeadas a 2 decimales): son las
      // que el reporte señala (ver measure en installPageHelpers)
      if (visibleFrac != null && Math.round(visibleFrac * 100) < 100) {
        node.visibility = node.visibility || {};
        node.visibility[action] = Math.round(visibleFrac * 100) / 100;
      }
      steps++;
      if (steps > maxSteps) {
        throw new Error(
          `maxSteps (${maxSteps}) excedido -- probable estado inestable ` +
          `(rompe la marca de "visitado") o un grafo genuinamente enorme.`
        );
      }

      await navigateTo(state, settleMs); 
      await clickSelector(sel, settleMs);
      currentState = null; 

      const nextState = errors.length > 0 ? ERROR_STATE : await readState();
      node.transitions[action] = nextState;
      node.selectors[action] = sel;
      currentState = nextState;

      if (nextState !== ERROR_STATE && !graph.has(nextState)) {
        graph.set(nextState, { path: [...node.path, sel], visited: false, transitions: {}, selectors: {} });
        if (graph.size <= maxStates) await expand(nextState);
      }
    }

    node.expanded = true;
    if (onStateExpanded) onStateExpanded(state, node.transitions, snapshot());
  }

  
  for (const node of graph.values()) {
    if (node.expanded === undefined) node.expanded = node.visited;
    if (!node.expanded) node.visited = false;
  }
  for (const state of [initialState, ...queue]) {
    const node = graph.get(state);
    if (node && !node.visited) await expand(state);
  }

  // quedaron estados descubiertos sin expandir: corte por maxStates
  const truncated = [...graph.values()].some((n) => !n.expanded);
  const renamed = Object.fromEntries(renameUnstableActions(graph));

  const transitions = {};
  const visibility = {};
  const labels = {};
  for (const [state, node] of graph) {
    transitions[state] = node.transitions;
    if (node.visibility) visibility[state] = node.visibility;
    if (node.labels) {
      labels[state] = {};
      for (const [action, { readable }] of Object.entries(node.labels)) labels[state][action] = readable;
    }
  }
  return { transitions, initialState, visibility, labels, renamed, usedManualState, truncated };
}

module.exports = { crawl, ERROR_STATE, installPageHelpers, isActionable, measureSettle };
