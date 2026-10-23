/**
 * Draws a DFA (the same object lib/automaton or lib/regex produce) as an SVG,
 * meant for READING the automaton of an interactive visualization:
 *
 *  - Layered layout from left to right (see layout.js).
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

const { displayAction, verbOf } = require('../actions');
const { ERROR_STATE } = require('../constants');
const { compositeKey } = require('../util');
const { MARGIN, drawnStates, layout, skipEdgePath } = require('./layout');
const { defaultLabel, escapeXml, abbreviate, wrapText } = require('./text');

const FONT = 12;
const MONO_CHAR_W = 6.6; // 11px monospace
// Arrowheads are sized in user-space px (markerUnits="userSpaceOnUse"), so they do not
// shrink or grow with the stroke width of the edge that carries them.
const ARROW = 13, ARROW_SMALL = 11, ARROW_HL = 15, ARROW_HOVER = 12;

const HIGHLIGHT = '#d33';
// green: hover (one more colour, not the only cue: the name carries its prefix)
const HOVER = { edge: '#1b8a82', side: '#7fc4be', back: '#8fcac5', text: '#1b7f79' };

// How each kind of edge is drawn: normal colour, colour of a pointer (hover)
// edge, stroke width and arrowhead; `opacity` / `dashed` only where the kind has them.
const EDGE_STYLES = {
  loop: { color: '#888', pointerColor: HOVER.edge, width: 1.5, marker: 'arrow' },
  forward: { color: '#777', pointerColor: HOVER.edge, width: 1.8, marker: 'arrow' },
  side: { color: '#9bb7d4', pointerColor: HOVER.side, width: 1.5, marker: 'arrow-side', opacity: 0.8 },
  back: { color: '#c4c4c4', pointerColor: HOVER.back, width: 1.5, marker: 'arrow-back', dashed: '5 4' },
};

/** One <marker> (an arrowhead) with the given id, size in px and colour. */
const arrowhead = (id, size, fill) =>
  `  <marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${size}" markerHeight="${size}" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="${fill}"/></marker>`;

/** The <defs> block: one arrowhead per edge colour; the hover one only when the diagram has pointer actions. */
function defs(hasPointer) {
  return [
    '<defs>',
    arrowhead('arrow', ARROW, '#555'),
    arrowhead('arrow-back', ARROW_SMALL, '#b5b5b5'),
    arrowhead('arrow-side', ARROW_SMALL, '#9bb7d4'),
    arrowhead('arrow-hl', ARROW_HL, HIGHLIGHT),
    ...(hasPointer ? [arrowhead('arrow-hover', ARROW_HOVER, HOVER.edge)] : []),
    '</defs>',
  ].join('\n');
}

/**
 * One <path> for an edge of the given kind: red when highlighted, green when it is a pointer one.
 * @param {'loop'|'forward'|'side'|'back'} kind - a key of EDGE_STYLES
 * @param {string} d - the path geometry
 * @param {{highlighted: boolean, pointer: boolean, tip: string}} edge - tip: the text of its tooltip
 */
function edgePath(kind, d, { highlighted, pointer, tip }) {
  const style = EDGE_STYLES[kind];
  const attrs = [
    `d="${d}"`,
    'fill="none"',
    `stroke="${highlighted ? HIGHLIGHT : pointer ? style.pointerColor : style.color}"`,
    ...(style.opacity !== undefined ? [`stroke-opacity="${highlighted ? 1 : style.opacity}"`] : []),
    `stroke-width="${highlighted ? 3 : style.width}"`,
    ...(style.dashed ? [`stroke-dasharray="${highlighted ? '' : style.dashed}"`] : []),
    `marker-end="url(#${highlighted ? 'arrow-hl' : pointer ? 'arrow-hover' : style.marker})"`,
  ];
  return `<path ${attrs.join(' ')}><title>${escapeXml(tip)}</title></path>`;
}

// Geometry of each kind of edge, from the (already shifted) boxes of its two states.

// self-loop at the top right of the node; `lift` raises it above the ones already drawn
function loopGeometry(pa, lift) {
  const x0 = pa.x + pa.w - 18, y0 = pa.y;
  return {
    d: `M ${x0},${y0} C ${x0 - 10},${y0 - 36 - lift} ${x0 + 36},${y0 - 36 - lift} ${x0 + 16},${y0 + 3}`,
    labelX: x0 + 28,
    labelY: y0 - 20 - lift,
  };
}

// forward: right edge of the source -> left edge of the target
function forwardPath(pa, pb) {
  const x1 = pa.x + pa.w, y1 = pa.cy, x2 = pb.x - 2, y2 = pb.cy;
  const mx = (x1 + x2) / 2;
  return `M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

// lateral (same column): arc on the right of the column
function sidePath(pa, pb) {
  const x1 = pa.x + pa.w, y1 = pa.cy + 4, x2 = pb.x + pb.w + 2, y2 = pb.cy - 4;
  const bulge = Math.min(60, 18 + Math.abs(y2 - y1) * 0.05);
  const xr = Math.max(x1, x2) + bulge;
  return `M ${x1},${y1} C ${xr},${y1} ${xr},${y2} ${x2},${y2}`;
}

// backward: from below the source to below the target, a curve that dips in
// proportion to the distance
function backPath(pa, pb) {
  const x1 = pa.cx, y1 = pa.y + pa.h, x2 = pb.cx + Math.min(10, pb.w / 4), y2 = pb.y + pb.h + 1;
  const bow = 24 + Math.abs(x1 - x2) * 0.12;
  return `M ${x1},${y1} C ${x1},${y1 + bow} ${x2},${y2 + bow} ${x2},${y2}`;
}

/**
 * Group transitions by (from, to) pair; the pointer ones (Hover_/Unhover_)
 * get an edge of their own, so they can be drawn differently from clicks.
 * @returns {{from: string, to: string, symbols: string[], pointer: boolean}[]} one per edge to draw
 */
function groupTransitions(dfa) {
  const pairs = new Map();
  for (const [from, symbolMap] of dfa.transitions) {
    for (const [symbol, to] of symbolMap) {
      const pointer = verbOf(symbol) !== 'click';
      const key = compositeKey(from, to, pointer ? 1 : 0);
      if (!pairs.has(key)) pairs.set(key, { from, to, symbols: [], pointer });
      pairs.get(key).symbols.push(symbol);
    }
  }
  return [...pairs.values()];
}

/**
 * Which edges are on the highlighted path (the first series of events of the first issue).
 * @param {string[]} highlightPath - actions, from the initial state; stops at the first one that is not offered
 * @returns {Set<string>} compositeKey(state, action) of each edge
 */
function highlightedEdges(dfa, highlightPath) {
  const highlighted = new Set();
  let cur = dfa.initial;
  for (const symbol of highlightPath) {
    const next = dfa.step(cur, symbol);
    if (next === null) break;
    highlighted.add(compositeKey(cur, symbol));
    cur = next;
  }
  return highlighted;
}

/** Adds `symbols` to the Set kept under `key` in `map`, creating it when missing. */
const addAll = (map, key, symbols) => {
  if (!map.has(key)) map.set(key, new Set());
  symbols.forEach((s) => map.get(key).add(s));
};

/**
 * The edges in three layers (back edges under forward ones, labels on top).
 * @param {ReturnType<typeof groupTransitions>} pairs
 * @param {Object} ctx
 * @param {Map<string, Object>} ctx.pos - the boxes from layout()
 * @param {Object[]} ctx.cols - the column extents from layout()
 * @param {number} ctx.offsetX - horizontal shift that centres the graph
 * @param {(box: Object) => Object} ctx.shift - applies offsetX to a box
 * @param {Set<string>} ctx.highlighted - from highlightedEdges
 * @param {Object<string, string>} ctx.notes - action -> what it does, for the tooltips of hover edges
 * @returns {{backLayer: string[], forwardLayer: string[], labelLayer: string[]}} SVG elements, in drawing order
 */
function drawEdges(pairs, { pos, cols, offsetX, shift, highlighted, notes }) {
  const backLayer = [], forwardLayer = [], labelLayer = [];
  const backLabels = new Map(); // from -> Set of symbols that "go back"
  const forwardLabels = new Map(); // to -> Set of symbols arriving from the left
  const sideLabels = new Map(); // from -> Set of symbols to the same column
  const skipLabels = new Map(); // from -> Set of symbols that skip columns (e.g. to __ERROR__)
  const loopsDrawn = new Map(); // state -> how many self-loops are already drawn on it

  for (const { from, to, symbols, pointer } of pairs) {
    const pa = shift(pos.get(from)), pb = shift(pos.get(to));
    const edge = {
      highlighted: symbols.some((s) => highlighted.has(compositeKey(from, s))),
      pointer,
      // a hover's tooltip also says what it does
      tip: [
        `${from}  —[${symbols.map(displayAction).join(', ')}]→  ${to}`,
        ...symbols.filter((s) => notes[s]).map((s) => `${displayAction(s)}: ${notes[s]}`),
      ].join('\n'),
    };

    if (from === to) {
      // if the node already has a loop (one for clicks and one for hovers), this
      // one goes higher so it does not cover its label
      const lift = (loopsDrawn.get(from) || 0) * 18;
      loopsDrawn.set(from, (loopsDrawn.get(from) || 0) + 1);
      const { d, labelX, labelY } = loopGeometry(pa, lift);
      backLayer.push(edgePath('loop', d, edge));
      labelLayer.push(`<text x="${labelX}" y="${labelY}" font-size="11" fill="${pointer ? HOVER.text : '#555'}">${escapeXml(abbreviate(symbols))}</text>`);
    } else if (pb.depth > pa.depth) {
      const skips = pb.depth - pa.depth > 1;
      forwardLayer.push(edgePath('forward', skips ? skipEdgePath(pa, pb, cols, offsetX) : forwardPath(pa, pb), edge));
      if (skips) addAll(skipLabels, from, symbols);
      addAll(forwardLabels, to, symbols);
    } else if (pb.depth === pa.depth) {
      backLayer.push(edgePath('side', sidePath(pa, pb), edge));
      addAll(sideLabels, from, symbols);
    } else {
      backLayer.push(edgePath('back', backPath(pa, pb), edge));
      addAll(backLabels, from, symbols);
    }
  }

  for (const [to, syms] of forwardLabels) {
    const p = shift(pos.get(to));
    labelLayer.push(`<text x="${p.x - 18}" y="${p.cy - 9}" text-anchor="end" font-size="11" fill="#333">${escapeXml(abbreviate([...syms]))}</text>`);
  }
  // Under each state, a single line with what goes back (↩), what goes to the
  // same column (↕) and what skips columns (↷, going around them).
  for (const state of new Set([...backLabels.keys(), ...sideLabels.keys(), ...skipLabels.keys()])) {
    const p = shift(pos.get(state));
    const spans = [];
    if (skipLabels.has(state)) spans.push(`<tspan fill="#555">↷ ${escapeXml(abbreviate([...skipLabels.get(state)]))}</tspan>`);
    if (backLabels.has(state)) spans.push(`<tspan fill="#999">↩ ${escapeXml(abbreviate([...backLabels.get(state)]))}</tspan>`);
    if (sideLabels.has(state)) spans.push(`<tspan fill="#5b84b1">↕ ${escapeXml(abbreviate([...sideLabels.get(state)]))}</tspan>`);
    labelLayer.push(`<text x="${p.cx - 8}" y="${p.y + p.h + 14}" font-size="10">${spans.join('  ')}</text>`);
  }
  return { backLayer, forwardLayer, labelLayer };
}

/** The states: a rounded box with its label, and a tooltip with its full name and outgoing transitions. */
function stateElements(dfa, { pos, shift, labelFn }) {
  const parts = ['<g class="states">'];
  for (const state of drawnStates(dfa)) {
    const p = shift(pos.get(state));
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
  return parts;
}

/**
 * The legend under the graph. Its entries sit at fixed x offsets, so their text must stay short.
 * @param {number} y - where it starts
 */
function legendElements(y, { hierarchical, hasPointer }) {
  return [
    `<g font-size="10" fill="#666">`,
    `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + 40}" y2="${y}" stroke="#777" stroke-width="1.6" marker-end="url(#arrow)"/>`,
    `<text x="${MARGIN + 48}" y="${y + 3}">forward action (label next to the target)</text>`,
    `<line x1="${MARGIN + 320}" y1="${y}" x2="${MARGIN + 360}" y2="${y}" stroke="#c4c4c4" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#arrow-back)"/>`,
    `<text x="${MARGIN + 368}" y="${y + 3}">backward action (↩ under the source)</text>`,
    `<line x1="${MARGIN + 590}" y1="${y}" x2="${MARGIN + 630}" y2="${y}" stroke="#9bb7d4" stroke-width="1.6" marker-end="url(#arrow-side)"/>`,
    `<text x="${MARGIN + 638}" y="${y + 3}">to the same column (↕ under the source)</text>`,
    `<text x="${MARGIN}" y="${y + 20}">${hierarchical ? 'columns = level in the state name (root = 0) · ' : 'columns = clicks from the initial state · '}↷ under the source: action that skips columns, drawn around them · actions without the "Click_" prefix · hover a state or an edge for the full detail</text>`,
    ...(hasPointer ? [
      `<line x1="${MARGIN}" y1="${y + 36}" x2="${MARGIN + 40}" y2="${y + 36}" stroke="${HOVER.edge}" stroke-width="1.6" marker-end="url(#arrow-hover)"/>`,
      `<text x="${MARGIN + 48}" y="${y + 39}">pointer action (Hover_ / Unhover_), shown with its prefix: a loop only highlights or shows something; an arrow to another state opens something</text>`,
    ] : []),
    `</g>`,
  ];
}

/**
 * The text blocks at the bottom, each a bold title and monospace lines.
 * @param {{title: string, color?: string, lines: string[]}[]} blocks - lines already wrapped
 * @param {number} width - of the whole diagram, for the separator line
 */
function footerElements(blocks, startY, width) {
  const parts = [];
  let y = startY;
  if (blocks.length) {
    parts.push(`<line x1="${MARGIN}" y1="${y}" x2="${width - MARGIN}" y2="${y}" stroke="#ddd"/>`);
    y += 20;
  }
  for (const b of blocks) {
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
  return parts;
}

/**
 * @param {import('../automaton').DFA} dfa
 * @param {Object} [opts]
 * @param {(state:string)=>string} [opts.labelFn] - text inside the state (default: last segment of the path)
 * @param {string[]} [opts.highlightPath] - sequence of symbols (e.g. a counterexample from lib/diff) to highlight in red
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
  const shift = (p) => ({ ...p, x: p.x + offsetX, cx: p.cx + offsetX });

  const pairs = groupTransitions(dfa);
  const hasPointer = pairs.some((p) => p.pointer);

  const maxChars = Math.floor((width - 2 * MARGIN) / MONO_CHAR_W);
  const footerBlocks = footer.map((b) => ({ ...b, lines: b.text.split('\n').flatMap((l) => wrapText(l, maxChars)) }));
  const footerH = footerBlocks.reduce((h, b) => h + 26 + b.lines.length * 15 + 10, footer.length ? 20 : 0);
  const legendH = hasPointer ? 62 : 44;
  const height = graphH + legendH + footerH;

  const { backLayer, forwardLayer, labelLayer } = drawEdges(pairs, { pos, cols, offsetX, shift, highlighted: highlightedEdges(dfa, highlightPath), notes });
  const initial = shift(pos.get(dfa.initial));
  const legendY = graphH + 8;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif" font-size="${FONT}">`,
    `<title>Automaton (${drawnStates(dfa).length} states)</title>`,
    defs(hasPointer),
    `<rect width="${width}" height="${height}" fill="white"/>`,
    '<g class="back-edges">', ...backLayer, '</g>',
    '<g class="forward-edges">', ...forwardLayer, '</g>',
    // initial state: a short arrow from the left
    `<line x1="${initial.x - 58}" y1="${initial.cy}" x2="${initial.x - 2}" y2="${initial.cy}" stroke="#555" stroke-width="2.2" marker-end="url(#arrow)"/>`,
    ...stateElements(dfa, { pos, shift, labelFn }),
    '<g class="labels">', ...labelLayer, '</g>',
    ...legendElements(legendY, { hierarchical, hasPointer }),
    ...footerElements(footerBlocks, legendY + legendH, width),
    '</svg>',
  ].join('\n');
}

module.exports = { toSVG };
