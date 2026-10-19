/**
 * Crawler: explores a D3 visualization by performing gestures (clicks and
 * hovers) and builds the graph of its states, a DFA whose alphabet is the set
 * of actions.
 *
 * TWO NAVIGATION MODES between states:
 *
 *  - FAST (with `backSelector`): assumes hierarchy semantics with a
 *    deterministic "go up one level" action (zoom in / out, breadcrumbs).
 *    It navigates through the common ancestor (up to the common parent, then
 *    down the rest of the path) and never reloads the page during the crawl.
 *    The user has to provide it by hand through config.js (see the README).
 *
 *  - GENERIC (no `backSelector`, the default): assumes nothing about the
 *    semantics. To get back to a state it uses transitions already observed
 *    when there are any; otherwise it reloads the page and replays the whole
 *    path from the root. It works with any visualization, including ones
 *    with no fixed "back".
 *
 * DEPTH-FIRST EXPLORATION: every new state is expanded the moment it is
 * discovered (the page is already standing there, no navigation needed).
 * Once done, its transitions are known, and in almost any zoomable
 * visualization one of them leads "backwards", so returning to the previous
 * state rarely requires a reload.
 *
 * VIRTUAL TIME (the default, with no settleMs): the page clock is replaced
 * with a fake one (Playwright's page.clock) and after every gesture it is
 * advanced until the animation ends. A 750 ms D3 transition resolves in a few
 * real milliseconds, independent of the machine's speed.
 *
 * AUTOMATIC DETECTION (the default, nothing instrumented by hand): when no
 * `clickableSelector` / `stateKeyFn` is passed, the ones instrument.js sets up
 * are used: `[data-crawler-clickable]` for candidates and
 * `window.__crawlerState()` (a DOM fingerprint) for the state. A
 * `window.__testState` defined by the user takes priority (more precise
 * manual instrumentation).
 *
 * DECORATED GRAPH: every discovered state is kept in `graph` together with its
 * path from the initial state and a `visited` mark. A state is never expanded
 * again once visited, and that alone makes the crawl terminate even when the
 * real graph has cycles. As an extra safety net, an unstable
 * stateKeyFn / fingerprint hits a hard step limit (maxSteps) that aborts
 * instead of growing without bound.
 *
 * HOVER: besides clicks, elements that react to the pointer entering or
 * moving over them are probed, with a pointer simulated through events (like
 * the clicks, the browser's mouse is never moved). They are found through an
 * addEventListener (what D3's selection.on does), through a handler in a
 * property or an attribute, through a stylesheet :hover (the state is FORCED
 * through the DevTools protocol, see forceCssHover), and through a listener
 * delegated on a container, probing the D3 marks inside it. A hover enters the
 * automaton only when it changes something visible: a hover that does nothing,
 * or that sits on something a user could not touch, is not an interaction and
 * is not invented. A highlight or a tooltip is one more action of the same
 * state (a loop) with its effect noted; a hover that opens something or leaves
 * a change leads to another state, with its unhover back. Move-type hovers are
 * probed at the center and at the edge, and a warning says when the effect
 * depends on where the pointer is. See lib/hovers.js.
 *
 * Native browser tooltips (an SVG <title> child or a title="" attribute) are
 * deliberately NOT hover actions, and there is no option to count them. D3
 * has no tooltip code (7.9.0 never creates a <title>); the browser draws the
 * tooltip itself, with no listener and no DOM change, so no effect can ever
 * be observed. A hover that cannot be verified would be a phantom. The <title>
 * text is still used to NAME actions (see readableOf).
 */

const { chromium } = require('playwright');
const { actionName, internalName, kindOfAction, unhoverOf } = require('./lib/actions');
const { classifyProbe, describeEffect, selfKeyOf } = require('./lib/hovers');
const { hoverTargets, isVisualProperty } = require('./lib/cssHover');

const ERROR_STATE = '__ERROR__';

let _unknownCounter = 0;

// An ACTION (an alphabet symbol, "Click_vis") is performed with a GESTURE:
// { kind, sel }, the kind of interaction and the selector of the element it is
// done on. Keeping the kind is what lets navigation between states just replay
// gestures without knowing what sort they are.
const click = (sel) => ({ kind: 'click', sel });
const unhover = (sel) => ({ kind: 'unhover', sel });
const gestureKey = (g) => `${g.kind}:${g.sel}`;

// CSS :hover. A pointer simulated with events does not trigger it, so it is
// FORCED through the DevTools protocol (CSS.forcePseudoState) on the element
// and all its ancestors, as a real pointer would, without moving any mouse (so
// no hidden position is left behind). Two verified facts matter here:
//  - DOM.getDocument is requested ONCE per document: requesting it again
//    invalidates the nodeIds, the forced state is orphaned and can no longer
//    be cleared.
//  - So clearing uses the nodeIds saved when forcing, not a fresh lookup.
// It only runs on pages with :hover rules (window.__crawlerCssHover); on the
// rest not even the session is opened.
const cssHoverState = new WeakMap(); // page -> { cdp, rootId, forced: nodeId[] } | false (no CDP)

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

// Forces :hover on the nodes __crawlerHover marked (data-crawler-hover).
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
    session.rootId = null; // the document changed silently: ask again (nothing is forced yet)
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
    await session.cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); // the node may be gone
  }
  session.forced = [];
}

// A fresh page load wipes everything forced, and the nodeIds.
function resetCssHover(page) {
  const session = cssHoverState.get(page);
  if (session) { session.rootId = null; session.forced = []; }
}

// How each kind of gesture is performed on the element `sel`. hover returns
// false when the element can no longer be interacted with (see
// __crawlerHover) and accepts { where: 'edge' } to aim away from the center;
// unhover ignores `sel`: the pointer knows where it is.
const PERFORM = {
  click: (page, sel) => page.$eval(sel, (el) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }),
  hover: async (page, sel, opts) => {
    await clearCssHover(page); // in case the pointer was somewhere else
    // when replaying a path this may be the first hover of the load, so the :hover rules are scanned first
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

// Older checkpoints stored the path and the selectors as strings (everything
// was a click). A node already in the new format is left untouched.
function upgradeGestures(node) {
  const asGesture = (g) => (typeof g === 'string' ? click(g) : g);
  node.path = node.path.map(asGesture);
  if (node.selectors) {
    node.gestures = Object.fromEntries(Object.entries(node.selectors).map(([action, g]) => [action, asGesture(g)]));
    delete node.selectors;
  }
}

// Waiting in virtual time (when no fixed settleMs is passed): the clock is
// jumped CHUNK_MS at a time and the page counts as settled when no requests
// are in flight and no animation frame was requested in the last QUIET_MS
// (virtual). Each jump is fastForward, not runFor: it fires every due timer
// ONCE instead of replaying the ~60 intermediate frames per second. A D3
// transition reaches its final state in 2-3 frames, which is all the
// fingerprint looks at. A tick-based simulation (d3-force) advances one tick
// per jump, hence the cap is on jumps and not on time. The network does run in
// real time: it is polled every POLL_MS.
const POLL_MS = 20;
const CHUNK_MS = 1000;
const QUIET_MS = 100;
const MAX_CHUNKS = 1000;
const NETWORK_MAX_MS = 15000;

/**
 * Helpers that run INSIDE the page. They are installed with
 * page.addInitScript(installPageHelpers), a self-contained function with no
 * Node closures, so they work even when instrument.js is not used (manual
 * instrumentation with window.__testState).
 */
function installPageHelpers() {
  // An element is actionable NOW if a real user could click it: having a
  // listener is not enough. Besides pointer-events / display / visibility it
  // does a real hit test (elementFromPoint) on the visible part of the element,
  // clipped to the viewport and to the <svg> that contains it. That leaves out
  // elements translated outside the viewBox (the out-of-focus nodes of a
  // zoomable icicle / treemap), elements covered by another one, and
  // zero-area ones, without the visualization having to mark them
  // pointer-events:none as the sunburst does.
  //
  // It also measures `visibleFrac`: the (approximate) fraction of the element
  // that falls inside its containing <svg>. A clickable element with
  // visibleFrac < 1 is, say, a neighbouring circle peeking out of the corner of
  // a zoomed circle pack: clicking it is legitimate, but those "sideways"
  // transitions make the graph dense (and the regex explosive), so the report
  // flags them. What falls outside the window does not count (it can be seen by
  // scrolling: an icicle is taller than the crawler's viewport), nor does what
  // is covered by other elements (in a circle pack the children cover the
  // parent, and that is not "not being visible"). Outside an <svg> it is 1.
  // null = could not be measured (a shape too thin for the grid).
  //
  // `point` is where a real user's pointer would be: the point that hits the
  // element closest to the center of the visible part. With `far`, the farthest
  // point from the center that still hits the element (the second sample of a
  // hover whose effect depends on where it is aimed).
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
    // At least 1x1 CSS px visible: besides not being really clickable, below
    // that rounding "slivers" show up (a rect that starts exactly at the edge of
    // the <svg> leaves 0.001px "inside").
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
    // An SVG shape too thin for any grid point to fall inside: we already know
    // it is visible and within the clip, so it is taken as clickable rather
    // than losing the transition.
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    if (points.length === 0) return { actionable: node instanceof SVGGeometryElement, visibleFrac, point: [cx, cy] };
    points.sort(([ax, ay], [bx, by]) => Math.hypot(ax - cx, ay - cy) - Math.hypot(bx - cx, by - cy));
    for (const [x, y] of far ? points.slice().reverse() : points) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === node || node.contains(hit))) return { actionable: true, visibleFrac, point: [x, y] };
    }
    return no;
  }

  // Screen points, inside `clip`, where the hit test is tried. For SVG shapes,
  // only points that fall INSIDE the shape (isPointInFill): the center of a
  // sunburst arc's box often falls in the hole of the ring, not on the arc. For
  // visibleFrac, `total` counts the shape's points before clipping and `inFrame`
  // the ones that fall inside `frame` (the <svg>, whatever the window). For
  // everything else (HTML, <g>), a grid over the visible part of the box.
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
  // _nameOptions picks the shortest suffix that is not taken.
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

  window.__crawlerIsActionable = function (node) {
    const sx = window.scrollX, sy = window.scrollY;
    const ok = measure(node).actionable;
    window.scrollTo(sx, sy);
    return ok;
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
  // `selectors`: { click, hover, container, scan, css }. An element can be a
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

  // The pointer, simulated with synthetic events like the clicks: the browser's
  // mouse is never moved, so no hidden position is left behind to contaminate
  // the state. Events go out in the order a browser fires them when entering an
  // element (pointer events before mouse ones; `over` bubbles, and `enter` goes
  // once per ancestor entered) and, when leaving, the reverse. It always enters
  // from the page background: body and html already "have" the pointer.
  let pointer = null; // { node, chain, x, y } while the pointer "is" over something

  function fire(target, type, x, y, bubbles) {
    const init = { bubbles, cancelable: bubbles, composed: true, view: window, clientX: x, clientY: y, relatedTarget: document.body };
    target.dispatchEvent(type.startsWith('pointer') && typeof PointerEvent === 'function'
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, init));
  }

  // false when the element is missing or no longer actionable: a real user
  // could not put the pointer there. `where` = 'edge' puts it at the point
  // farthest from the center, the second sample of a position-dependent hover.
  window.__crawlerHover = function (selector, where) {
    const node = document.querySelector(selector);
    if (!node) return false;
    window.__crawlerUnhover();
    const sx = window.scrollX, sy = window.scrollY;
    const { actionable, point } = measure(node, where === 'edge'); // leaves it in view, so the coordinates hold
    if (!actionable) { window.scrollTo(sx, sy); return false; }
    const [x, y] = point;
    const chain = [];
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
    fire(node, 'pointerover', x, y, true);
    for (const n of chain) fire(n, 'pointerenter', x, y, false);
    fire(node, 'mouseover', x, y, true);
    for (const n of chain) fire(n, 'mouseenter', x, y, false);
    // a real pointer entering an element also sends a move at that point
    fire(node, 'pointermove', x, y, true);
    fire(node, 'mousemove', x, y, true);
    // The CSS :hover is forced by the crawler through the DevTools protocol, on
    // the element and ALL its ancestors (like a real pointer); this mark tells
    // it which ones.
    if (window.__crawlerCssHover === true) for (let n = node; n; n = n.parentElement) n.setAttribute('data-crawler-hover', '1');
    pointer = { node, chain, x, y };
    window.__crawlerPointerNode = node; // so the effects snapshot knows which element was touched
    window.scrollTo(sx, sy);
    return true;
  };

  // false when the pointer was not over anything
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

// Possible names for the action, from the shortest to the most specific.
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

// An element whose readable name CHANGES with the state cannot carry any of
// those names: the symbol belongs to the element, not to the state. The typical
// case is the sunburst's center circle, which every click re-binds to the
// focus's parent (parent.datum(p.parent)), so in each state it "says" a
// different node. When the crawl ends, those actions are renamed after their
// SVG / HTML tag ("Click_circle"). It reads node.labels, which keeps what was
// seen in each state (and travels in the checkpoint, so it also works on resume).
function renameUnstableActions(graph) {
  const seen = new Map(); // action -> { readables: Set, tag }
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
    // '#n' and not '_n': lib/names.js strips "_<number>" suffixes
    const kind = kindOfAction(action);
    let name = actionName(kind, tag);
    for (let k = 2; taken.has(name); k++) name = actionName(kind, `${tag}#${k}`);
    taken.delete(action);
    taken.add(name);
    rename.set(action, name);
  }
  // The way back of a hover (Unhover_X) is not a candidate and has no label of
  // its own: it is named after its hover.
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

// An action's name belongs to the ELEMENT, not to the state: the same element
// has to be the same alphabet symbol in every state (otherwise the automaton
// and its regex mean nothing). So it is assigned once per crawl and reused.
function createNaming(graph = null) {
  const byGesture = new Map();
  const taken = new Set();
  // when resuming a checkpoint, respect the names already used
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
    // A hover on the outer <svg> is "the background", like its click; without
    // this it would be named after all the text it contains.
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
  // Elements only found when discovering (inline handler, CSS :hover, mark of a
  // delegated listener) have no crawler id: see stableSelector.
  if (info.selector) return info.selector;
  throw new Error('elemento interactuable sin identidad estable');
}

// Generic "actionable now" filter for a loose locator (used by diagnose.js).
// Requires installPageHelpers in the page.
function isActionable(locator) {
  return locator.evaluate((node) => window.__crawlerIsActionable(node));
}

// The actionable candidates of the current state, already named:
// [[action, gesture, info], ...]. Clicks first and hovers after (one element
// can be in both), so the order in which clicks are explored does not depend on
// whether there are hovers. `selectors`: { click, hover }. Requires
// installPageHelpers in the page.
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
 * Clicks `sel` and measures when the state stops changing: it reads every
 * `pollMs` and counts the page as settled once `quietMs` pass with no change.
 * Returns the instant (ms since the click) of the last change observed, or
 * null when it is still changing on reaching `maxMs`. Used by diagnose.js.
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
 * @param {string} [opts.chromePath] - Playwright's bundled Chromium when omitted.
 * @param {string} [opts.clickableSelector='[data-crawler-clickable]']
 * @param {boolean} [opts.hover=true] - also probe hovers (elements with a
 *   mouseover / mouseenter / pointerover / pointerenter listener). A hover
 *   enters the automaton only when it changes something visible (see lib/hovers.js).
 * @param {string} [opts.hoverableSelector='[data-crawler-hoverable]']
 * @param {number} [opts.maxDelegated=50] - cap on the D3 marks probed for each
 *   delegated listener (0 = do not probe delegated listeners)
 * @param {(msg: string) => void} [opts.onLog] - crawl warnings (hovers that are skipped)
 * @param {(rawState: any) => string} [opts.stateKeyFn=(raw)=>raw]
 * @param {string[]} [opts.initScripts] - JS code to inject before the user's page
 *   runs (through page.addInitScript), e.g. the contents of instrument.js for
 *   automatic detection.
 * @param {string} [opts.backSelector] - see the modes above. Generic mode
 *   (reload + replay) when omitted.
 * @param {number} [opts.settleMs] - FIXED pause after every gesture. When
 *   omitted (or null) the wait is adaptive: after every gesture or load it waits
 *   until the state stops changing, no requests are in flight and no animation
 *   frames are requested (see window.__crawlerActivity in instrument.js), so it
 *   depends neither on a number picked by eye nor on which element is clicked to
 *   measure it.
 * @param {number} [opts.discoverySettleMs] - settle used specifically when
 *   re-entering a state before listing its candidates. Defaults to settleMs
 *   (fixed or adaptive).
 * @param {number} [opts.maxStates=1000] - when reached, the result is returned
 *   with `truncated: true`.
 * @param {number} [opts.maxSteps=20000] - hard cap on total interactions.
 * @param {(state, transitions, snapshot) => void} [opts.onStateExpanded] -
 *   progress / checkpoint hook.
 * @param {Object} [opts.resume] - { graph: [[state,node],...], queue: string[], initialState }
 *   produced by an earlier checkpoint (see snapshot in onStateExpanded).
 * @returns {Promise<{transitions: Object, initialState: string, visibility: Object, renamed: Object, usedManualState: boolean, truncated: boolean}>}
 *   visibility: state -> action -> visible fraction, only for clicks on
 *   elements that were partly visible (see measure in installPageHelpers)
 *   renamed: action -> new name, for the ones that showed a different name
 *   depending on the state (see renameUnstableActions)
 *   labels: state -> action -> full readable name of the element IN that state
 *   (e.g. "flare/vis/operator"); lib/labels.js uses it to name the states by
 *   their place in the hierarchy
 *   effects: state -> hover action -> what changes (see describeEffect in lib/hovers.js)
 *   ignoredHovers: [{ action, reason, states }] hovers with a listener that are
 *   NOT an action (they do nothing visible, never settle, the page changes by itself...)
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
  // the :hover rule parser is the same one the tests use (lib/cssHover.js)
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
        err.code = 'NO_SETTLE'; // probeHover tells it apart: such a hover is ignored, it does not bring the crawl down
        throw err;
      }
      await page.clock.fastForward(CHUNK_MS);
      chunks++;
    }
  }

  function settle(wait) {
    return wait == null ? virtualSettle() : page.waitForTimeout(wait);
  }

  // Performs a gesture and waits for the page to settle. Returns whatever the
  // gesture returns (for hover, false when the element could no longer be
  // touched). After a click the pointer is left outside: the page may arrive
  // with it over something (a hover that opened a menu), and the state that is
  // read has to be the click's, not the click's plus a lingering highlight a
  // real user would not see.
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

  // decorated graph: state -> { path: gesture[], visited: bool, transitions: {}, gestures: {} }
  // (gestures: action -> gesture, so already known transitions can be redone
  // when navigating without reloading; see knownRoute)
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

  // Without instrument.js (manual state with window.__testState) there is no
  // way to see whether a hover changed anything, and without that a real hover
  // cannot be told from one that does nothing: better to probe none than to
  // invent them.
  if (hover && !(await page.evaluate(() => typeof window.__crawlerEffects === 'function'))) {
    hover = false;
    log('hover: sin instrument.js no se ve qué cambia un hover; no se prueban hovers');
  }
  const selectors = {
    click: clickableSelector,
    hover: hover ? hoverableSelector : null,
    container: containerSelector,
    scan: true, // inline handlers (onclick / onmouseover...), which do not go through addEventListener
    css: hover, // stylesheet :hover rules
  };
  // `baseline`: the reference snapshot the page computes style changes against
  // (see __crawlerEffects); it is requested only with the one taken BEFORE a hover.
  const readEffects = (baseline = false) => page.evaluate((b) => window.__crawlerEffects(b), baseline);
  // The page's :hover rules: scanned after every load, before the reference snapshot.
  let cssBlockedWarned = false;
  const scanCss = async () => {
    const blocked = await page.evaluate(() => { window.__crawlerScanCss(); return window.__crawlerCssBlocked || 0; });
    if (blocked > 0 && !cssBlockedWarned) {
      cssBlockedWarned = true;
      log(`hover: ${blocked} hoja(s) de estilo de otro origen no se pueden leer; sus reglas :hover no se ven`);
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Shortest sequence of already observed gestures from `from` to `to`, or null.
  function knownRoute(from, to) {
    if (!graph.has(from)) return null;
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length > 0) {
      const s = q.shift();
      if (s === to) break;
      const n = graph.get(s);
      if (!n || !n.gestures) continue; // old checkpoints did not store selectors
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

    // generic mode
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

  // Replays known gestures. A hover that can no longer be done (the element
  // stopped being actionable) means the page does not behave as it did when the
  // path was discovered: with `strict` it aborts, otherwise it returns false so
  // the caller can try another path.
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

  // Does the page change by itself over time (a clock, a loose animation)? If
  // so there is no way to know whether what changed after a hover was caused by
  // the hover: all of them would look effective. It is checked by letting time
  // pass without touching anything.
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

  // Puts the pointer over the element of `gesture` in `state`, looks at what
  // changed and takes it off. `where` = 'edge' aims away from the center.
  // Returns what was observed, or { problem } when the hover could not be done,
  // or { broke } when it threw an exception in the page.
  async function observeHover(state, gesture, found, where) {
    await navigateTo(state, settleMs);
    // What is observed is compared with what was in `state`: if navigation did
    // not get there (fast mode does not verify it), the comparison is worthless.
    if ((await readState()) !== state) return { problem: 'la navegación no llegó a este estado' };
    currentState = state;
    await scanCss();
    const before = await readEffects(true);
    try {
      if ((await perform(gesture, settleMs, { where })) === false) return { problem: 'ya no era interactuable' };
      if (errors.length > 0) return { broke: true };
      const after = await readEffects();
      // With the pointer over it: the state key and what can be done, but only
      // if something changed (otherwise the hover is dropped and it is not needed).
      const changed = !same(before, after);
      const hoveredKey = changed ? await readState() : null;
      const whileHovered = changed ? await discoverCandidates(page, selectors, nameFor) : [];
      // the snapshot key of the touched element (left by __crawlerEffects): lets a change be reported as "its own"
      const selfKey = changed ? await page.evaluate(() => window.__crawlerSelfKey || null) : null;
      await perform(unhover(gesture.sel), settleMs);
      if (errors.length > 0) return { broke: true };
      return { before, after, restored: await readEffects(), hoveredKey, whileHovered, selfKey };
    } catch (e) {
      if (e.code !== 'NO_SETTLE') throw e;
      return { problem: 'no se asienta (animación continua)' };
    }
  }

  let fastModeWarned = false; // the fast-mode warning, once

  // Probes the hover `gesture` in `state` and decides what it is (see lib/hovers.js):
  //  - if nothing visible changes it is NOT an action and is dropped;
  //  - if it is a highlight or a tooltip (what can be done does not change) it
  //    is one more action of the same state, with its effect noted;
  //  - if it opens something or leaves a change, it leads to another state, with
  //    its way back.
  // Except in that last case, the page is left with the pointer outside.
  // `info.moves`: the element has move listeners, whose effect may depend on
  // where the pointer is, so it is probed at the center and away from it.
  // `quiet`: do not note "no effect" (the marks of a delegated listener are
  // counted together on the container). Returns 'effect', 'inert' or 'problem'.
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
        if (!nearChanged && farChanged) seen = far; // the effect shows up at another point: the action exists
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
      // if it did not revert, the key may be another one (the change only shows after leaving)
      currentState = verdict.reverted ? state : await readState();
      return 'effect';
    }

    // structural: another state, the one with the pointer over it
    if (backSelector) {
      // fast mode navigates through the common ancestor: it cannot follow a hover that changes state
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

    // If taking the pointer off leaves the same key, the state is the same with
    // or without it (the hover left a change): there is no "state with the
    // pointer over it" and no way back to take; an unhover from a state to
    // itself would be a step a user cannot repeat.
    const withPointer = leftKey !== hoveredKey;
    let hovered = graph.get(hoveredKey);
    const isNew = !hovered;
    if (isNew) {
      hovered = { path: [...node.path, gesture], visited: false, transitions: {}, gestures: {} };
      if (withPointer) Object.assign(hovered, { pointer: gesture, enabled: verdict.revealed });
      graph.set(hoveredKey, hovered);
    }
    // The way back exists when that state is one with the pointer over it (if
    // the same look is reached by clicking, taking the pointer off does nothing).
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

  // A DELEGATED listener (a single one, on a container, that looks at
  // event.target) does nothing when probed on the container itself: the target
  // is the container. For those, the D3 marks inside are probed (see
  // __crawlerMarks): the event starts at the mark and bubbles up to the
  // listener, with the mark's coordinates, so it works for handlers that read
  // event.target.__data__ as well as ones that look at the position.
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

  // Expands `state` and, depth-first, every new state it discovers.
  async function expand(state) {
    const node = graph.get(state);
    node.visited = true;
    // Explicit and not `undefined`: JSON does not keep `undefined`, and when
    // resuming a checkpoint a half-expanded node has to look NOT expanded.
    node.expanded = false;
    node.gestures = node.gestures || {};

    await navigateTo(state, discoverySettleMs);
    const found = await discoverCandidates(page, selectors, nameFor);
    // With the pointer over something (a state a hover led to) only the clicks
    // that hover enables, and the element's own, are followed: to click anything
    // else the user has to take the pointer off, and that is already the way
    // back (unhover). No more hovers are probed from there either.
    const candidates = node.pointer
      ? found.filter(([, g]) => g.kind === 'click' && (g.sel === node.pointer.sel || node.enabled.includes(gestureKey(g))))
      : found;

    let drifting = null; // looked at once per state, before the first hover
    const containers = []; // hovers with no effect of their own: if the listener is a container's, it may be delegated
    for (const [action, gesture, info] of candidates) {
      if (action in node.transitions) continue;
      const { visibleFrac, readable, tag } = info;
      node.labels = node.labels || {};
      node.labels[action] = { readable, tag };
      // Only the ones that are partly visible (rounded to 2 decimals): they are
      // what the report flags (see measure in installPageHelpers).
      if (gesture.kind === 'click' && visibleFrac != null && Math.round(visibleFrac * 100) < 100) {
        node.visibility = node.visibility || {};
        node.visibility[action] = Math.round(visibleFrac * 100) / 100;
      }
      countStep();

      if (gesture.kind === 'hover') {
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
        if (result === 'inert' && info.sources.some((s) => s === 'listener' || s === 'inline')) {
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

  // states were discovered but not expanded: cut short by maxStates
  const truncated = [...graph.values()].some((n) => !n.expanded);
  const renamed = Object.fromEntries(renameUnstableActions(graph));

  const transitions = {};
  const visibility = {};
  const labels = {};
  const effects = {};
  const ignored = new Map(); // `action\0reason` -> in how many states
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
