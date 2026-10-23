/**
 * Browser side: the simulated pointer. Self-contained, see
 * lib/page/actionability.js (it needs __crawlerMeasure from there). Publishes:
 *   __crawlerHover(selector, where)   put the pointer over the element; false when it cannot be reached
 *   __crawlerUnhover()                take it off; false when it was not over anything
 *   __crawlerPointerNode              the element the pointer is over (read by __crawlerEffects in instrument.js)
 */
function installPointer() {
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
    const { actionable, point } = window.__crawlerMeasure(node, where === 'edge'); // leaves it in view, so the coordinates hold
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

module.exports = { installPointer };
