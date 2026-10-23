/**
 * Browser side: which elements can be interacted with, and what to call them.
 * Self-contained, see lib/page/actionability.js (it needs __crawlerMeasure from
 * there). Publishes:
 *   __crawlerScanCss()                 the elements that receive a stylesheet :hover
 *   __crawlerCandidates(selectors)     every actionable candidate, described
 *   __crawlerMarks(selector, limit)    the D3 marks inside a delegated-listener container
 * and leaves __crawlerCssHover / __crawlerCssBlocked for the effects snapshot
 * in instrument.js and for lib/page/pointer.js.
 *
 * What the crawler gets back for each candidate element:
 *
 * @typedef {Object} Candidate
 * @property {string|null} dataName - its data-name attribute (an author-given identity)
 * @property {string} cls - its class attribute ('' when none)
 * @property {string|null} crawlerId - the data-crawler-id instrument.js gave it when a listener was added
 * @property {string|null} readable - what to call it: its <title>, aria-label, short text, or its D3 datum
 * @property {string} tag - lower-case tag name
 * @property {boolean} isRootSvg - the outer <svg> itself (a click on the background)
 * @property {string|null} selector - a DOM-only selector, for elements with no dataName / crawlerId
 * @property {boolean} moves - it has pointer-move listeners, so its hover may depend on where it is aimed
 * @property {number|null} visibleFrac - fraction of the element inside its <svg> (1 outside an <svg>), null if it could not be measured
 * @property {('click'|'hover')[]} kinds - which interactions it supports
 * @property {('listener'|'inline'|'css'|'delegated')[]} sources - how each was found
 */
function installDiscovery() {
  const measure = (node) => window.__crawlerMeasure(node);

  // What is needed to name an action, read LIVE when the candidate is
  // discovered (not when its listener is detected), because in D3 the <title>
  // is often appended on a line after .on("click", ...).
  // Only the first line of a <title> counts: the typical D3 tooltip is
  // "flare/vis\n432,629" (path + value), and the value does not identify the
  // node; it only pollutes the action's name.
  function titleText(t) {
    if (!t) return null;
    const first = t.textContent.split('\n').map((l) => l.trim()).find(Boolean);
    return first || null;
  }

  function readableOf(node) {
    const own = titleText(node.querySelector(':scope > title'));
    if (own) return own;
    // D3 "cell" pattern: <g><rect (clickable)/><text/><title/></g>, where the
    // tooltip is a sibling, not a child. Only when the parent is a <g>: further
    // up it no longer describes this particular element.
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

  // A name from the datum D3 bound to the element (`__data__`, what .data() and
  // .datum() set). Needed when the clickable element has no <title> or text of
  // its own and the visible label is ANOTHER element bound to the same datum,
  // as in the circle pack, where <circle>s and <text>s live in separate groups
  // tied together only by the datum. For a d3.hierarchy node the ancestor path
  // is built ("flare/vis/data"), in the same shape as typical tooltips, so
  // nameOptions (lib/crawl/naming.js) picks the shortest suffix that is not taken.
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
    // d3.pie and similar wrap the original datum in .data
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

  // A selector for an element WITHOUT data-crawler-id: the ones only found when
  // candidates are discovered (inline handlers, :hover rules, marks of a
  // delegated listener). Crawler ids come from a counter at listener
  // registration, in load order; assigning them later would give ids that
  // depend on the path walked and that do not exist after a reload and replay.
  // This selector, instead, depends on the DOM alone.
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

  // The stylesheet :hover rules -> which elements receive the hover (the
  // parser is lib/cssHover.js, injected as window.__crawlerHoverTargets). A rule
  // that only declares cursor, transition and the like changes nothing about how
  // anything looks, and is dropped here. Cross-origin stylesheets cannot be read
  // (SecurityError): they are counted in window.__crawlerCssBlocked. The result
  // is only recomputed when the sheets changed. Leaves window.__crawlerCssHover
  // true when there is any rule: that is what tells the effects snapshot to also
  // look at computed styles.
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
          // @media / @supports / @layer: only when it applies now
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

  // A candidate's description: what the crawler needs to name it and to find it again.
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
      // the outer <svg> with a click of its own: in D3 usually "click on the
      // background" (say, zooming out to the root in the circle pack)
      isRootSvg: node instanceof SVGSVGElement && !node.ownerSVGElement,
      // only for those with no other stable identity: the ones only found when
      // discovering (see stableSelector)
      selector: crawlerId || dataName || cls.includes('center-circle') ? null : stableSelector(node),
      moves: node.hasAttribute('data-crawler-moves'),
      visibleFrac,
    };
  }

  const HOVER_PROPS = ['onmouseover', 'onmouseenter', 'onpointerover', 'onpointerenter', 'onmousemove', 'onpointermove'];

  // Every actionable candidate in ONE round trip to the browser (with hundreds
  // of elements, asking one by one from Node dominates the time of each state).
  // `selectors`: { click, hover, container, css }. An element can be a
  // candidate of both kinds (a circle with mouseover and click) and is measured
  // once; `kinds` says which ones and `sources` where it was found:
  //   listener  an addEventListener on the element itself (marked by instrument.js)
  //   inline    a handler in the property (el.onmouseover = fn) or in the
  //             attribute (onmouseover="..."): both show up in the property
  //   css       a stylesheet :hover (see __crawlerScanCss)
  window.__crawlerCandidates = function (selectors) {
    const sx = window.scrollX, sy = window.scrollY;
    const nodes = new Set();
    for (const sel of [selectors.click, selectors.hover]) {
      if (sel) for (const node of document.querySelectorAll(sel)) nodes.add(node);
    }

    // the ones that did not go through an addEventListener on the element itself
    const extra = new Map(); // node -> { kinds: Set, sources: [], moves? }
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
      for (const el of everyone) {
        if (typeof el.onclick === 'function') addExtra(el, 'click', 'inline');
        if (!selectors.hover) continue;
        for (const prop of HOVER_PROPS) {
          if (typeof el[prop] === 'function') addExtra(el, 'hover', 'inline', prop.endsWith('move') ? { moves: true } : null);
        }
      }
      if (selectors.css) {
        for (const target of window.__crawlerScanCss()) {
          let matching;
          try { matching = everyone.filter((el) => el.matches(target)); } catch (e) { continue; }
          for (const el of matching) addExtra(el, 'hover', 'css');
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
      out.push(info);
    }
    window.scrollTo(sx, sy);
    return out;
  };

  // The D3 marks inside a container with a DELEGATED listener (a single one that
  // looks at event.target): the descendants that carry a datum of their own
  // (__data__, D3's signature), that can be touched now, that are not candidates
  // by themselves, and one per datum. D3 hands the datum to whatever is
  // appended, so a <g> and its <circle> share it: the outermost one is kept.
  // Returns at most `limit`, and how many there were.
  window.__crawlerMarks = function (selector, limit) {
    const container = document.querySelector(selector);
    if (!container) return { marks: [], total: 0 };
    const sx = window.scrollX, sy = window.scrollY;
    const accepted = [];
    const marks = [];
    for (const el of container.querySelectorAll('*')) {
      if (!Object.prototype.hasOwnProperty.call(el, '__data__') || el.__data__ == null) continue;
      if (el.hasAttribute('data-crawler-hoverable')) continue; // already a candidate
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
}

module.exports = { installDiscovery };
