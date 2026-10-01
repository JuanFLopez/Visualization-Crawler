/**
 * Se inyecta ANTES de que corra el código de la visualización del usuario
 * (vía page.addInitScript). Hace dos cosas, sin requerir que el usuario
 * toque una sola línea de su código D3:
 *
 * 1. DETECTA elementos clickeables de verdad: parchea addEventListener
 *    para marcar (con data-crawler-clickable + un id estable
 *    data-crawler-id) cualquier elemento al que se le registre un
 *    listener de "click". D3 v6+ usa addEventListener por debajo en
 *    selection.on(), así que esto agarra cualquier .on("click", ...) sin
 *    que el usuario tenga que distinguir a mano los elementos realmente
 *    interactivos de los decorativos.
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
 * Limitación conocida: solo ve DOM real (SVG/HTML). Visualizaciones
 * basadas en <canvas> no exponen atributos para fingerprintear -- para
 * esas hace falta un window.__testState manual.
 */
(function () {
   
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  let counter = 0;
  const origAdd = EventTarget.prototype.addEventListener;

  function isLink(el) {
    return el.tagName === 'A' || el.hasAttribute('href');
  }

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'click' && this && this.nodeType === 1) {
      const includeLinks = window.__crawlerIncludeLinks === true;
      if (includeLinks || !isLink(this)) {
        if (!this.hasAttribute('data-crawler-id')) {
          this.setAttribute('data-crawler-id', 'c' + counter++);
        }
        this.setAttribute('data-crawler-clickable', '1');
      }
    }
    return origAdd.call(this, type, listener, options);
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
  function roundNumbers(v) {
    return v.replace(/-?\d*\.\d+(e[-+]?\d+)?/gi, (m) => {
      const r = Math.round(parseFloat(m) * 100) / 100;
      return String(r === 0 ? 0 : r); // evita "-0"
    });
  }

  // Un elemento invisible no aporta su geometría al estado: D3 suele
  // dejar de actualizar los elementos ocultos (p.ej. clicked() del
  // sunburst solo transiciona arcos/labels visibles), así que sus
  // atributos quedan "viejos" y dependen del camino recorrido.
  function isInvisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
    if (el instanceof SVGGeometryElement || el instanceof SVGTextContentElement) {
      const noFill = cs.fill === 'none' || parseFloat(cs.fillOpacity) === 0;
      const noStroke = cs.stroke === 'none' || parseFloat(cs.strokeOpacity) === 0;
      return noFill && noStroke;
    }
    return false;
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
    root.querySelectorAll('svg, svg *, [data-crawler-clickable]').forEach((el) => {
      buf += el.tagName;
      if (isInvisible(el)) {
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
})();
