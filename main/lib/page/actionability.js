/**
 * Browser side: can a real user touch this element NOW?
 *
 * The three functions in lib/page/ run INSIDE the page. Each is installed with
 * page.addInitScript(fn), which serializes it with toString(), so each must be
 * SELF-CONTAINED: no Node closures, no require. They talk to each other and to
 * instrument.js through window.__crawler* globals. This one publishes:
 *   __crawlerMeasure(node, far)  { actionable, visibleFrac, point } for an element
 *   __crawlerIsActionable(node)  just the boolean, leaving the scroll position alone
 * They work even when instrument.js is not used (manual instrumentation with
 * window.__testState).
 */
function installActionability() {
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

  window.__crawlerMeasure = measure;

  window.__crawlerIsActionable = function (node) {
    const sx = window.scrollX, sy = window.scrollY;
    const ok = measure(node).actionable;
    window.scrollTo(sx, sy);
    return ok;
  };
}

module.exports = { installActionability };
