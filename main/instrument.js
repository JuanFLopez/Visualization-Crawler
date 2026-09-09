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
  let counter = 0;
  const origAdd = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'click' && this && this.nodeType === 1) {
      if (!this.hasAttribute('data-crawler-id')) {
        this.setAttribute('data-crawler-id', 'c' + counter++);
      }
      this.setAttribute('data-crawler-clickable', '1');
    }
    return origAdd.call(this, type, listener, options);
  };

  const STATE_ATTRS = [
    'd', 'transform', 'cx', 'cy', 'r', 'rx', 'ry',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points',
    'fill-opacity', 'opacity', 'stroke-opacity', 'fill', 'stroke', 'class',
  ];

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  window.__crawlerState = function () {
    return fnv1a(window.__crawlerStateDebug());
  };

  // versión sin hashear, solo para diagnóstico (ver diagnose.js): permite
  // ver EXACTAMENTE qué atributo cambió entre dos lecturas que deberían
  // ser idénticas.
  window.__crawlerStateDebug = function () {
    let buf = '';
    document.querySelectorAll('svg, svg *, [data-crawler-clickable]').forEach((el) => {
      buf += el.tagName;
      for (const attr of STATE_ATTRS) {
        const v = el.getAttribute(attr);
        if (v) buf += '|' + attr + '=' + v;
      }
      buf += ';';
    });
    return buf;
  };
})();
