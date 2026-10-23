/**
 * Layered layout, left to right, of the states of a DFA.
 *
 * When state names are hierarchy paths ("root > vis > operator", see
 * lib/labels.js) the column is the level in the hierarchy and each state sits
 * next to its parent; otherwise the column is the depth (BFS) from the initial
 * state, grouped by the state each one was discovered from.
 *
 * Pure geometry, it knows nothing about SVG: distances are in the SVG's user
 * units (about CSS px).
 */

const { ERROR_STATE, HIERARCHY_SEPARATOR: SEP } = require('../constants');
const { abbreviate } = require('./text');

const CHAR_W = 7; // approximate width per character in 12px sans-serif
const NODE_H = 32;
const ROW_GAP = 24;
const COL_GAP = 230; // minimum gap between columns; wider when the edge labels need it (see columnGaps)
const LABEL_CHAR_W = 6; // approximate width per character of an 11px edge label
const EDGE_STEM = 90; // visible length of an arrow's shaft beside its label
const MARGIN = 40;
const LANE_GAP = 24; // gap between the columns and the lane of an edge that skips them

/**
 * States to draw: the ones with a row in the table PLUS the ones that only
 * appear as a target (e.g. the crawler's __ERROR__, which is never expanded).
 * @param {import('../automaton').DFA} dfa
 */
function drawnStates(dfa) {
  const all = new Set(dfa.states());
  for (const symbolMap of dfa.transitions.values()) {
    for (const to of symbolMap.values()) {
      all.add(to);
    }
  }
  return [...all];
}

/**
 * Column (depth), parent and discovery order of every state. Unreachable states get a column of their own
 * after the last one, and __ERROR__ the very last.
 * @returns {{depth: Map<string, number>, parent: Map<string, string>, order: Map<string, number>, hierarchical: boolean}}
 *   hierarchical: the columns are levels of the state names rather than click distances
 */
function assignDepths(dfa, states) {
  const { order: discovered, depth, parent } = dfa.bfs({ skip: [ERROR_STATE] });
  const order = new Map(discovered.map((s, i) => [s, i])); // discovery order
  // If every name is a path hanging from the initial state ("root > vis >
  // operator", see lib/labels.js), the column is the LEVEL in that path and
  // not the click distance: in a sunburst "operator" (level 2) is one click
  // from the root, and by BFS it would land in the column of "vis", so
  // vis -> operator would look like a sideways move. Names built from click
  // paths also satisfy this, and there level = BFS distance, so their layout
  // does not change.
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

  let maxDepth = Math.max(0, ...depth.values());
  const unreachable = states.filter((s) => !depth.has(s) && s !== ERROR_STATE);
  if (unreachable.length) { maxDepth++; unreachable.forEach((s) => { depth.set(s, maxDepth); order.set(s, order.size); }); }
  if (states.includes(ERROR_STATE)) { depth.set(ERROR_STATE, maxDepth + 1); order.set(ERROR_STATE, order.size); }

  return { depth, parent, order, hierarchical };
}

/**
 * The gap in front of a column has to leave the arrows a visible shaft beside
 * their labels: a forward edge's label sits against its target, so the gap is
 * the widest label that ends in that column plus EDGE_STEM (never below COL_GAP).
 * @returns {{labelWidth: (state: string) => number, gapBefore: number[]}}
 *   labelWidth: width of the label of the forward edges that arrive at a state
 */
function columnGaps(dfa, columns, depth) {
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
  return { labelWidth, gapBefore };
}

/**
 * Places every state: columns left to right, rows top to bottom, each column
 * centred vertically and its rows ordered by where their parents ended up.
 * @param {import('../automaton').DFA} dfa
 * @param {(state: string) => string} labelFn - the text inside a state, whose length sets the node width
 * @returns {{
 *   pos: Map<string, {x: number, y: number, w: number, h: number, cx: number, cy: number, depth: number}>,
 *   cols: {left: number, right: number, top: number, bottom: number, labelW: number}[], // extent of each column
 *   width: number, height: number,   // of the graph alone (the legend and footer go below)
 *   hierarchical: boolean,
 * }}
 */
function layout(dfa, labelFn) {
  const states = drawnStates(dfa);
  const { depth, parent, order, hierarchical } = assignDepths(dfa, states);

  const columns = Array.from({ length: Math.max(...states.map((s) => depth.get(s))) + 1 }, () => []);
  for (const s of states) columns[depth.get(s)].push(s);

  const size = new Map(states.map((s) => [s, { w: Math.max(56, labelFn(s).length * CHAR_W + 22), h: NODE_H }]));
  const { labelWidth, gapBefore } = columnGaps(dfa, columns, depth);

  const pos = new Map();
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

// The path of a forward edge that SKIPS columns (in practice the ones going to __ERROR__,
// which has a column of its own at the end): a direct curve would pass behind
// the states of the intermediate columns, all of them centred on the same
// line as the source and the target, so it would look like it leaves the
// middle state of each. It is routed above or below the intermediate columns
// (the shorter side), with rounded corners.
/**
 * @param {Object} pa - the box of the source state (a `pos` entry), already shifted by offsetX
 * @param {Object} pb - the box of the target state, shifted too
 * @param {Object[]} cols - the column extents from layout()
 * @param {number} offsetX - the horizontal shift applied to the boxes but not to `cols`
 * @returns {string} the `d` attribute of the SVG path
 */
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

module.exports = { MARGIN, drawnStates, layout, skipEdgePath };
