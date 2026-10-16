/**
 * Se inyecta ANTES de que corra el código de la visualización del usuario
 * (vía page.addInitScript). Hace cuatro cosas, sin requerir que el usuario
 * toque una sola línea de su código D3:
 *
 * 1. DETECTA elementos clickeables de verdad: parchea addEventListener
 *    para marcar (con data-crawler-clickable + un id estable
 *    data-crawler-id) cualquier elemento al que se le registre un
 *    listener de "click". D3 v6+ usa addEventListener por debajo en
 *    selection.on(), así que esto agarra cualquier .on("click", ...) sin
 *    que el usuario tenga que distinguir a mano los elementos realmente
 *    interactivos de los decorativos. Igual con los que reaccionan a que
 *    el puntero entre (mouseover/mouseenter/pointerover/pointerenter),
 *    marcados con data-crawler-hoverable.
 *
 *    Los <a> (y cualquier elemento con href) se EXCLUYEN por defecto: en
 *    una página real (no un fixture aislado) es común que haya links de
 *    navegación con su propio listener de click (tracking, ruteo SPA,
 *    etc.) que casi nunca son parte del vocabulario interactivo de la
 *    visualización en sí -- y si el crawler llega a clickear uno de
 *    verdad, puede navegar la página entera y tirar abajo el crawl. Para
 *    incluirlos de nuevo (si tu visualización SÍ usa <a> como parte de su
 *    interacción), seteá window.__crawlerIncludeLinks = true antes de que
 *    corra este script (vía un initScript propio, antes de este).
 *
 * 2. EXPONE window.__crawlerState(): un fingerprint (hash corto) de los
 *    atributos visualmente relevantes de todo el DOM bajo <svg> (o de
 *    cualquier elemento clickeable, aunque esté fuera de un <svg>). Sirve
 *    como "estado" genérico cuando el usuario no define su propio
 *    window.__testState -- que sigue teniendo prioridad si existe, para
 *    quien prefiera instrumentar a mano con más precisión.
 *
 * 3. EXPONE window.__crawlerActivity(): frames de animación y requests
 *    en vuelo, para esperar a que la página se asiente (ver más abajo).
 *
 * 4. EXPONE window.__crawlerEffects(): una instantánea de todo lo visible
 *    del documento, para ver si un hover cambió algo (ver más abajo).
 *
 * Limitación conocida: solo ve DOM real (SVG/HTML). Visualizaciones
 * basadas en <canvas> no exponen atributos para fingerprintear -- para
 * esas hace falta un window.__testState manual.
 *
 * Los hovers que no pasan por addEventListener sobre el propio elemento los
 * encuentra crawler.js por otro lado (handlers en la propiedad o en un
 * atributo inline, :hover de las hojas de estilo, listeners delegados en un
 * contenedor: ver __crawlerCandidates y __crawlerMarks). Lo que sigue sin
 * ver: listeners en window/document, efectos sobre pseudo-elementos (::after),
 * :hover de hojas de estilo de OTRO origen (el navegador no deja leerlas) y
 * efectos que no pasan por el DOM (un <canvas>).
 */
(function () {
   
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  let counter = 0;
  const origAdd = EventTarget.prototype.addEventListener;

  function isLink(el) {
    return el.tagName === 'A' || el.hasAttribute('href');
  }

  // Los eventos con los que una visualización reacciona a que el puntero
  // ENTRE a un elemento.
  const HOVER_ENTER = new Set(['mouseover', 'mouseenter', 'pointerover', 'pointerenter']);
  // Los de MOVIMIENTO también cuentan, pero su efecto suele depender de DÓNDE
  // está el puntero (un tooltip que lo sigue, una línea guía): el crawler los
  // prueba en dos puntos y avisa si el efecto cambia (ver observeHover en
  // crawler.js); no enumera posiciones.
  const HOVER_MOVE = new Set(['mousemove', 'pointermove']);

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const attr = type === 'click' ? 'data-crawler-clickable'
      : HOVER_ENTER.has(type) || HOVER_MOVE.has(type) ? 'data-crawler-hoverable' : null;
    if (attr && this && this.nodeType === 1) {
      const includeLinks = window.__crawlerIncludeLinks === true;
      if (includeLinks || !isLink(this)) {
        if (!this.hasAttribute('data-crawler-id')) {
          this.setAttribute('data-crawler-id', 'c' + counter++);
        }
        this.setAttribute(attr, '1');
        if (HOVER_MOVE.has(type)) this.setAttribute('data-crawler-moves', '1');
      }
    }
    return origAdd.call(this, type, listener, options);
  };

  // 3. ACTIVIDAD de la página, para que el crawler espere "hasta que se
  //    quede quieta" en vez de un settleMs fijo. Dos señales genéricas:
  //    - requestAnimationFrame: d3-timer (y por ende toda transición D3,
  //      y casi cualquier animación JS) pide un frame por cuadro mientras
  //      anima y deja de pedirlos al terminar.
  //    - fetch/XHR en vuelo: d3.json/d3.csv cargan datos después del
  //      evento load; hasta que no vuelven, la visualización ni existe.
  //    Limitación: una transición con .delay() largo duerme vía
  //    setTimeout sin pedir frames -- para esas, pasar --settleMs fijo.
  let lastFrameRequest = -Infinity;
  let pendingRequests = 0;

  const origRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    lastFrameRequest = performance.now();
    return origRaf.call(window, cb);
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      pendingRequests++;
      return origFetch.apply(this, arguments).finally(() => { pendingRequests--; });
    };
  }

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    pendingRequests++;
    origAdd.call(this, 'loadend', () => { pendingRequests--; });
    return origSend.apply(this, arguments);
  };

  window.__crawlerActivity = function () {
    return { pendingRequests, msSinceFrame: performance.now() - lastFrameRequest };
  };

  const STATE_ATTRS = [
    'd', 'transform', 'cx', 'cy', 'r', 'rx', 'ry',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points',
    'fill-opacity', 'opacity', 'stroke-opacity', 'fill', 'stroke', 'class',
  ];

  const NON_NUMERIC_ATTRS = new Set(['fill', 'stroke', 'class']);

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  // Redondeo de todos los números de un atributo: interpolaciones D3 que
  // "vuelven" al mismo lugar dejan ruido de punto flotante en los últimos
  // dígitos (rotate(97.4140204930506) vs rotate(97.41402049305063)), y sin
  // esto el mismo estado lógico da fingerprints distintos según el camino.
  // También normaliza separadores: el mismo transform puede venir escrito
  // "translate(0,12.3)" (el código del usuario) o "translate(0, 12.3)"
  // (d3.interpolateTransformSvg al terminar una transición) según el
  // camino por el que se llegó.
  function roundNumbers(v) {
    return v
      .replace(/-?\d*\.\d+(e[-+]?\d+)?/gi, (m) => {
        const r = Math.round(parseFloat(m) * 100) / 100;
        return String(r === 0 ? 0 : r); // evita "-0"
      })
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Un elemento invisible no aporta su geometría al estado: D3 suele
  // dejar de actualizar los elementos ocultos (p.ej. clicked() del
  // sunburst solo transiciona arcos/labels visibles), así que sus
  // atributos quedan "viejos" y dependen del camino recorrido.
  function isInvisible(el, svgRects) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
    if (el instanceof SVGGeometryElement || el instanceof SVGTextContentElement) {
      const noFill = cs.fill === 'none' || parseFloat(cs.fillOpacity) === 0;
      const noStroke = cs.stroke === 'none' || parseFloat(cs.strokeOpacity) === 0;
      if (noFill && noStroke) return true;
    }
    return isOutsideSvg(el, svgRects);
  }

  // Lo mismo para lo que quedó entero FUERA del área visible del <svg>
  // (p.ej. los nodos fuera de foco de un icicle zoomable, trasladados más
  // allá del viewBox): no se ve, y su posición exacta depende del camino
  // -- justo en el borde, 890.935 vs 890.93499 redondean distinto. La
  // comparación es booleana con medio px de tolerancia, sin redondeo.
  function isOutsideSvg(el, svgRects) {
    if (!(el instanceof SVGGraphicsElement) || el instanceof SVGSVGElement) return false;
    let svg = el.ownerSVGElement;
    while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
    if (!svg) return false;
    if (!svgRects.has(svg)) svgRects.set(svg, svg.getBoundingClientRect());
    const s = svgRects.get(svg);
    const r = el.getBoundingClientRect();
    return r.right < s.left + 0.5 || r.left > s.right - 0.5 || r.bottom < s.top + 0.5 || r.top > s.bottom - 0.5;
  }

  window.__crawlerState = function () {
    return fnv1a(window.__crawlerStateDebug());
  };

  // versión sin hashear, solo para diagnóstico (ver diagnose.js): permite
  // ver EXACTAMENTE qué atributo cambió entre dos lecturas que deberían
  // ser idénticas.
  window.__crawlerStateDebug = function () {
   const sel = window.__crawlerContainerSelector;
    const root = sel ? document.querySelector(sel) : document;
    if (!root) throw new Error('contenedor no encontrado: ' + sel);
    let buf = '';
    const svgRects = new Map();
    root.querySelectorAll('svg, svg *, [data-crawler-clickable], [data-crawler-hoverable]').forEach((el) => {
      buf += el.tagName;
      if (isInvisible(el, svgRects)) {
        buf += '|hidden;';
        return;
      }
      for (const attr of STATE_ATTRS) {
        const v = el.getAttribute(attr);
        if (v) buf += '|' + attr + '=' + (NON_NUMERIC_ATTRS.has(attr) ? v : roundNumbers(v));
      }
      buf += ';';
    });
    return buf;
  };

  // 4. INSTANTÁNEA DE EFECTOS: lo visible de TODO el documento, no solo del
  //    <svg> como el fingerprint de estado. Comparando la de antes con la de
  //    después de un hover se ve si cambió algo -- p.ej. un tooltip HTML --
  //    y qué. Es el efecto NETO: lo que un handler pone y saca en el mismo
  //    paso no deja rastro. Lo oculto cuenta solo como "oculto": cambiar
  //    algo que el usuario no ve no es un efecto.
  //    CSS: un :hover de una hoja de estilos cambia cómo se ve algo sin tocar
  //    ningún atributo, así que cuando la página tiene reglas :hover (lo avisa
  //    el crawler en window.__crawlerCssHover) la instantánea suma un
  //    subconjunto de estilos CALCULADOS. Para no mandar cientos de valores por
  //    el cable, solo viajan los que CAMBIARON respecto de la instantánea de
  //    referencia (la que se pide con baseline = true).
  const CS_PROPS = [
    'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'opacity', 'display', 'visibility',
    'transform', 'color', 'background-color', 'font-weight', 'font-size', 'text-decoration-line', 'filter',
    'r', 'rx', 'ry', 'width', 'height', 'box-shadow', 'outline-color', 'border-top-color',
  ];
  let csBaseline = null;

  // Las transiciones y animaciones CSS no siguen al reloj falso de la página
  // (page.clock): sin esto se leería un valor a mitad de camino. Se las lleva a
  // su estado final; las que no terminan nunca (infinitas) se congelan.
  function settleAnimations() {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch (e) { animation.pause(); }
    }
  }

  window.__crawlerEffects = function (baseline) {
    const css = window.__crawlerCssHover === true;
    if (css) settleAnimations();
    const computed = css ? new Map() : null;
    const pointerNode = window.__crawlerPointerNode || null;
    let selfKey = null;
    const out = [];
    const svgRects = new Map();
    const keys = new Map();
    const siblingCount = new Map(); // padre -> { etiqueta -> cuántas van }
    for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      // la clave de un elemento con id del crawler es ese id (no cambia si
      // aparece un hermano); el resto, su posición entre los de su etiqueta
      let key = el.getAttribute('data-crawler-id');
      if (key) {
        key = 'id:' + key;
      } else {
        const counts = siblingCount.get(el.parentElement) || {};
        counts[tag] = (counts[tag] || 0) + 1;
        siblingCount.set(el.parentElement, counts);
        key = (keys.get(el.parentElement) || '') + '/' + tag + counts[tag];
      }
      keys.set(el, key);
      if (el === pointerNode) selfKey = key;
      const p = keys.get(el.parentElement) || null; // para agrupar lo que aparece junto con su padre

      if (isInvisible(el, svgRects)) {
        out.push({ k: key, p, t: tag, h: 1 });
        continue;
      }
      const a = {};
      for (const name of el.getAttributeNames().sort()) {
        if (!name.startsWith('data-crawler-')) a[name] = roundNumbers(el.getAttribute(name));
      }
      let x = '';
      for (const n of el.childNodes) if (n.nodeType === 3) x += n.nodeValue;
      out.push({ k: key, p, t: tag, a, x: x.replace(/\s+/g, ' ').trim().slice(0, 200) });
      if (css) {
        const style = getComputedStyle(el);
        const values = {};
        for (const prop of CS_PROPS) values[prop] = style.getPropertyValue(prop);
        computed.set(key, values);
      }
    }
    if (css) {
      const was = baseline === true ? null : csBaseline;
      if (!was) {
        csBaseline = computed;
      } else {
        for (const rec of out) {
          const before = was.get(rec.k), now = computed.get(rec.k);
          if (rec.h || !before || !now) continue;
          const diff = {};
          for (const prop of CS_PROPS) if (before[prop] !== now[prop]) diff[prop] = [before[prop], now[prop]];
          if (Object.keys(diff).length) rec.cs = diff;
        }
      }
    }
    window.__crawlerSelfKey = selfKey; // canal lateral: no forma parte de lo que se compara
    return out;
  };
})();
