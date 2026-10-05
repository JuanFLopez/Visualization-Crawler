/**
 * Dibuja un DFA (el mismo objeto que produce automaton.js o regex.js) como
 * SVG, pensado para LEER el autómata de una visualización interactiva:
 *
 *  - Layout en capas de izquierda a derecha: si los nombres de estado
 *    son caminos de una jerarquía ("root > vis > operator", ver
 *    lib/labels.js), columna = nivel en la jerarquía y cada estado queda
 *    junto a su padre; si no, columna = profundidad (BFS) desde el estado
 *    inicial, agrupando por el estado desde el que se los descubrió.
 *  - Aristas "hacia adelante" (a la columna siguiente): sólidas, con la
 *    etiqueta pegada al destino (no se pisan aunque salgan muchas del
 *    mismo estado).
 *  - Aristas "hacia atrás" o dentro de la misma columna (volver, zoom
 *    out): punteadas y tenues, con la etiqueta debajo del ORIGEN -- son
 *    muchas y casi siempre la misma acción, no deberían tapar al resto.
 *  - Nombres de acción sin el prefijo "Click_"; si una arista agrupa
 *    muchas acciones se abrevia, y el detalle completo queda en el
 *    tooltip (<title>) de cada estado y arista.
 *  - Al pie, bloques de texto opcionales (p.ej. el regex equivalente).
 */

const ERROR_STATE = '__ERROR__';

const FONT = 11;
const CHAR_W = 6.4; // ancho aproximado por carácter en sans-serif 11px
const MONO_CHAR_W = 6.6; // monospace 11px
const NODE_H = 26;
const ROW_GAP = 14;
const COL_GAP = 150;
const MARGIN = 40;
const MAX_EDGE_LABEL = 26;
const LANE_GAP = 16; // separación entre las columnas y el carril de una arista que las saltea

// Estados a dibujar: los que tienen fila en la tabla MÁS los que solo
// aparecen como destino (p.ej. __ERROR__ del crawler, que nunca se expande).
function drawnStates(dfa) {
  const all = new Set(dfa.states());
  for (const symbolMap of dfa.transitions.values()) {
    for (const to of symbolMap.values()) all.add(to);
  }
  return [...all];
}

function defaultLabel(state) {
  // los estados "prettificados" (ver lib/labels.js) usan " > " como
  // separador de camino ("root > A > A1"); los nombres armados a mano
  // (window.__testState) suelen usar "/" ("root/A"). Probamos los dos.
  const bySeparator = state.includes(' > ') ? state.split(' > ') : state.split('/');
  const last = bySeparator.pop();
  return last.length > 24 ? last.slice(0, 23) + '…' : last;
}

const shortAction = (s) => s.replace(/^Click_/, '');

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function abbreviate(symbols) {
  const names = symbols.map(shortAction);
  const full = names.join(', ');
  if (full.length <= MAX_EDGE_LABEL || names.length === 1) return full;
  let out = names[0];
  let k = 1;
  while (k < names.length && (out + ', ' + names[k]).length <= MAX_EDGE_LABEL - 6) out += ', ' + names[k++];
  return `${out} +${names.length - k}`;
}

// Parte un texto largo en líneas de a lo sumo `maxChars`, cortando en
// espacios cuando se puede (el regex tiene espacios entre tokens).
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

// --- layout en capas ---
function layout(dfa, labelFn) {
  const states = drawnStates(dfa);
  const depth = new Map([[dfa.initial, 0]]);
  const parent = new Map();
  const order = new Map([[dfa.initial, 0]]); // orden de descubrimiento
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
  // Si todos los nombres son caminos que cuelgan del inicial ("root >
  // vis > operator", ver lib/labels.js), la columna es el NIVEL en ese
  // camino y no la distancia en clicks: en un sunburst "operator" (nivel
  // 2) está a un click de la raíz, y por BFS quedaría en la columna de
  // "vis" -- vis -> operator parecería un movimiento lateral. Los nombres
  // armados por camino de clicks también cumplen esto, y ahí nivel =
  // distancia BFS, así que el layout no cambia para ellos.
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

  // inalcanzables y __ERROR__: columnas propias al final
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

  // ancho de cada nodo según su etiqueta
  const size = new Map(states.map((s) => [s, { w: Math.max(56, labelFn(s).length * CHAR_W + 22), h: NODE_H }]));

  const pos = new Map();
  const colX = [];
  const cols = []; // extensión de cada columna: {left, right, top, bottom}
  let x = MARGIN + 50; // lugar para la flecha de estado inicial
  const tallest = Math.max(...columns.map((c) => c.length));
  const fullHeight = tallest * (NODE_H + ROW_GAP);
  for (let d = 0; d < columns.length; d++) {
    const col = columns[d];
    // agrupar por padre (en el orden en que quedaron los padres), y
    // dentro de cada grupo, por orden de descubrimiento
    const rank = (s) => (parent.has(s) && pos.has(parent.get(s)) ? pos.get(parent.get(s)).y : -1);
    col.sort((a, b) => rank(a) - rank(b) || order.get(a) - order.get(b));
    const colW = Math.max(0, ...col.map((s) => size.get(s).w));
    colX[d] = x;
    const colHeight = col.length * (NODE_H + ROW_GAP);
    let y = MARGIN + (fullHeight - colHeight) / 2;
    cols[d] = { left: x, right: x + colW, top: y, bottom: y + colHeight - ROW_GAP };
    for (const s of col) {
      const { w, h } = size.get(s);
      pos.set(s, { x: x + (colW - w) / 2, y, w, h, cx: x + colW / 2, cy: y + h / 2, depth: depth.get(s) });
      y += NODE_H + ROW_GAP;
    }
    x += colW + COL_GAP;
  }
  const width = x - COL_GAP + MARGIN;
  const height = MARGIN * 2 + fullHeight;
  return { pos, cols, width, height, hierarchical };
}

// Arista hacia adelante que SALTA columnas (en la práctica, las que van
// a __ERROR__, que tiene columna propia al final): una curva directa
// pasaría por detrás de los estados de las columnas intermedias -- todas
// están centradas en la misma línea que el origen y el destino, así que
// parecería salir del estado del medio de cada una. Se la rodea por
// encima o por debajo de las columnas intermedias (el lado más corto),
// con esquinas redondeadas.
function skipEdgePath(pa, pb, cols, offsetX) {
  const between = cols.slice(pa.depth + 1, pb.depth);
  const top = Math.min(...between.map((c) => c.top)) - LANE_GAP;
  const bottom = Math.max(...between.map((c) => c.bottom)) + LANE_GAP;
  const lane = Math.abs(pa.cy - top) + Math.abs(pb.cy - top) <= Math.abs(pa.cy - bottom) + Math.abs(pb.cy - bottom) ? top : bottom;
  const x1 = pa.x + pa.w, y1 = pa.cy, x2 = pb.x - 2, y2 = pb.cy;
  // bajadas verticales justo a la derecha de la columna de origen y a la
  // izquierda de la de destino (lejos de las etiquetas de las intermedias)
  const xa = cols[pa.depth].right + offsetX + 12;
  const xb = cols[pb.depth].left + offsetX - 12;
  const r = 8;
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
 * @param {(state:string)=>string} [opts.labelFn] - texto dentro del estado (default: último segmento de la ruta)
 * @param {string[]} [opts.highlightPath] - secuencia de símbolos (p.ej. un contraejemplo de diff.js) a resaltar en rojo
 * @param {{title: string, text: string, color?: string}[]} [opts.footer] - bloques de texto al pie (p.ej. el regex)
 * @param {number} [opts.minWidth=900]
 * @returns {string} SVG completo, listo para escribir a un archivo .svg
 */
function toSVG(dfa, opts = {}) {
  const { labelFn = defaultLabel, highlightPath = [], footer = [], minWidth = 900 } = opts;
  const { pos, cols, width: graphW, height: graphH, hierarchical } = layout(dfa, labelFn);
  const width = Math.max(minWidth, graphW);
  const offsetX = (width - graphW) / 2;

  // qué aristas (from, symbol) están en el camino resaltado
  const highlighted = new Set();
  let cur = dfa.initial;
  for (const symbol of highlightPath) {
    const next = dfa.step(cur, symbol);
    if (next === null) break;
    highlighted.add(`${cur}\u0000${symbol}`);
    cur = next;
  }

  // agrupar transiciones por par (from,to)
  const pairs = new Map();
  for (const [from, symbolMap] of dfa.transitions) {
    for (const [symbol, to] of symbolMap) {
      const key = `${from}\u0000${to}`;
      if (!pairs.has(key)) pairs.set(key, { from, to, symbols: [] });
      pairs.get(key).symbols.push(symbol);
    }
  }

  // --- pie: bloques de texto envueltos ---
  const maxChars = Math.floor((width - 2 * MARGIN) / MONO_CHAR_W);
  const footerBlocks = footer.map((b) => ({ ...b, lines: b.text.split('\n').flatMap((l) => wrapText(l, maxChars)) }));
  const footerH = footerBlocks.reduce((h, b) => h + 26 + b.lines.length * 15 + 10, footer.length ? 20 : 0);
  const legendH = 44;
  const height = graphH + legendH + footerH;

  const P = (p) => ({ ...p, x: p.x + offsetX, cx: p.cx + offsetX });
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif" font-size="${FONT}">`,
    `<title>Autómata (${drawnStates(dfa).length} estados)</title>`,
    `<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#555"/></marker>
  <marker id="arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#b5b5b5"/></marker>
  <marker id="arrow-side" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#9bb7d4"/></marker>
  <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 Z" fill="#d33"/></marker>
</defs>`,
    `<rect width="${width}" height="${height}" fill="white"/>`
  );

  const backLayer = [], forwardLayer = [], labelLayer = [];
  const backLabels = new Map(); // from -> Set de símbolos que "vuelven"
  const forwardLabels = new Map(); // to -> Set de símbolos que llegan desde la izquierda
  const sideLabels = new Map(); // from -> Set de símbolos hacia la misma columna
  const skipLabels = new Map(); // from -> Set de símbolos que saltean columnas (p.ej. a __ERROR__)

  for (const { from, to, symbols } of pairs.values()) {
    const isHl = symbols.some((s) => highlighted.has(`${from}\u0000${s}`));
    const pa = P(pos.get(from)), pb = P(pos.get(to));
    const tip = `${from}  —[${symbols.map(shortAction).join(', ')}]→  ${to}`;

    if (from === to) {
      // autobucle arriba a la derecha del nodo
      const x0 = pa.x + pa.w - 14, y0 = pa.y;
      const d = `M ${x0},${y0} C ${x0 - 6},${y0 - 24} ${x0 + 26},${y0 - 24} ${x0 + 12},${y0 + 2}`;
      backLayer.push(`<path d="${d}" fill="none" stroke="${isHl ? '#d33' : '#888'}" stroke-width="${isHl ? 2.2 : 1}" marker-end="url(#${isHl ? 'arrow-hl' : 'arrow'})"><title>${escapeXml(tip)}</title></path>`);
      labelLayer.push(`<text x="${x0 + 22}" y="${y0 - 14}" font-size="10" fill="#555">${escapeXml(abbreviate(symbols))}</text>`);
      continue;
    }

    if (pb.depth > pa.depth) {
      // adelante: borde derecho del origen -> borde izquierdo del destino
      const x1 = pa.x + pa.w, y1 = pa.cy, x2 = pb.x - 2, y2 = pb.cy;
      const mx = (x1 + x2) / 2;
      const skips = pb.depth - pa.depth > 1;
      const d = skips ? skipEdgePath(pa, pb, cols, offsetX) : `M ${x1},${y1} C ${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      forwardLayer.push(
        `<path d="${d}" fill="none" stroke="${isHl ? '#d33' : '#777'}" stroke-width="${isHl ? 2.2 : 1.1}" marker-end="url(#${isHl ? 'arrow-hl' : 'arrow'})"><title>${escapeXml(tip)}</title></path>`
      );
      if (skips) {
        if (!skipLabels.has(from)) skipLabels.set(from, new Set());
        symbols.forEach((s) => skipLabels.get(from).add(s));
      }
      if (!forwardLabels.has(to)) forwardLabels.set(to, new Set());
      symbols.forEach((s) => forwardLabels.get(to).add(s));
    } else if (pb.depth === pa.depth) {
      // lateral (misma columna): arco por la derecha de la columna
      const x1 = pa.x + pa.w, y1 = pa.cy + 4, x2 = pb.x + pb.w + 2, y2 = pb.cy - 4;
      const bulge = Math.min(50, 12 + Math.abs(y2 - y1) * 0.05);
      const xr = Math.max(x1, x2) + bulge;
      backLayer.push(
        `<path d="M ${x1},${y1} C ${xr},${y1} ${xr},${y2} ${x2},${y2}" fill="none" stroke="${isHl ? '#d33' : '#9bb7d4'}" stroke-opacity="${isHl ? 1 : 0.75}" stroke-width="${isHl ? 2.2 : 1}" marker-end="url(#${isHl ? 'arrow-hl' : 'arrow-side'})"><title>${escapeXml(tip)}</title></path>`
      );
      if (!sideLabels.has(from)) sideLabels.set(from, new Set());
      symbols.forEach((s) => sideLabels.get(from).add(s));
    } else {
      // atrás: de abajo del origen a abajo del destino, curva que baja
      // proporcional a la distancia
      const x1 = pa.cx, y1 = pa.y + pa.h, x2 = pb.cx + Math.min(10, pb.w / 4), y2 = pb.y + pb.h + 1;
      const bow = 18 + Math.abs(x1 - x2) * 0.12;
      backLayer.push(
        `<path d="M ${x1},${y1} C ${x1},${y1 + bow} ${x2},${y2 + bow} ${x2},${y2}" fill="none" stroke="${isHl ? '#d33' : '#c4c4c4'}" stroke-width="${isHl ? 2.2 : 1}" stroke-dasharray="${isHl ? '' : '4 3'}" marker-end="url(#${isHl ? 'arrow-hl' : 'arrow-back'})"><title>${escapeXml(tip)}</title></path>`
      );
      if (!backLabels.has(from)) backLabels.set(from, new Set());
      symbols.forEach((s) => backLabels.get(from).add(s));
    }
  }

  for (const [to, syms] of forwardLabels) {
    const p = P(pos.get(to));
    labelLayer.push(`<text x="${p.x - 8}" y="${p.cy - 5}" text-anchor="end" font-size="10" fill="#333">${escapeXml(abbreviate([...syms]))}</text>`);
  }
  // bajo cada estado, una sola línea con lo que vuelve (↩), lo que va
  // a la misma columna (↕) y lo que saltea columnas (↷, rodeándolas)
  for (const state of new Set([...backLabels.keys(), ...sideLabels.keys(), ...skipLabels.keys()])) {
    const p = P(pos.get(state));
    const spans = [];
    if (skipLabels.has(state)) spans.push(`<tspan fill="#555">↷ ${escapeXml(abbreviate([...skipLabels.get(state)]))}</tspan>`);
    if (backLabels.has(state)) spans.push(`<tspan fill="#999">↩ ${escapeXml(abbreviate([...backLabels.get(state)]))}</tspan>`);
    if (sideLabels.has(state)) spans.push(`<tspan fill="#5b84b1">↕ ${escapeXml(abbreviate([...sideLabels.get(state)]))}</tspan>`);
    labelLayer.push(`<text x="${p.cx - 8}" y="${p.y + p.h + 10}" font-size="9">${spans.join('  ')}</text>`);
  }

  parts.push('<g class="back-edges">', ...backLayer, '</g>');
  parts.push('<g class="forward-edges">', ...forwardLayer, '</g>');

  // estado inicial: flecha corta desde la izquierda
  {
    const p = P(pos.get(dfa.initial));
    parts.push(`<line x1="${p.x - 40}" y1="${p.cy}" x2="${p.x - 2}" y2="${p.cy}" stroke="#555" stroke-width="1.5" marker-end="url(#arrow)"/>`);
  }

  parts.push('<g class="states">');
  for (const state of drawnStates(dfa)) {
    const p = P(pos.get(state));
    const isInitial = state === dfa.initial;
    const isError = state === ERROR_STATE;
    const fill = isError ? '#fde8e8' : isInitial ? '#e6f1fb' : '#f7f7f7';
    const stroke = isError ? '#c33' : '#333';
    const outgoing = [...(dfa.transitions.get(state) || new Map()).entries()]
      .map(([a, to]) => `  ${shortAction(a)} → ${to}`).join('\n');
    parts.push(
      `<g>`,
      `<title>${escapeXml(state + (outgoing ? '\n' + outgoing : ''))}</title>`,
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${p.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${isInitial ? 2 : 1}"/>`,
      `<text x="${p.cx}" y="${p.cy}" text-anchor="middle" dominant-baseline="central">${escapeXml(labelFn(state))}</text>`,
      `</g>`
    );
  }
  parts.push('</g>');
  parts.push('<g class="labels">', ...labelLayer, '</g>');

  // leyenda
  let y = graphH + 8;
  parts.push(
    `<g font-size="10" fill="#666">`,
    `<line x1="${MARGIN}" y1="${y}" x2="${MARGIN + 28}" y2="${y}" stroke="#777" marker-end="url(#arrow)"/>`,
    `<text x="${MARGIN + 34}" y="${y + 3}">acción que avanza (etiqueta junto al destino)</text>`,
    `<line x1="${MARGIN + 290}" y1="${y}" x2="${MARGIN + 318}" y2="${y}" stroke="#c4c4c4" stroke-dasharray="4 3" marker-end="url(#arrow-back)"/>`,
    `<text x="${MARGIN + 324}" y="${y + 3}">acción que vuelve (↩ bajo el origen)</text>`,
    `<line x1="${MARGIN + 530}" y1="${y}" x2="${MARGIN + 558}" y2="${y}" stroke="#9bb7d4" marker-end="url(#arrow-side)"/>`,
    `<text x="${MARGIN + 564}" y="${y + 3}">a la misma columna (↕ bajo el origen)</text>`,
    `<text x="${MARGIN}" y="${y + 20}">${hierarchical ? 'columnas = nivel en el nombre del estado (root = 0) · ' : 'columnas = clicks desde el estado inicial · '}↷ bajo el origen: acción que saltea columnas, dibujada rodeándolas · acciones sin el prefijo "Click_" · pasá el mouse por un estado o arista para ver el detalle completo</text>`,
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
