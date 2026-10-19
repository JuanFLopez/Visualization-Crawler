/**
 * Draws a DFA (the same object automaton.js or regex.js produce) as an SVG,
 * meant for READING the automaton of an interactive visualization:
 *
 *  - Layered layout from left to right. When state names are hierarchy paths
 *    ("root > vis > operator", see lib/labels.js) the column is the level in
 *    the hierarchy and each state sits next to its parent; otherwise the
 *    column is the depth (BFS) from the initial state, grouped by the state
 *    each one was discovered from.
 *  - "Forward" edges (to the next column): solid, with the label next to the
 *    target (they do not overlap even when many leave the same state).
 *  - "Backward" edges or edges within the same column (going back, zoom out):
 *    dotted and faint, with the label under the SOURCE; there are many and
 *    almost always the same action, so they should not cover the rest.
 *  - Action names without the "Click_" prefix (hover ones keep it and are
 *    drawn in green); an edge that groups many actions is abbreviated, and the
 *    full detail is in the tooltip (<title>) of every state and edge.
 *  - Optional text blocks at the bottom (e.g. the equivalent regex).
 */

const { displayAction, verbOf } = require('./actions');

const ERROR_STATE = '__ERROR__';

const FONT = 12;
const CHAR_W = 7; // approximate width per character in 12px sans-serif
const MONO_CHAR_W = 6.6; // 11px monospace
const NODE_H = 32;
const ROW_GAP = 24;
const COL_GAP = 230; // minimum gap between columns; wider when the edge labels need it (see layout)
const LABEL_CHAR_W = 6; // approximate width per character of an 11px edge label
const EDGE_STEM = 90; // visible length of an arrow's shaft beside its label
const MARGIN = 40;
const MAX_EDGE_LABEL = 26;
const LANE_GAP = 24; // gap between the columns and the lane of an edge that skips them
// Arrowheads are sized in user-space px (markerUnits="userSpaceOnUse"), so they do not
// shrink or grow with the stroke width of the edge that carries them.
const ARROW = 13, ARROW_SMALL = 11, ARROW_HL = 15, ARROW_HOVER = 12;

// States to draw: the ones with a row in the table PLUS the ones that only
// appear as a target (e.g. the crawler's __ERROR__, which is never expanded).
function drawnStates(dfa) {
  const all = new Set(dfa.states());
  for (const symbolMap of dfa.transitions.values()) {
    for (const to of symbolMap.values()) all.add(to);
  }
  return [...all];
}

function defaultLabel(state) {
  // "prettified" states (see lib/labels.js) use " > " as the path separator
  // ("root > A > A1"); hand-built names (window.__testState) usually use "/"
  // ("root/A"). Both are tried.
  const bySeparator = state.includes(' > ') ? state.split(' > ') : state.split('/');
  const last = bySeparator.pop();
  return last.length > 24 ? last.slice(0, 23) + '…' : last;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function abbreviate(symbols) {
  const names = symbols.map(displayAction);
  const full = names.join(', ');
  if (full.length <= MAX_EDGE_LABEL || names.length === 1) return full;
  let out = names[0];
  let k = 1;
  while (k < names.length && (out + ', ' + names[k]).length <= MAX_EDGE_LABEL - 6) out += ', ' + names[k++];
  return `${out} +${names.length - k}`;
}

// Splits a long text into lines of at most `maxChars`, cutting at spaces
// when possible (the regex has spaces between tokens).
function wrapText(text, maxChars) {
  const lines = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest) lines.push(rest);
  return lines;
}

// --- layered layout ---
function layout(dfa, labelFn) {
  const states = drawnStates(dfa);
  const depth = new Map([[dfa.initial, 0]]);
  const parent = new Map();
  const order = new Map([[dfa.initial, 0]]); // discovery order
  const queue = [dfa.initial];
  while (queue.length) {
    const s = queue.shift();
    for (const to of (dfa.transitions.get(s) || new Map()).values()) {
      if (depth.has(to) || to === ERROR_STATE) continue;
      depth.set(to, depth.get(s) + 1);
      parent.set(to, s);
      order.set(to, order.size);
      queue.push(to);
    }
  }
  // If every name is a path hanging from the initial state ("root > vis >
  // operator", see lib/labels.js), the column is the LEVEL in that path and
  // not the click distance: in a sunburst "operator" (level 2) is one click
  // from the root, and by BFS it would land in the column of "vis", so
  // vis -> operator would look like a sideways move. Names built from click
  // paths also satisfy this, and there level = BFS distance, so their layout
  // does not change.
  const SEP = ' > ';
  const named = states.filter((s) => s !== ERROR_STATE);
  const hierarchical = named.every((s) => s === dfa.initial || s.startsWith(dfa.initial + SEP));
  if (hierarchical) {
    const base = dfa.initial.split(SEP).length;
    const stateSet = new Set(named);
    for (const s of named) {
      const segs = s.split(SEP);
      depth.set(s, segs.length - base);
      const up = segs.slice(0, -1).join(SEP);
      if (s !== dfa.initial && stateSet.has(up)) parent.set(s, up);
      if (!order.has(s)) order.set(s, order.size);
    }
  }

  // unreachable states and __ERROR__: columns of their own at the end
  let maxDepth = Math.max(0, ...depth.values());
  const unreachable = states.filter((s) => !depth.has(s) && s !== ERROR_STATE);
  if (unreachable.length) { maxDepth++; unreachable.forEach((s) => { depth.set(s, maxDepth); order.set(s, order.size); }); }
  if (states.includes(ERROR_STATE)) { depth.set(ERROR_STATE, maxDepth + 1); order.set(ERROR_STATE, order.size); }

  const columns = [];
  for (const s of states) {
    const d = depth.get(s);
    (columns[d] = columns[d] || []).push(s);
  }
  for (let d = 0; d < columns.length; d++) {
    columns[d] = columns[d] || [];
  }

  // width of each node according to its label
  const size = new Map(states.map((s) => [s, { w: Math.max(56, labelFn(s).length * CHAR_W + 22), h: NODE_H }]));

  // The gap in front of a column has to leave the arrows a visible shaft beside
  // their labels: a forward edge's label sits against its target, so the gap is
  // the widest label that ends in that column plus EDGE_STEM (never below COL_GAP).
  const arriving = new Map(); // state -> symbols of the edges that reach it from an earlier column
  for (const [from, symbolMap] of dfa.transitions) {
    for (const [symbol, to] of symbolMap) {
      if (depth.get(to) <= depth.get(from)) continue;
      if (!arriving.has(to)) arriving.set(to, new Set());
      arriving.get(to).add(symbol);
    }
  }
  const labelWidth = (s) => (arriving.has(s) ? abbreviate([...arriving.get(s)]).length * LABEL_CHAR_W : 0);
  const gapBefore = columns.map((col) => Math.max(COL_GAP, EDGE_STEM + 24 + Math.max(0, ...col.map(labelWidth))));

  const pos = new Map();
  const colX = [];
  const cols = []; // extent of each column: {left, right, top, bottom}
  let x = MARGIN + 70; // room for the initial-state arrow
  let lastGap = 0;
  const tallest = Math.max(...columns.map((c) => c.length));
  const fullHeight = tallest * (NODE_H + ROW_GAP);
  for (let d = 0; d < columns.length; d++) {
    const col = columns[d];
    // group by parent (in the order the parents ended up in), and within each
    // group by discovery order
    const rank = (s) => (parent.has(s) && pos.has(parent.get(s)) ? pos.get(parent.get(s)).y : -1);
    col.sort((a, b) => rank(a) - rank(b) || order.get(a) - order.get(b));
    const colW = Math.max(0, ...col.map((s) => size.get(s).w));
    colX[d] = x;
    const colHeight = col.length * (NODE_H + ROW_GAP);
    let y = MARGIN + (fullHeight - colHeight) / 2;
    cols[d] = { left: x, right: x + colW, top: y, bottom: y + colHeight - ROW_GAP, labelW: Math.max(0, ...col.map(labelWidth)) };
    for (const s of col) {
      const { w, h } = size.get(s);
      pos.set(s, { x: x + (colW - w) / 2, y, w, h, cx: x + colW / 2, cy: y + h / 2, depth: depth.get(s) });
      y += NODE_H + ROW_GAP;
    }
    lastGap = gapBefore[d + 1] ?? COL_GAP;
    x += colW + lastGap;
  }
  const width = x - lastGap + MARGIN;
  const height = MARGIN * 2 + fullHeight;
  return { pos, cols, width, height, hierarchical };
}

// A forward edge that SKIPS columns (in practice the ones going to __ERROR__,
// which has a column of its own at the end): a direct curve would pass behind
// the states of the intermediate columns, all of them centred on the same
// line as the source and the target, so it would look like it leaves the
// middle state of each. It is routed above or below the intermediate columns
// (the shorter side), with rounded corners.
function skipEdgePath(pa, pb, cols, offsetX) {
  const between = cols.slice(pa.depth + 1, pb.depth);
  const top = Math.min(...between.map((c) => c.top)) - LANE_GAP;
  const bottom = Math.max(...between.map((c) => c.bottom)) + LANE_GAP;
  const lane = Math.abs(pa.cy - top) + Math.abs(pb.cy - top) <= Math.abs(pa.cy - bottom) + Math.abs(pb.cy - bottom) ? top : bottom;
  const x1 = pa.x + pa.w, y1 = pa.cy, x2 = pb.x - 2, y2 = pb.cy;
  // Vertical drops just right of the source column and, at the target, left of
  // the labels of the edges that arrive there (they sit against the nodes), so
  // the drop does not cut through them.
  const xa = cols[pa.depth].right + offsetX + 16;
  const xb = cols[pb.depth].left + offsetX - 18 - cols[pb.depth].labelW - 14;
  const r = 10;
  const dir = (from, to) => (to > from ? 1 : -1);
  const d1 = dir(y1, lane), d2 = dir(lane, y2);
  return [
    `M ${x1},${y1}`,
    `L ${xa - r},${y1} Q ${xa},${y1} ${xa},${y1 + d1 * r}`,
    `L ${xa},${lane - d1 * r} Q ${xa},${lane} ${xa + r},${lane}`,
    `L ${xb - r},${lane} Q ${xb},${lane} ${xb},${lane + d2 * r}`,
    `L ${xb},${y2 - d2 * r} Q ${xb},${y2} ${xb + r},${y2}`,
    `L ${x2},${y2}`,
  ].join(' ');
}

/**
 * @param {import('./automaton').DFA} dfa
 * @param {Object} [opts]
 * @param {(state:string)=>string} [opts.labelFn] - text inside the state (default: last segment of the path)
 * @param {string[]} [opts.highlightPath] - sequence of symbols (e.g. a counterexample from diff.js) to highlight in red
 * @param {{title: string, text: string, color?: string}[]} [opts.footer] - text blocks at the bottom (e.g. the regex)
 * @param {Object<string, string>} [opts.notes] - action -> what it does (a hover's effect), for the tooltip of its edges
 * @param {number} [opts.minWidth=900]
 * @returns {string} complete SVG, ready to be written to a .svg file
 */
function toSVG(dfa, opts = {}) {
  const { labelFn = defaultLabel, highlightPath = [], footer = [], notes = {}, minWidth = 900 } = opts;
  const { pos, cols, width: layoutW, height: graphH, hierarchical } = layout(dfa, labelFn);
  // The label of a hover loop goes to the right of its node: in the last
  // column it would fall outside the drawing, so room is left for it.
  const loopsOnEdge = [...dfa.transitions].some(([from, m]) => pos.get(from) && pos.get(from).depth === cols.length - 1
    && [...m].some(([symbol, to]) => to === from && verbOf(symbol) !== 'click'));
  const graphW = layoutW + (loopsOnEdge ? 200 : 0);
  const width = Math.max(minWidth, graphW);
  const offsetX = (width - graphW) / 2;

  // which edges (from, symbol) are on the highlighted path
  const highlighted = new Set();
  let cur = dfa.initial;
  for (const symbol of highlightPath) {
    const next = dfa.step(cur, symbol);
    if (next === null) break;
    highlighted.add(`${cur}\u0000${symbol}`);
    cur = next;
  }

  // Group transitions by (from, to) pair; the pointer ones (Hover_/Unhover_)
  // get an edge of their own, so they can be drawn differently from clicks.
  const pairs = new Map();
  for (const [from, symbolMap] of dfa.transitions) {
    for (const [symbol, to] of symbolMap) {
      const pointer = verbOf(symbol) !== 'click';
      const key = `${from}\u0000${to}\u0000${pointer ? 1 : 0}`;
      if (!pairs.has(key)) pairs.set(key, { from, to, symbols: [], pointer });
      pairs.get(key).symbols.push(symbol);
    }
  }
  const hasPointer = [...pairs.values()].some((p) => p.pointer);
  // green: hover (one more colour, not the only cue: the name carries its prefix)
  const HOVER = { edge: '#1b8a82', side: '#7fc4be', back: '#8fcac5', text: '#1b7f79' };

  // --- footer: wrapped text blocks ---
  const maxChars = Math.floor((width - 2 * MARGIN) / MONO_CHAR_W);
  const footerBlocks = footer.map((b) => ({ ...b, lines: b.text.split('\n').flatMap((l) => wrapText(l, maxChars)) }));
  const footerH = footerBlocks.reduce((h, b) => h + 26 + b.lines.length * 15 + 10, footer.length ? 20 : 0);
  const legendH = hasPointer ? 62 : 44;
  const height = graphH + legendH + footerH;

  const P = (p) => ({ ...p, x: p.x + offsetX, cx: p.cx + offsetX });
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif" font-size="${FONT}">`,
    `<title>Autómata (${drawnStates(dfa).length} estados)</title>`,
    `<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${ARROW}" markerHeight="${ARROW}" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#555"/></marker>
  <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${ARROW_SMALL}" markerHeight="${ARROW_SMALL}" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#b5b5b5"/></marker>
  <marker id="arrow-side" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${ARROW_SMALL}" markerHeight="${ARROW_SMALL}" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#9bb7d4"/></marker>
  <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${ARROW_HL}" markerHeight="${ARROW_HL}" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#d33"/></marker>${hasPointer ? `
  <marker id="arrow-hover" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${ARROW_HOVER}" markerHeight="${ARROW_HOVER}" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="${HOVER.edge}"/></marker>` : ''}
</defs>`,
    `<rect width="${width}" height="${height}" fill="white"/>`
  );

  const backLayer = [], forwardLayer = [], labelLayer = [];
  const backLabels = new Map(); // from -> Set of symbols that "go back"
  const forwardLabels = new Map(); // to -> Set of symbols arriving from the left
  const sideLabels = new Map(); // from -> Set of symbols to the same column
  const skipLabels = new Map(); // from -> Set of symbols that skip columns (e.g. to __ERROR__)
  const loopsDrawn = new Map(); // state -> how many self-loops are already drawn on it

  for (const { from, to, symbols, pointer } of pairs.values()) {
    const isHl = symbols.some((s) => highlighted.has(`${from}\u0000${s}`));
    const pa = P(pos.get(from)), pb = P(pos.get(to));
    // a hover's tooltip also says what it does
    const tip = [
      `${from}  —[${symbols.map(displayAction).join(', ')}]→  ${to}`,
      ...symbols.filter((s) => notes[s]).map((s) => `${displayAction(s)}: ${notes[s]}`),
    ].join('\n');
    // colour and arrowhead: red when highlighted, green when it is a pointer one
    const marker = (normal) => (isHl ? 'arrow-hl' : pointer ? 'arrow-hover' : normal);

    if (from === to) {
      // self-loop at the top right of the node; if it already has another one
      // (one for clicks and one for hovers), this one goes higher so it does
      // not cover its label
      const lift = (loopsDrawn.get(from) || 0) * 18;
      loopsDrawn.set(from, (loopsDrawn.get(from) || 0) + 1);
      const x0 = pa.x + pa.w - 18, y0 = pa.y;
      const d = `M ${x0},${y0} C ${x0 - 10},${y0 - 36 - lift} ${x0 + 36},${y0 - 36 - lift} ${x0 + 16},${y0 + 3}`;
      backLayer.push(`<path d="${d}" fill="none" stroke="${isHl ? '#d33' : pointer ? HOVER.edge : '#888'}" stroke-width="${isHl ? 3 : 1.5}" marker-end="url(#${marker('arrow')})"><title>${escapeXml(tip)}</title></path>`);
      labelLayer.push(`<text x="${x0 + 28}" y="${y0 - 20 - lift}" font-size="11" fill="${pointer ? HOVER.text : '#555'}">${escapeXml(abbreviate(symbols))}</text>`);
      continue;
    }

    if (pb.depth > pa.depth) {
      // forward: right edge of the source -> left edge of the target
      const x1 = pa.x + pa.w, y1 = pa.cy, x2 = pb.x - 2, y2 = pb.cy;
      const mx = (x1 + x2) / 2;
      const skips = pb.depth - pa.depth > 1;
      const d = skips ? skipEdgePath(pa, pb, cols, offsetX) : `M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      forwardLayer.push(
        `<path d="${d}" fill="none" stroke="${isHl ? '#d33' : pointer ? HOVER.edge : '#777'}" stroke-width="${isHl ? 3 : 1.8}" marker-end="url(#${marker('arrow')})"><title>${escapeXml(tip)}</title></path>`
      );
      if (skips) {
        if (!skipLabels.has(from)) skipLabels.set(from, new Set());
        symbols.forEach((s) => skipLabels.get(from).add(s));
      }
      if (!forwardLabels.has(to)) forwardLabels.set(to, new Set());
      symbols.forEach((s) => forwardLabels.get(to).add(s));
    } else if (pb.depth === pa.depth) {
      // lateral (same column): arc on the right of the column
      const x1 = pa.x + pa.w, y1 = pa.cy + 4, x2 = pb.x + pb.w + 2, y2 = pb.cy - 4;
      const bulge = Math.min(60, 18 + Math.abs(y2 - y1) * 0.05);
      const xr = Math.max(x1, x2) + bulge;
      backLayer.push(
        `<path d="M ${x1},${y1} C ${xr},${y1} ${xr},${y2} ${x2},${y2}" fill="none" stroke="${isHl ? '#d33' : pointer ? HOVER.side : '#9bb7d4'}" stroke-opacity="${isHl ? 1 : 0.8}" stroke-width="${isHl ? 3 : 1.5}" marker-end="url(#${marker('arrow-side')})"><title>${escapeXml(tip)}</title></path>`
      );
      if (!sideLabels.has(from)) sideLabels.set(from, new Set());
      symbols.forEach((s) => sideLabels.get(from).add(s));
    } else {
      // backward: from below the source to below the target, a curve that
      // dips in proportion to the distance
      const x1 = pa.cx, y1 = pa.y + pa.h, x2 = pb.cx + Math.min(10, pb.w / 4), y2 = pb.y + pb.h + 1;
      const bow = 24 + Math.abs(x1 - x2) * 0.12;
      backLayer.push(
        `<path d="M ${x1},${y1} C ${x1},${y1 + bow} ${x2},${y2 + bow} ${x2},${y2}" fill="none" stroke="${isHl ? '#d33' : pointer ? HOVER.back : '#c4c4c4'}" stroke-width="${isHl ? 3 : 1.5}" stroke-dasharray="${isHl ? '' : '5 4'}" marker-end="url(#${marker('arrow-back')})"><title>${escapeXml(tip)}</title></path>`
      );
      if (!backLabels.has(from)) backLabels.set(from, new Set());
      symbols.forEach((s) => backLabels.get(from).add(s));
    }
  }

  for (const [to, syms] of forwardLabels) {
    const p = P(pos.get(to));
    labelLayer.push(`<text x="${p.x - 18}" y="${p.cy - 9}" text-anchor="end" font-size="11" fill="#333">${escapeXml(abbreviate([...syms]))}</text>`);
  }
  // Under each state, a single line with what goes back (↩), what goes to the
  // same column (↕) and what skips columns (↷, going around them).
  for (const state of new Set([...backLabels.keys(), ...sideLabels.keys(), ...skipLabels.keys()])) {
    const p = P(pos.get(state));
    const spans = [];
    if (skipLabels.has(state)) spans.push(`<tspan fill="#555">↷ ${escapeXml(abbreviate([...skipLabels.get(state)]))}</tspan>`);
    if (backLabels.has(state)) spans.push(`<tspan fill="#999">↩ ${escapeXml(abbreviate([...backLabels.get(state)]))}</tspan>`);
    if (sideLabels.has(state)) spans.push(`<tspan fill="#5b84b1">↕ ${escapeXml(abbreviate([...sideLabels.get(state)]))}</tspan>`);
    labelLayer.push(`<text x="${p.cx - 8}" y="${p.y + p.h + 14}" font-size="10">${spans.join('  ')}</text>`);
  }

  parts.push('<g class="back-edges">', ...backLayer, '</g>');
  parts.push('<g class="forward-edges">', ...forwardLayer, '</g>');

  // initial state: a short arrow from the left
  {
    const p = P(pos.get(dfa.initial));
    parts.push(`<line x1="${p.x - 58}" y1="${p.cy}" x2="${p.x - 2}" y2="${p.cy}" stroke="#555" stroke-width="2.2" marker-end="url(#arrow)"/>`);
  }

  parts.push('<g class="states">');
  for (const state of drawnStates(dfa)) {
    const p = P(pos.get(state));
    const isInitial = state === dfa.initial;
    const isError = state === ERROR_STATE;
    const fill = isError ? '#fde8e8' : isInitial ? '#e6f1fb' : '#f7f7f7';
    const stroke = isError ? '#c33' : '#333';
    const outgoing = [...(dfa.transitions.get(state) || new Map()).entries()]
      .map(([a, to]) => `  ${displayAction(a)} → ${to}`).join('\n');
    parts.push(
      `<g>`,
      `<title>${escapeXml(state + (outgoing ? '\n' + outgoing : ''))}</title>`,
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${isInitial ? 2.4 : 1.4}"/>`,
      `<text x="${p.cx}" y="${p.cy}" text-anchor="middle" dominant-baseline="central">${escapeXml(labelFn(state))}</text>`,
      `</g>`
    );
  }
  parts.push('</g>');
  parts.push('<g class="labels">', ...labelLayer, '</g>');

  // legend
  let y = graphH + 8;
  parts.push(
    `<g font-size="10" fill="#666">`,
    `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + 40}" y2="${y}" stroke="#777" stroke-width="1.6" marker-end="url(#arrow)"/>`,
    `<text x="${MARGIN + 48}" y="${y + 3}">acción que avanza (etiqueta junto al destino)</text>`,
    `<line x1="${MARGIN + 320}" y1="${y}" x2="${MARGIN + 360}" y2="${y}" stroke="#c4c4c4" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#arrow-back)"/>`,
    `<text x="${MARGIN + 368}" y="${y + 3}">acción que vuelve (↩ bajo el origen)</text>`,
    `<line x1="${MARGIN + 590}" y1="${y}" x2="${MARGIN + 630}" y2="${y}" stroke="#9bb7d4" stroke-width="1.6" marker-end="url(#arrow-side)"/>`,
    `<text x="${MARGIN + 638}" y="${y + 3}">a la misma columna (↕ bajo el origen)</text>`,
    `<text x="${MARGIN}" y="${y + 20}">${hierarchical ? 'columnas = nivel en el nombre del estado (root = 0) · ' : 'columnas = clicks desde el estado inicial · '}↷ bajo el origen: acción que saltea columnas, dibujada rodeándolas · acciones sin el prefijo "Click_" · pasá el mouse por un estado o arista para ver el detalle completo</text>`,
    ...(hasPointer ? [
      `<line x1="${MARGIN}" y1="${y + 36}" x2="${MARGIN + 40}" y2="${y + 36}" stroke="${HOVER.edge}" stroke-width="1.6" marker-end="url(#arrow-hover)"/>`,
      `<text x="${MARGIN + 48}" y="${y + 39}">acción del puntero (Hover_ / Unhover_), con su prefijo: un bucle solo resalta o muestra algo; una flecha a otro estado abre algo</text>`,
    ] : []),
    `</g>`
  );
  y += legendH;

  if (footerBlocks.length) {
    parts.push(`<line x1="${MARGIN}" y1="${y}" x2="${width - MARGIN}" y2="${y}" stroke="#ddd"/>`);
    y += 20;
  }
  for (const b of footerBlocks) {
    parts.push(`<text x="${MARGIN}" y="${y}" font-weight="bold" fill="${b.color || '#222'}">${escapeXml(b.title)}</text>`);
    y += 18;
    parts.push(`<text font-family="Consolas, Menlo, monospace" font-size="11" fill="${b.color || '#333'}">`);
    for (const line of b.lines) {
      parts.push(`<tspan x="${MARGIN}" y="${y}">${escapeXml(line)}</tspan>`);
      y += 15;
    }
    parts.push('</text>');
    y += 18;
  }

  parts.push('</svg>');
  return parts.join('\n');
}

module.exports = { layout, toSVG };
