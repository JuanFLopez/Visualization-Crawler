/**
 * Injected BEFORE the user's visualization code runs (through
 * page.addInitScript). It does four things without requiring the user to
 * touch a single line of their D3 code:
 *
 * 1. DETECTS really clickable elements: it patches addEventListener to mark
 *    (with data-crawler-clickable plus a stable data-crawler-id) every element
 *    that gets a "click" listener. D3 v6+ uses addEventListener underneath
 *    selection.on(), so this catches any .on("click", ...) without the user
 *    having to tell the truly interactive elements from the decorative ones.
 *    The same goes for elements that react to the pointer entering
 *    (mouseover / mouseenter / pointerover / pointerenter), marked with
 *    data-crawler-hoverable.
 *
 *    <a> elements (and anything with an href) are EXCLUDED by default: on a
 *    real page (not an isolated fixture) navigation links often have their own
 *    click listener (tracking, SPA routing, ...) and are almost never part of
 *    the visualization's own interactive vocabulary, and if the crawler really
 *    clicks one it may navigate the whole page and bring the crawl down. To
 *    include them again (if your visualization does use <a> as part of its
 *    interaction), set window.__crawlerIncludeLinks = true before this script
 *    runs (through an init script of your own, before this one).
 *
 * 2. EXPOSES window.__crawlerState(): a fingerprint (a short hash) of the
 *    visually relevant attributes of everything under <svg> (or of any
 *    clickable element, even outside an <svg>). It serves as a generic "state"
 *    when the user does not define their own window.__testState, which still
 *    takes priority if it exists, for whoever prefers to instrument by hand
 *    with more precision.
 *
 * 3. EXPOSES window.__crawlerActivity(): animation frames and in-flight
 *    requests, to wait for the page to settle (see below).
 *
 * 4. EXPOSES window.__crawlerEffects(): a snapshot of everything visible in
 *    the document, to see whether a hover changed anything (see below).
 *
 * Known limitation: it only sees real DOM (SVG / HTML). <canvas>-based
 * visualizations expose no attributes to fingerprint; those need a manual
 * window.__testState.
 *
 * Hovers that do not go through addEventListener on the element itself
 * (inline handlers, stylesheet :hover rules, delegated listeners) are found by
 * lib/page/discovery.js. Still not seen: listeners on window / document,
 * effects on pseudo-elements (::after), :hover rules from a stylesheet of
 * ANOTHER origin (the browser does not let them be read), and effects that do
 * not go through the DOM (a <canvas>). Native browser tooltips are not hovers
 * either (see lib/hovers.js).
 *
 * How it is loaded: run.js and diagnose.js read this file as TEXT and pass it
 * to page.addInitScript, so it is not a module. It must stay a single
 * self-contained script (no require, no import), and it talks to the Node side
 * only through the window.__crawler* globals listed in lib/page/index.js.
 */
(function () {
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  let counter = 0;
  const origAdd = EventTarget.prototype.addEventListener;

  function isLink(el) {
    return el.tagName === 'A' || el.hasAttribute('href');
  }

  // The events a visualization uses to react to the pointer ENTERING an element.
  const HOVER_ENTER = new Set(['mouseover', 'mouseenter', 'pointerover', 'pointerenter']);
  // MOVE events count too, but their effect often depends on WHERE the pointer
  // is (a tooltip that follows it, a guide line): the crawler probes them at two
  // points and warns when the effect changes (see observeAtPositions in lib/crawl/hoverProbe.js);
  // it does not enumerate positions.
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

  // 3. Page ACTIVITY, so the crawler can wait "until it goes quiet" instead of
  //    a fixed settleMs. Two generic signals:
  //    - requestAnimationFrame: d3-timer (and so every D3 transition, and
  //      almost any JS animation) asks for one frame per tick while it
  //      animates and stops asking when it ends.
  //    - in-flight fetch / XHR: d3.json / d3.csv load data after the load
  //      event; until they return the visualization does not even exist.
  //    Limitation: a transition with a long .delay() sleeps through setTimeout
  //    without asking for frames; for those, pass a fixed --settleMs.
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

  // Rounds every number in an attribute: D3 interpolations that "come back" to
  // the same place leave floating-point noise in the last digits
  // (rotate(97.4140204930506) vs rotate(97.41402049305063)), and without this
  // the same logical state gets different fingerprints depending on the path.
  // It also normalizes separators: the same transform may be written
  // "translate(0,12.3)" (user code) or "translate(0, 12.3)"
  // (d3.interpolateTransformSvg when it finishes) depending on how it was reached.
  function roundNumbers(v) {
    return v
      .replace(/-?\d*\.\d+(e[-+]?\d+)?/gi, (m) => {
        const r = Math.round(parseFloat(m) * 100) / 100;
        return String(r === 0 ? 0 : r); // avoids "-0"
      })
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // An invisible element contributes no geometry to the state: D3 often stops
  // updating hidden elements (e.g. the sunburst's clicked() only transitions
  // visible arcs / labels), so their attributes go stale and depend on the path.
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

  // Same for whatever ended up entirely OUTSIDE the visible area of the <svg>
  // (e.g. the out-of-focus nodes of a zoomable icicle, translated past the
  // viewBox): it cannot be seen, and its exact position depends on the path
  // (right at the edge, 890.935 and 890.93499 round differently). The
  // comparison is boolean with half a pixel of tolerance, no rounding.
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

  // Unhashed version, for diagnosis only (see diagnose.js): it shows EXACTLY
  // which attribute changed between two reads that should be identical.
  window.__crawlerStateDebug = function () {
    const sel = window.__crawlerContainerSelector;
    const root = sel ? document.querySelector(sel) : document;
    if (!root) throw new Error('container not found: ' + sel);
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

  // 4. EFFECTS SNAPSHOT: what is visible in the WHOLE document, not just the
  //    <svg> like the state fingerprint. Comparing the one from before a hover
  //    with the one from after shows whether something changed (an HTML
  //    tooltip, say) and what. It is the NET effect: whatever a handler sets
  //    and unsets in the same step leaves no trace. Hidden elements count only
  //    as "hidden": changing something the user cannot see is not an effect.
  //    The snapshot is an array with one entry per element, in document order:
  //      { k: key, p: key of the parent entry, t: tag, h: 1 }              a hidden element
  //      { k, p, t, a: attributes, x: own text, cs?: changed computed styles }   a visible one
  //    (lib/hovers.js compares two snapshots to describe what a hover changed.)
  //    CSS: a stylesheet :hover changes how something looks without touching
  //    any attribute, so when the page has :hover rules (the crawler reports it
  //    in window.__crawlerCssHover) the snapshot also takes a subset of
  //    COMPUTED styles. To avoid sending hundreds of values over the wire, only
  //    the ones that CHANGED relative to the reference snapshot travel (the
  //    one requested with baseline = true).
  const CS_PROPS = [
    'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'opacity', 'display', 'visibility',
    'transform', 'color', 'background-color', 'font-weight', 'font-size', 'text-decoration-line', 'filter',
    'r', 'rx', 'ry', 'width', 'height', 'box-shadow', 'outline-color', 'border-top-color',
  ];
  let csBaseline = null;

  // CSS transitions and animations do not follow the page's fake clock
  // (page.clock): without this a mid-way value would be read. They are taken to
  // their final state; the ones that never end (infinite) are frozen.
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
    const siblingCount = new Map(); // parent -> { tag -> how many so far }
    for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      // The key of an element with a crawler id is that id (it does not change
      // if a sibling appears); for the rest, its position among its own tag.
      // The "id:" format is mirrored by selfKeyOf in lib/hovers.js.
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
      const p = keys.get(el.parentElement) || null; // to group what appears together with its parent

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
    window.__crawlerSelfKey = selfKey; // side channel: not part of what gets compared
    return out;
  };
})();
