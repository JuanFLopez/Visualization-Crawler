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
 *
 * HOVER: además de los clicks se prueban los elementos que reaccionan a que
 * el puntero entre o se mueva sobre ellos, con un puntero simulado por
 * eventos (como los clicks: no se mueve el mouse del browser). Se los
 * encuentra por un addEventListener (lo que hace selection.on de D3), por un
 * handler en la propiedad o el atributo, por un :hover de las hojas de
 * estilo (el estado se FUERZA por el protocolo de DevTools, ver
 * forceCssHover), y por un listener delegado en un contenedor, probando las
 * marcas de D3 que tiene adentro. Un hover entra al autómata solo si
 * cambia algo visible -- un hover que no hace nada, o sobre algo que un
 * usuario no podría tocar, no es una interacción y no se inventa. Si es un
 * resaltado o un tooltip es una acción más del mismo estado (un bucle) con
 * su efecto anotado; si abre algo o deja un cambio, lleva a otro estado, con
 * su unhover de vuelta. Los de movimiento se prueban en el centro y en el
 * borde, y se avisa si el efecto depende de dónde se apunta. Ver lib/hovers.js.
 * El tooltip nativo del navegador (un <title>) no cambia el DOM, así que no
 * se puede verificar: es opt-in (nativeTooltips).
 */

const { chromium } = require('playwright');
const { actionName, internalName, kindOfAction, unhoverOf } = require('./lib/actions');
const { classifyProbe, describeEffect, selfKeyOf } = require('./lib/hovers');
const { hoverTargets, isVisualProperty } = require('./lib/cssHover');

const ERROR_STATE = '__ERROR__';

let _unknownCounter = 0;

// Una ACCIÓN (el símbolo del alfabeto, "Click_vis") se ejecuta con un
// GESTO: { kind, sel }, el tipo de interacción y el selector del elemento
// sobre el que se hace. Guardar el tipo es lo que permite que la
// navegación entre estados solo reproduzca gestos, sin saber de qué clase son.
const click = (sel) => ({ kind: 'click', sel });
const unhover = (sel) => ({ kind: 'unhover', sel });
const gestureKey = (g) => `${g.kind}:${g.sel}`;

// El :hover de CSS: un puntero simulado con eventos no lo dispara, así que se
// lo FUERZA por el protocolo de DevTools (CSS.forcePseudoState) sobre el
// elemento y todos sus ancestros, como haría un puntero real -- sin mover
// ningún mouse, así que no queda una posición escondida. Dos cosas que se
// comprobaron y que importan:
//  - DOM.getDocument se pide UNA vez por documento: pedirlo de nuevo invalida
//    los nodeId, el estado forzado queda huérfano y ya no se puede limpiar.
//  - Por eso se limpia con los nodeId guardados al forzar, no volviendo a buscarlos.
// Solo corre en páginas con reglas :hover (window.__crawlerCssHover); en el
// resto no se abre ni la sesión.
const cssHoverState = new WeakMap(); // page -> { cdp, rootId, forced: nodeId[] } | false (sin CDP)

async function cssHoverSession(page) {
  if (cssHoverState.has(page)) return cssHoverState.get(page);
  let session = false;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    session = { cdp, rootId: null, forced: [] };
    cdp.on('DOM.documentUpdated', () => { session.rootId = null; session.forced = []; });
  } catch (e) {
    session = false;
  }
  cssHoverState.set(page, session);
  return session;
}

// fuerza :hover sobre los nodos que __crawlerHover marcó (data-crawler-hover)
async function forceCssHover(page) {
  const session = await cssHoverSession(page);
  if (!session) return false;
  const marked = async () => {
    if (session.rootId == null) session.rootId = (await session.cdp.send('DOM.getDocument', { depth: 0 })).root.nodeId;
    return session.cdp.send('DOM.querySelectorAll', { nodeId: session.rootId, selector: '[data-crawler-hover]' });
  };
  let nodeIds;
  try {
    ({ nodeIds } = await marked());
  } catch (e) {
    session.rootId = null; // el documento cambió sin avisar: se pide de nuevo (no hay nada forzado todavía)
    ({ nodeIds } = await marked());
  }
  for (const nodeId of nodeIds) await session.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  session.forced = nodeIds;
  return true;
}

async function clearCssHover(page) {
  const session = cssHoverState.get(page);
  if (!session || session.forced.length === 0) return;
  for (const nodeId of session.forced) {
    await session.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); // el nodo pudo desaparecer
  }
  session.forced = [];
}

// una carga nueva borra todo lo forzado y los nodeId
function resetCssHover(page) {
  const session = cssHoverState.get(page);
  if (session) { session.rootId = null; session.forced = []; }
}

// cómo se ejecuta cada tipo de gesto sobre el elemento `sel`. hover da
// false si el elemento ya no es interactuable (ver __crawlerHover), y acepta
// { where: 'edge' } para apuntar lejos del centro; unhover no usa `sel`: el
// puntero sabe dónde está
const PERFORM = {
  click: (page, sel) => page.$eval(sel, (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }),
  hover: async (page, sel, opts) => {
    await clearCssHover(page); // si el puntero estaba en otro lado
    // al reproducir un camino este puede ser el primer hover de la carga: las reglas :hover se miran antes
    const ok = await page.evaluate(([s, where]) => {
      window.__crawlerScanCss();
      return window.__crawlerHover(s, where);
    }, [sel, opts && opts.where]);
    if (ok && (await page.evaluate(() => window.__crawlerCssHover === true))) await forceCssHover(page);
    return ok;
  },
  unhover: async (page) => {
    await clearCssHover(page);
    return page.evaluate(() => window.__crawlerUnhover());
  },
};

// Los checkpoints anteriores guardaban el camino y los selectores como
// strings (todo eran clicks). Sobre un nodo ya en el formato nuevo no hace nada.
function upgradeGestures(node) {
  const asGesture = (g) => (typeof g === 'string' ? click(g) : g);
  node.path = node.path.map(asGesture);
  if (node.selectors) {
    node.gestures = Object.fromEntries(Object.entries(node.selectors).map(([action, g]) => [action, asGesture(g)]));
    delete node.selectors;
  }
}

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
  function measure(node, far = false) {
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
    // `point`: dónde estaría el puntero de un usuario real, el punto que
    // da en el elemento más cercano al centro de lo visible
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    if (points.length === 0) return { actionable: node instanceof SVGGeometryElement, visibleFrac, point: [cx, cy] };
    points.sort(([ax, ay], [bx, by]) => Math.hypot(ax - cx, ay - cy) - Math.hypot(bx - cx, by - cy));
    // `far`: el punto más lejos del centro que igual da en el elemento, para la
    // segunda muestra de un hover cuyo efecto depende de dónde se apunta
    for (const [x, y] of far ? points.slice().reverse() : points) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === node || node.contains(hit))) return { actionable: true, visibleFrac, point: [x, y] };
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

  // Un selector para un elemento SIN data-crawler-id: los que recién se
  // encuentran al descubrir candidatos (handlers inline, reglas :hover, marcas
  // de un listener delegado). Los ids del crawler salen de un contador al
  // registrar el listener, en el orden de la carga; asignarlos más tarde daría
  // ids que dependen del camino recorrido y que no existen tras recargar y
  // reproducir. Este selector, en cambio, depende solo del DOM.
  function stableSelector(el) {
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
    const id = el.getAttribute('data-crawler-id');
    if (id) return `[data-crawler-id="${id}"]`;
    if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n !== el && n.id && unique(`#${CSS.escape(n.id)}`)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const tag = n.tagName.toLowerCase();
      const sameTag = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [n];
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(n) + 1})` : tag);
      if (n === document.documentElement) break;
    }
    return parts.join(' > ');
  }

  // Las reglas :hover de las hojas de estilo -> qué elementos reciben el hover
  // (el parser es lib/cssHover.js, inyectado como window.__crawlerHoverTargets).
  // Una regla que solo declara cursor, transition y similares no cambia cómo
  // se ve nada, y se descarta acá. Las hojas de otro origen no se pueden leer
  // (SecurityError): se cuentan en window.__crawlerCssBlocked. Solo se vuelve a
  // calcular si cambiaron las hojas. Deja window.__crawlerCssHover en true si
  // hay alguna regla: es lo que le avisa a la instantánea de efectos que mire
  // también los estilos calculados.
  let cssSignature = null;
  let cssTargets = [];
  window.__crawlerScanCss = function () {
    if (typeof window.__crawlerHoverTargets !== 'function') return [];
    let blocked = 0;
    const sheets = [...document.styleSheets].map((sheet) => {
      try { return sheet.cssRules; } catch (e) { blocked++; return null; }
    });
    const signature = sheets.map((rules) => (rules ? rules.length : -1)).join(',');
    if (signature === cssSignature) return cssTargets;

    const found = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.STYLE_RULE) {
          if (!rule.selectorText.includes(':hover')) continue;
          let visual = false;
          for (let i = 0; i < rule.style.length && !visual; i++) visual = window.__crawlerIsVisualProperty(rule.style[i]);
          if (visual) for (const target of window.__crawlerHoverTargets(rule.selectorText)) found.add(target);
        } else if (rule.cssRules) {
          // @media / @supports / @layer: solo si aplica ahora
          if (rule.type === CSSRule.MEDIA_RULE && !window.matchMedia(rule.media.mediaText).matches) continue;
          if (rule.type === CSSRule.SUPPORTS_RULE && !CSS.supports(rule.conditionText)) continue;
          walk(rule.cssRules);
        }
      }
    };
    for (const rules of sheets) if (rules) walk(rules);
    cssSignature = signature;
    cssTargets = [...found];
    window.__crawlerCssHover = cssTargets.length > 0;
    window.__crawlerCssBlocked = blocked;
    return cssTargets;
  };

  window.__crawlerIsActionable = function (node) {
    const sx = window.scrollX, sy = window.scrollY;
    const ok = measure(node).actionable;
    window.scrollTo(sx, sy);
    return ok;
  };

  // La descripción de un candidato: lo que el crawler necesita para nombrarlo
  // y para volver a encontrarlo.
  function describe(node, visibleFrac) {
    const dataName = node.getAttribute('data-name');
    const cls = node.getAttribute('class') || '';
    const crawlerId = node.getAttribute('data-crawler-id');
    return {
      dataName,
      cls,
      crawlerId,
      readable: readableOf(node),
      tag: node.tagName.toLowerCase(),
      // el <svg> exterior con su propio click: en D3 suele ser "click en
      // el fondo" (p.ej. alejar el zoom hasta la raíz en el circle pack)
      isRootSvg: node instanceof SVGSVGElement && !node.ownerSVGElement,
      // solo para los que no tienen otra identidad estable: los que se
      // encuentran recién al descubrir (ver stableSelector)
      selector: crawlerId || dataName || cls.includes('center-circle') ? null : stableSelector(node),
      moves: node.hasAttribute('data-crawler-moves'),
      visibleFrac,
    };
  }

  const HOVER_PROPS = ['onmouseover', 'onmouseenter', 'onpointerover', 'onpointerenter', 'onmousemove', 'onpointermove'];

  // todos los candidatos interactuables en UNA sola ida y vuelta al
  // browser (con cientos de elementos, consultar uno por uno desde Node
  // domina el tiempo de cada estado). `selectors`: { click, hover, container,
  // scan, css, native }. Un elemento puede ser candidato de los dos tipos (un
  // círculo con mouseover y click) y se lo mide una sola vez; `kinds` dice de
  // cuáles y `sources` por dónde se lo encontró:
  //   listener  un addEventListener sobre el elemento (lo marca instrument.js)
  //   inline    un handler en la propiedad (el.onmouseover = fn) o en el
  //             atributo (onmouseover="..."): las dos formas se ven en la propiedad
  //   css       un :hover de las hojas de estilo (ver __crawlerScanCss)
  //   native    un <title> o title="" (el tooltip nativo del navegador; opt-in)
  window.__crawlerCandidates = function (selectors) {
    const sx = window.scrollX, sy = window.scrollY;
    const nodes = new Set();
    for (const sel of [selectors.click, selectors.hover]) {
      if (sel) for (const node of document.querySelectorAll(sel)) nodes.add(node);
    }

    // los que no pasaron por un addEventListener sobre el propio elemento
    const extra = new Map(); // nodo -> { kinds: Set, sources: [], moves?, native? }
    const addExtra = (node, kind, source, more) => {
      if (node === document.body || node === document.documentElement) return;
      if (window.__crawlerIncludeLinks !== true && (node.tagName === 'A' || node.hasAttribute('href'))) return;
      nodes.add(node);
      if (!extra.has(node)) extra.set(node, { kinds: new Set(), sources: [] });
      const e = extra.get(node);
      e.kinds.add(kind);
      if (!e.sources.includes(source)) e.sources.push(source);
      if (more) Object.assign(e, more);
    };
    const root = selectors.container ? document.querySelector(selectors.container) : document.body;
    if (root) {
      const everyone = [root, ...root.querySelectorAll('*')];
      if (selectors.scan) {
        for (const el of everyone) {
          if (typeof el.onclick === 'function') addExtra(el, 'click', 'inline');
          if (!selectors.hover) continue;
          for (const prop of HOVER_PROPS) {
            if (typeof el[prop] === 'function') addExtra(el, 'hover', 'inline', prop.endsWith('move') ? { moves: true } : null);
          }
        }
      }
      if (selectors.css) {
        for (const target of window.__crawlerScanCss()) {
          let matching;
          try { matching = everyone.filter((el) => el.matches(target)); } catch (e) { continue; }
          for (const el of matching) addExtra(el, 'hover', 'css');
        }
      }
      if (selectors.native) {
        for (const el of everyone) {
          const text = titleText(el.querySelector(':scope > title')) || titleText({ textContent: el.getAttribute('title') || '' });
          if (text) addExtra(el, 'hover', 'native', { native: text });
        }
      }
    }

    const out = [];
    for (const node of nodes) {
      const { actionable, visibleFrac } = measure(node);
      if (!actionable) continue;
      const e = extra.get(node);
      const info = describe(node, visibleFrac);
      info.kinds = ['click', 'hover'].filter((kind) => (selectors[kind] && node.matches(selectors[kind])) || (e && e.kinds.has(kind)));
      info.sources = [...(selectors.hover && node.matches(selectors.hover) ? ['listener'] : []), ...(e ? e.sources : [])];
      if (e && e.moves) info.moves = true;
      info.native = e && e.native ? e.native : null;
      out.push(info);
    }
    window.scrollTo(sx, sy);
    return out;
  };

  // Las marcas de D3 dentro de un contenedor con un listener DELEGADO (uno solo
  // que mira event.target): los descendientes que llevan su propio dato
  // (__data__, la firma de D3), que hoy se pueden tocar, que no son candidatos
  // por sí mismos y de a uno por dato -- D3 le pasa el dato a lo que se le
  // appendea, así que un <g> y su <circle> lo comparten: vale el de más afuera.
  // Devuelve a lo sumo `limit`, y cuántas había.
  window.__crawlerMarks = function (selector, limit) {
    const container = document.querySelector(selector);
    if (!container) return { marks: [], total: 0 };
    const sx = window.scrollX, sy = window.scrollY;
    const accepted = [];
    const marks = [];
    for (const el of container.querySelectorAll('*')) {
      if (!Object.prototype.hasOwnProperty.call(el, '__data__') || el.__data__ == null) continue;
      if (el.hasAttribute('data-crawler-hoverable')) continue; // ya es candidato
      if (accepted.some((a) => a.contains(el) && a.__data__ === el.__data__)) continue;
      const { actionable, visibleFrac } = measure(el);
      if (!actionable) continue;
      accepted.push(el);
      if (marks.length < limit) {
        const info = describe(el, visibleFrac);
        info.kinds = ['hover'];
        info.sources = ['delegated'];
        marks.push(info);
      }
    }
    window.scrollTo(sx, sy);
    return { marks, total: accepted.length };
  };

  // El puntero, simulado con eventos sintéticos como los clicks: no se mueve
  // el mouse del browser, así que no queda una posición escondida que
  // contamine el estado. Los eventos salen en el orden en que los dispara un
  // browser al entrar a un elemento (los de puntero antes que los de mouse;
  // `over` burbujea, y `enter` va uno por cada ancestro al que se entra) y
  // al salir, a la inversa. Se entra siempre desde el fondo de la página:
  // body y html ya "tienen" el puntero.
  let pointer = null; // { node, chain, x, y } mientras el puntero "está" sobre algo

  function fire(target, type, x, y, bubbles) {
    const init = { bubbles, cancelable: bubbles, composed: true, view: window, clientX: x, clientY: y, relatedTarget: document.body };
    target.dispatchEvent(type.startsWith('pointer') && typeof PointerEvent === 'function'
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, init));
  }

  // false si el elemento no está o ya no es interactuable: un usuario real
  // no podría poner el puntero ahí. `where` = 'edge' lo pone en el punto más
  // lejos del centro, la segunda muestra de un hover que depende de la posición.
  window.__crawlerHover = function (selector, where) {
    const node = document.querySelector(selector);
    if (!node) return false;
    window.__crawlerUnhover();
    const sx = window.scrollX, sy = window.scrollY;
    const { actionable, point } = measure(node, where === 'edge'); // lo deja a la vista: las coordenadas valen
    if (!actionable) { window.scrollTo(sx, sy); return false; }
    const [x, y] = point;
    const chain = [];
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
    fire(node, 'pointerover', x, y, true);
    for (const n of chain) fire(n, 'pointerenter', x, y, false);
    fire(node, 'mouseover', x, y, true);
    for (const n of chain) fire(n, 'mouseenter', x, y, false);
    // un puntero real que entra a un elemento manda también un movimiento en ese punto
    fire(node, 'pointermove', x, y, true);
    fire(node, 'mousemove', x, y, true);
    // El :hover de CSS lo fuerza el crawler por el protocolo de DevTools, sobre
    // el elemento y TODOS sus ancestros (como un puntero real); esta marca le
    // dice sobre cuáles.
    if (window.__crawlerCssHover === true) for (let n = node; n; n = n.parentElement) n.setAttribute('data-crawler-hover', '1');
    pointer = { node, chain, x, y };
    window.__crawlerPointerNode = node; // para que la instantánea de efectos sepa cuál es el elemento tocado
    window.scrollTo(sx, sy);
    return true;
  };

  // false si el puntero no estaba sobre nada
  window.__crawlerUnhover = function () {
    if (!pointer) return false;
    const { node, chain, x, y } = pointer;
    pointer = null;
    window.__crawlerPointerNode = null;
    const inside = [...chain].reverse();
    fire(node, 'pointerout', x, y, true);
    for (const n of inside) fire(n, 'pointerleave', x, y, false);
    fire(node, 'mouseout', x, y, true);
    for (const n of inside) fire(n, 'mouseleave', x, y, false);
    if (window.__crawlerCssHover === true) document.querySelectorAll('[data-crawler-hover]').forEach((n) => n.removeAttribute('data-crawler-hover'));
    return true;
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
    const kind = kindOfAction(action);
    let name = actionName(kind, tag);
    for (let k = 2; taken.has(name); k++) name = actionName(kind, `${tag}#${k}`);
    taken.delete(action);
    taken.add(name);
    rename.set(action, name);
  }
  // la vuelta de un hover (Unhover_X) no es un candidato, no tiene etiqueta
  // propia: se llama como su hover
  for (const [from, to] of [...rename]) {
    if (kindOfAction(from) !== 'hover' || !taken.has(unhoverOf(from))) continue;
    rename.set(unhoverOf(from), unhoverOf(to));
    taken.delete(unhoverOf(from));
    taken.add(unhoverOf(to));
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
    node.gestures = renameKeys(node.gestures);
    node.visibility = renameKeys(node.visibility);
    node.labels = renameKeys(node.labels);
    node.inert = renameKeys(node.inert);
    node.effects = renameKeys(node.effects);
    for (const effect of Object.values(node.effects || {})) {
      for (const list of [effect.reveals, effect.hides]) {
        if (list) list.forEach((a, i) => { list[i] = rename.get(a) ?? a; });
      }
    }
  }
  return rename;
}

// El nombre de una acción es del ELEMENTO, no del estado: el mismo
// elemento tiene que ser el mismo símbolo del alfabeto en todos los
// estados (si no, el autómata y su regex no significan nada). Por eso
// se asigna una sola vez por crawl y se reusa.
function createNaming(graph = null) {
  const byGesture = new Map();
  const taken = new Set();
  // al retomar un checkpoint, respetar los nombres ya usados
  if (graph) {
    for (const [, node] of graph) {
      for (const [action, gesture] of Object.entries(node.gestures || {})) {
        byGesture.set(gestureKey(gesture), action);
        taken.add(action);
      }
    }
  }
  return function nameFor(info, gesture) {
    const key = gestureKey(gesture);
    if (byGesture.has(key)) return byGesture.get(key);
    let name = null;
    const options = _nameOptions(info);
    // el hover sobre el <svg> exterior es "el fondo", como su click; sin esto se llamaría por todo el texto que contiene
    if (gesture.kind === 'hover' && info.isRootSvg) options.unshift('background');
    for (const opt of options) {
      const candidate = actionName(gesture.kind, opt);
      if (!taken.has(candidate)) { name = candidate; break; }
    }
    if (!name) name = internalName(gesture.kind, _unknownCounter++);
    byGesture.set(key, name);
    taken.add(name);
    return name;
  };
}

function _selectorFor(info) {
  if (info.dataName) return `[data-name="${info.dataName}"]`;
  if (info.cls.includes('center-circle')) return 'circle.center-circle';
  if (info.crawlerId) return `[data-crawler-id="${info.crawlerId}"]`;
  // los que se encuentran recién al descubrir (handler inline, :hover de CSS,
  // marca de un listener delegado) no tienen id del crawler: ver stableSelector
  if (info.selector) return info.selector;
  throw new Error('elemento interactuable sin identidad estable');
}

// Filtro genérico de "interactuable ahora" para un locator suelto (lo usa
// diagnose.js). Requiere installPageHelpers en la página.
function isActionable(locator) {
  return locator.evaluate((node) => window.__crawlerIsActionable(node));
}

// Candidatos interactuables del estado actual, ya nombrados:
// [[accion, gesto, info], ...]. Primero los clicks y después los hovers (un
// mismo elemento puede estar en los dos), así el orden en que se exploran
// los clicks no depende de que haya hovers. `selectors`: { click, hover }.
// Requiere installPageHelpers en la página.
async function discoverCandidates(page, selectors, nameFor) {
  const infos = await page.evaluate((sel) => window.__crawlerCandidates(sel), selectors);
  const found = [];
  for (const kind of ['click', 'hover']) {
    for (const info of infos) {
      if (!info.kinds.includes(kind)) continue;
      const gesture = { kind, sel: _selectorFor(info) };
      found.push([nameFor(info, gesture), gesture, info]);
    }
  }
  return found;
}

/**
 * Clickea `sel` y mide cuándo deja de cambiar el estado: lee cada
 * `pollMs` y considera "asentado" cuando pasan `quietMs` sin cambios.
 * Devuelve el instante (ms desde el click) del último cambio observado,
 * o null si sigue cambiando al llegar a `maxMs`. Lo usa diagnose.js.
 */
async function measureSettle(page, sel, readFn, { pollMs = 50, quietMs = 400, maxMs = 6000, onChange = null } = {}) {
  let prev = await readFn();
  await PERFORM.click(page, sel);
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
 * @param {boolean} [opts.hover=true] - probar también los hovers (elementos con
 *   un listener de mouseover/mouseenter/pointerover/pointerenter). Un hover
 *   solo entra al autómata si cambia algo visible (ver lib/hovers.js).
 * @param {string} [opts.hoverableSelector='[data-crawler-hoverable]']
 * @param {boolean} [opts.nativeTooltips=false] - contar el tooltip nativo del navegador (un
 *   <title> o title="") como un hover. No cambia el DOM, así que no se verifica: se anota
 *   `native` y se confía en que el elemento lo tiene. Una acción por elemento con <title>.
 * @param {number} [opts.maxDelegated=50] - tope de marcas de D3 a probar por cada listener
 *   delegado (0 = no probar delegados)
 * @param {(msg: string) => void} [opts.onLog] - avisos del crawl (hovers que se omiten)
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
 *   effects: estado -> acción de hover -> qué cambia (ver describeEffect en lib/hovers.js)
 *   ignoredHovers: [{ action, reason, states }] hovers con listener que NO
 *   son una acción (no hacen nada visible, no se asientan, la página cambia sola...)
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
  hover = true,
  hoverableSelector = containerSelector ? `${containerSelector} [data-crawler-hoverable]` : '[data-crawler-hoverable]',
  nativeTooltips = false,
  maxDelegated = 50,
  stateKeyFn = (raw) => raw,
  initScripts = [],
  backSelector = null,
  settleMs = null,
  discoverySettleMs = null,
  maxStates = 1000,
  maxSteps = 20000,
  onStateExpanded = null,
  onLog = null,
  resume = null,
}) {
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  discoverySettleMs = discoverySettleMs ?? settleMs;
  if (settleMs == null || discoverySettleMs == null) await page.clock.install();
  await page.addInitScript(installPageHelpers);
  // el parser de las reglas :hover es el mismo que usan los tests (lib/cssHover.js)
  await page.addInitScript({
    content: `window.__crawlerHoverTargets = ${hoverTargets.toString()}; window.__crawlerIsVisualProperty = ${isVisualProperty.toString()};`,
  });
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
        const err = new Error(
          `la página siguió animando ${MAX_CHUNKS * CHUNK_MS / 1000}s (virtuales) después de una interacción. Esto apunta ` +
          `a una animación continua (algo con requestAnimationFrame corriendo indefinidamente) más que a ` +
          `"hace falta esperar un poco más" -- ahí, la detección automática de estado no es la herramienta ` +
          `correcta: instrumentá window.__testState a mano, capturando solo lo lógicamente relevante ` +
          `(o pasá --settleMs fijo para forzar una corrida en tiempo real).`
        );
        err.code = 'NO_SETTLE'; // probeHover lo distingue: un hover así se ignora, no tumba el crawl
        throw err;
      }
      await page.clock.fastForward(CHUNK_MS);
      chunks++;
    }
  }


  function settle(wait) {
    return wait == null ? virtualSettle() : page.waitForTimeout(wait);
  }

  // Ejecuta un gesto y espera a que la página se asiente. Devuelve lo que
  // devuelve el gesto (para hover, false si el elemento ya no se podía
  // tocar). Después de un click el puntero queda afuera: la página puede
  // llegar con él encima de algo (un hover que abrió un menú) y el estado
  // que se lee tiene que ser el del click, no el del click con un
  // resaltado colgado que un usuario real no vería.
  async function perform(gesture, wait, opts) {
    errors = [];
    const done = await PERFORM[gesture.kind](page, gesture.sel, opts);
    await settle(wait);
    if (gesture.kind === 'click' && (await PERFORM.unhover(page))) await settle(wait);
    return done;
  }


  async function initialLoad(wait) {
    errors = [];
    await page.goto(fixtureUrl);
    resetCssHover(page);
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

  // grafo decorado: state -> { path: gesto[], visited: bool, transitions: {}, gestures: {} }
  // (gestures: acción -> gesto, para poder rehacer transiciones ya
  // conocidas al navegar sin recargar; ver knownRoute)
  let graph, initialState, queue, currentState;

  if (resume) {
    graph = new Map(resume.graph);
    for (const node of graph.values()) upgradeGestures(node);
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
    graph.set(initialState, { path: [], visited: false, transitions: {}, gestures: {} });
    currentState = initialState;
    queue = [initialState];
  }

  const nameFor = createNaming(graph);

  const log = onLog || (() => {});

  // Sin instrument.js (estado manual con window.__testState) no hay cómo ver
  // si un hover cambió algo, y sin eso no se puede distinguir un hover real
  // de uno que no hace nada: mejor no probar ninguno que inventarlos.
  if (hover && !(await page.evaluate(() => typeof window.__crawlerEffects === 'function'))) {
    hover = false;
    log('hover: sin instrument.js no se ve qué cambia un hover; no se prueban hovers');
  }
  const selectors = {
    click: clickableSelector,
    hover: hover ? hoverableSelector : null,
    container: containerSelector,
    scan: true, // handlers inline (onclick / onmouseover...), que no pasan por addEventListener
    css: hover, // reglas :hover de las hojas de estilo
    native: hover && nativeTooltips,
  };
  // `baseline`: la instantánea de referencia contra la que la página calcula los
  // cambios de estilo (ver __crawlerEffects); se pide solo con la de ANTES de un hover
  const readEffects = (baseline = false) => page.evaluate((b) => window.__crawlerEffects(b), baseline);
  // las reglas :hover de la página: se miran tras cada carga, antes de la instantánea de referencia
  let cssBlockedWarned = false;
  const scanCss = async () => {
    const blocked = await page.evaluate(() => { window.__crawlerScanCss(); return window.__crawlerCssBlocked || 0; });
    if (blocked > 0 && !cssBlockedWarned) {
      cssBlockedWarned = true;
      log(`hover: ${blocked} hoja(s) de estilo de otro origen no se pueden leer; sus reglas :hover no se ven`);
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function knownRoute(from, to) {
    if (!graph.has(from)) return null;
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length > 0) {
      const s = q.shift();
      if (s === to) break;
      const n = graph.get(s);
      if (!n || !n.gestures) continue; // checkpoints viejos no guardaban selectores
      for (const [action, next] of Object.entries(n.transitions)) {
        if (next === ERROR_STATE || prev.has(next) || !n.gestures[action]) continue;
        prev.set(next, [s, n.gestures[action]]);
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
      while (i < curPath.length && i < tgtPath.length && gestureKey(curPath[i]) === gestureKey(tgtPath[i])) i++;
      const upSteps = curPath.length - i;
      const downGestures = tgtPath.slice(i);

      for (let k = 0; k < upSteps; k++) await perform(click(backSelector), wait);
      await replay(downGestures, wait);
      currentState = target;
      return;
    }

    // modo genérico
    if (currentState && currentState !== ERROR_STATE) {
      const route = knownRoute(currentState, target);
      if (route && route.length <= targetNode.path.length) {
        const replayed = await replay(route, wait, { strict: false });
        if (replayed && errors.length === 0 && (await readState()) === target) {
          currentState = target;
          return;
        }

      }
    }
    await initialLoad(wait);
    await replay(targetNode.path, wait);
    currentState = target;
  }

  // Reproduce gestos ya conocidos. Un hover que ya no se puede hacer (el
  // elemento dejó de ser interactuable) es que la página no se comporta como
  // cuando se descubrió el camino: con `strict` se corta, y si no se avisa
  // devolviendo false para que quien llama pruebe otro camino.
  async function replay(gestures, wait, { strict = true } = {}) {
    for (const gesture of gestures) {
      if ((await perform(gesture, wait)) !== false || gesture.kind !== 'hover') continue;
      if (strict) throw new Error(`no se pudo reproducir el hover sobre ${gesture.sel}: el elemento ya no es interactuable`);
      return false;
    }
    return true;
  }

  let steps = 0;

  function countStep() {
    steps++;
    if (steps > maxSteps) {
      throw new Error(
        `maxSteps (${maxSteps}) excedido -- probable estado inestable ` +
        `(rompe la marca de "visitado") o un grafo genuinamente enorme.`
      );
    }
  }

  function snapshot() {
    return {
      graph: Array.from(graph.entries()),
      
      queue: [...graph.keys()].filter((s) => !graph.get(s).expanded),
      initialState,
    };
  }

  // ¿La página cambia sola con el tiempo (un reloj, una animación suelta)?
  // Si sí, no hay forma de saber si lo que cambió después de un hover fue
  // por el hover: todos parecerían tener efecto. Se mira dejando pasar el
  // tiempo sin tocar nada.
  async function pageDrifts(state) {
    await navigateTo(state, settleMs);
    await scanCss();
    const before = await readEffects(true);
    try {
      await settle(settleMs);
    } catch (e) {
      if (e.code === 'NO_SETTLE') return true;
      throw e;
    }
    return !same(before, await readEffects());
  }

  // Pone el puntero sobre el elemento de `gesture` en `state`, mira qué
  // cambió y lo saca. `where` = 'edge' apunta lejos del centro. Devuelve lo
  // observado, o { problem } si el hover no se pudo hacer, o { broke } si tiró
  // una excepción en la página.
  async function observeHover(state, gesture, found, where) {
    await navigateTo(state, settleMs);
    // lo que se observa se compara con lo que había en `state`: si la navegación
    // no llegó ahí (el modo rápido no la verifica), la comparación no vale
    if ((await readState()) !== state) return { problem: 'la navegación no llegó a este estado' };
    currentState = state;
    await scanCss();
    const before = await readEffects(true);
    try {
      if ((await perform(gesture, settleMs, { where })) === false) return { problem: 'ya no era interactuable' };
      if (errors.length > 0) return { broke: true };
      const after = await readEffects();
      // con el puntero encima: la clave del estado y qué se puede hacer, pero
      // solo si algo cambió (si no, el hover se descarta y no hace falta)
      const changed = !same(before, after);
      const hoveredKey = changed ? await readState() : null;
      const whileHovered = changed ? await discoverCandidates(page, selectors, nameFor) : [];
      // la clave, en la instantánea, del elemento tocado (la dejó __crawlerEffects): sirve para decir que un cambio es "de él"
      const selfKey = changed ? await page.evaluate(() => window.__crawlerSelfKey || null) : null;
      await perform(unhover(gesture.sel), settleMs);
      if (errors.length > 0) return { broke: true };
      return { before, after, restored: await readEffects(), hoveredKey, whileHovered, selfKey };
    } catch (e) {
      if (e.code !== 'NO_SETTLE') throw e;
      return { problem: 'no se asienta (animación continua)' };
    }
  }

  let fastModeWarned = false; // el aviso del modo rápido, una sola vez

  // Prueba el hover `gesture` en `state` y decide qué es (ver lib/hovers.js):
  //  - si no cambia nada visible, NO es una acción: se descarta;
  //  - si es un resaltado o un tooltip (no cambia qué se puede hacer), es
  //    una acción más del mismo estado, con su efecto anotado;
  //  - si abre algo o deja un cambio, lleva a otro estado, con su vuelta.
  // Salvo en este último caso, la página queda con el puntero afuera.
  // `info.moves`: el elemento tiene listeners de movimiento, cuyo efecto puede
  // depender de dónde está el puntero: se prueba en el centro y lejos de él.
  // `quiet`: no anotar el "sin efecto" (las marcas de un listener delegado se
  // cuentan juntas en el contenedor). Devuelve 'effect', 'inert' o 'problem'.
  async function probeHover(state, node, action, gesture, found, info = {}, { quiet = false } = {}) {
    const ignore = (reason) => {
      if (quiet && reason === 'sin efecto visible') return;
      node.inert = node.inert || {};
      node.inert[action] = reason;
    };

    let seen = await observeHover(state, gesture, found);
    let positional = false;
    if (info.moves && !seen.problem && !seen.broke && same(seen.before, seen.restored)) {
      const far = await observeHover(state, gesture, found, 'edge');
      if (far.broke) {
        seen = far;
      } else if (!far.problem) {
        const nearChanged = !same(seen.before, seen.after);
        const farChanged = !same(far.before, far.after);
        positional = nearChanged !== farChanged || (nearChanged && !same(seen.after, far.after));
        if (!nearChanged && farChanged) seen = far; // el efecto aparece en otro punto: la acción existe
      }
    }

    if (seen.problem) {
      ignore(seen.problem);
      currentState = null;
      return 'problem';
    }
    if (seen.broke) {
      node.transitions[action] = ERROR_STATE;
      node.gestures[action] = gesture;
      currentState = ERROR_STATE;
      return 'effect';
    }

    const { before, after, restored, hoveredKey, whileHovered } = seen;
    const keys = (list) => list.map(([, g]) => gestureKey(g));
    const verdict = classifyProbe({
      state, hoveredKey, before, after, restored, actionsBefore: keys(found), actionsHovered: keys(whileHovered),
    });
    if (verdict.type === 'inert') {
      ignore('sin efecto visible');
      currentState = verdict.reverted ? state : null;
      return 'inert';
    }

    const effect = describeEffect(before, after, seen.selfKey || selfKeyOf(gesture.sel));
    const namesOf = (gestureKeys) => [...found, ...whileHovered]
      .filter(([, g]) => gestureKeys.includes(gestureKey(g))).map(([a]) => a);
    if (!verdict.reverted) effect.persistent = true;
    if (positional) effect.positional = true;
    if (verdict.revealed.length) effect.reveals = namesOf(verdict.revealed);
    if (verdict.hidden.length) effect.hides = namesOf(verdict.hidden);

    if (verdict.type === 'decorative') {
      node.transitions[action] = state;
      node.gestures[action] = gesture;
      node.effects = node.effects || {};
      node.effects[action] = effect;
      // si no revirtió, la clave puede ser otra (el cambio se ve recién al salir)
      currentState = verdict.reverted ? state : await readState();
      return 'effect';
    }

    // estructural: otro estado, el del puntero encima
    if (backSelector) {
      // el modo rápido navega por ancestro común: no sabe seguir un hover que cambia de estado
      ignore('estructural, y el modo rápido (backSelector) no puede seguirlo');
      if (!fastModeWarned) {
        fastModeWarned = true;
        log(`hover: "${action}" cambia qué se puede hacer, pero el modo rápido (backSelector) no sabe seguir un hover que cambia de estado; ` +
          'se omiten los que sean así (ver hovers.ignored en transitions.json)');
      }
      currentState = verdict.reverted ? state : null;
      return 'problem';
    }
    const leftKey = verdict.reverted ? state : await readState();
    node.transitions[action] = hoveredKey;
    node.gestures[action] = gesture;
    node.effects = node.effects || {};
    node.effects[action] = effect;
    currentState = leftKey;

    // Si sacar el puntero deja la misma clave, el estado es el mismo con o sin
    // él (el hover dejó un cambio): no hay "estado con el puntero encima" ni
    // una vuelta que tomar -- un unhover de un estado a sí mismo sería un
    // paso que un usuario no puede repetir.
    const withPointer = leftKey !== hoveredKey;
    let hovered = graph.get(hoveredKey);
    const isNew = !hovered;
    if (isNew) {
      hovered = { path: [...node.path, gesture], visited: false, transitions: {}, gestures: {} };
      if (withPointer) Object.assign(hovered, { pointer: gesture, enabled: verdict.revealed });
      graph.set(hoveredKey, hovered);
    }
    // la vuelta existe si ese estado es uno con el puntero encima (si el
    // mismo aspecto se alcanza haciendo clicks, sacar el puntero no hace nada)
    if (withPointer && hovered.pointer) {
      const back = unhoverOf(action);
      hovered.transitions[back] = leftKey;
      hovered.gestures[back] = unhover(gesture.sel);
    }
    const leftIsNew = leftKey !== state && !graph.has(leftKey);
    if (leftIsNew) graph.set(leftKey, { path: [...hovered.path, unhover(gesture.sel)], visited: false, transitions: {}, gestures: {} });
    if (isNew && graph.size <= maxStates) await expand(hoveredKey);
    if (leftIsNew && graph.size <= maxStates) await expand(leftKey);
    return 'effect';
  }

  // El tooltip nativo del navegador (un <title>, un title="") no cambia nada en
  // el DOM: no hay efecto que mirar, y por eso es opt-in (--native-tooltips).
  // Se lo anota tal cual, marcado `native` para que se vea que se confía en que
  // el elemento lo tiene y no en un cambio observado.
  const nativeNote = (text) => `tooltip nativo: ${JSON.stringify(text)}`;
  function recordNative(node, state, action, gesture, text) {
    node.transitions[action] = state;
    node.gestures[action] = gesture;
    node.effects = node.effects || {};
    node.effects[action] = { changes: [nativeNote(text)], native: true };
  }

  // Un listener DELEGADO (uno solo, en un contenedor, que mira event.target) no
  // hace nada cuando se lo prueba sobre el propio contenedor: el target es el
  // contenedor. Para esos se prueban las marcas de D3 que tiene adentro (ver
  // __crawlerMarks): el evento sale de la marca y burbujea hasta el listener,
  // con las coordenadas de la marca, así que sirven tanto los handlers que
  // leen event.target.__data__ como los que miran la posición.
  async function probeDelegated(state, node, found, containers) {
    for (const [action, gesture] of containers) {
      await navigateTo(state, settleMs);
      const { marks, total } = await page.evaluate(([sel, limit]) => window.__crawlerMarks(sel, limit), [gesture.sel, maxDelegated]);
      if (marks.length === 0) continue;
      let probed = 0, effective = 0;
      for (const info of marks) {
        const markGesture = { kind: 'hover', sel: _selectorFor(info) };
        const markAction = nameFor(info, markGesture);
        if (markAction in node.transitions) continue;
        node.labels = node.labels || {};
        node.labels[markAction] = { readable: info.readable, tag: info.tag };
        countStep();
        probed++;
        if ((await probeHover(state, node, markAction, markGesture, found, info, { quiet: true })) === 'effect') effective++;
      }
      node.inert[action] = `sin efecto en sí mismo; se probaron ${probed}${total > probed ? ` de ${total}` : ''} elementos internos (${effective} con efecto)`;
    }
  }

  // Expande `state` y, en profundidad, cada estado nuevo que descubra.
  async function expand(state) {
    const node = graph.get(state);
    node.visited = true;
    // explícito y no `undefined`: JSON no guarda `undefined`, y al retomar
    // un checkpoint un nodo a medio expandir tiene que verse como NO expandido
    node.expanded = false;
    node.gestures = node.gestures || {};

    await navigateTo(state, discoverySettleMs);
    const found = await discoverCandidates(page, selectors, nameFor);
    // Con el puntero sobre algo (un estado al que llevó un hover) solo se
    // siguen los clicks que ese hover habilita y el del propio elemento: para
    // clickear cualquier otra cosa el usuario tiene que sacar el puntero, y
    // eso ya es la vuelta (unhover). Tampoco se prueban más hovers desde ahí.
    const candidates = node.pointer
      ? found.filter(([, g]) => g.kind === 'click' && (g.sel === node.pointer.sel || node.enabled.includes(gestureKey(g))))
      : found;

    let drifting = null; // se mira una vez por estado, antes del primer hover
    const containers = []; // hovers sin efecto por sí mismos: si el listener es de un contenedor, puede ser delegado
    for (const [action, gesture, info] of candidates) {
      if (action in node.transitions) continue;
      const { visibleFrac, readable, tag } = info;
      node.labels = node.labels || {};
      node.labels[action] = { readable, tag };
      // solo las que se ven en parte (redondeadas a 2 decimales): son las
      // que el reporte señala (ver measure en installPageHelpers)
      if (gesture.kind === 'click' && visibleFrac != null && Math.round(visibleFrac * 100) < 100) {
        node.visibility = node.visibility || {};
        node.visibility[action] = Math.round(visibleFrac * 100) / 100;
      }
      countStep();

      if (gesture.kind === 'hover') {
        // lo único que tiene es un tooltip nativo: no hay nada que probar
        if (info.native && info.sources.every((s) => s === 'native')) {
          recordNative(node, state, action, gesture, info.native);
          continue;
        }
        if (drifting === null) {
          drifting = await pageDrifts(state);
          if (drifting) log('hover: la página cambia sola con el tiempo; no se puede separar lo que hace un hover de eso, se omiten los hovers de este estado');
        }
        if (drifting) {
          node.inert = node.inert || {};
          node.inert[action] = 'la página cambia sola con el tiempo';
          continue;
        }
        const result = await probeHover(state, node, action, gesture, found, info);
        if (info.native) {
          // además de su hover, tiene un tooltip nativo: se suma a su efecto; y si el hover no hacía nada, el tooltip es el efecto
          if (result === 'inert') { delete node.inert[action]; recordNative(node, state, action, gesture, info.native); }
          else if (result === 'effect' && node.effects && node.effects[action]) {
            node.effects[action].changes.push(nativeNote(info.native));
            node.effects[action].native = true;
          }
        } else if (result === 'inert' && info.sources.some((s) => s === 'listener' || s === 'inline')) {
          containers.push([action, gesture]);
        }
        continue;
      }

      await navigateTo(state, settleMs);
      await perform(gesture, settleMs);
      currentState = null;

      const nextState = errors.length > 0 ? ERROR_STATE : await readState();
      node.transitions[action] = nextState;
      node.gestures[action] = gesture;
      currentState = nextState;

      if (nextState !== ERROR_STATE && !graph.has(nextState)) {
        graph.set(nextState, { path: [...node.path, gesture], visited: false, transitions: {}, gestures: {} });
        if (graph.size <= maxStates) await expand(nextState);
      }
    }

    if (containers.length > 0 && maxDelegated > 0) await probeDelegated(state, node, found, containers);

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
  const effects = {};
  const ignored = new Map(); // `acción\0motivo` -> en cuántos estados
  for (const [state, node] of graph) {
    transitions[state] = node.transitions;
    if (node.visibility) visibility[state] = node.visibility;
    if (node.labels) {
      labels[state] = {};
      for (const [action, { readable }] of Object.entries(node.labels)) labels[state][action] = readable;
    }
    if (node.effects) effects[state] = node.effects;
    for (const [action, reason] of Object.entries(node.inert || {})) {
      const key = `${action}\u0000${reason}`;
      ignored.set(key, (ignored.get(key) || 0) + 1);
    }
  }
  const ignoredHovers = [...ignored].map(([key, states]) => {
    const [action, reason] = key.split('\u0000');
    return { action, reason, states };
  });
  return { transitions, initialState, visibility, labels, effects, ignoredHovers, renamed, usedManualState, truncated };
}

module.exports = { crawl, ERROR_STATE, installPageHelpers, isActionable, measureSettle };
