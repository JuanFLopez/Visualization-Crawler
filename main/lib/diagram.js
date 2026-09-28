/**
 * Dibuja un DFA (el mismo objeto que produce automaton.js o regex.js) como
 * SVG: círculos para estados, flechas para transiciones, autobucles para
 * transiciones estado->sí mismo, y curvas separadas cuando hay ida y
 * vuelta entre el mismo par de estados. El layout se calcula solo (fuerzas
 * tipo resorte/repulsión) -- no hace falta acomodar nada a mano, funciona
 * para 3 estados o para 30.
 *
 * No es para editar -- es la foto de "así quedó el autómata" después de
 * calcular el observado (crawler) o el esperado (regex), para mostrar
 * (con <title> de tooltip por estado, ya que los nombres reales suelen
 * ser rutas largas tipo "flare/vis/operator").
 */

// --- layout: fuerzas tipo Fruchterman-Reingold, simplificado ---
function layout(dfa, { width = 900, height = 700, iterations = 400 } = {}) {
  const states = dfa.states();
  const n = states.length;
  const pos = new Map();
  states.forEach((s, i) => {
    // arranque en círculo -- converge más rápido y más prolijo que random puro
    const angle = (2 * Math.PI * i) / n;
    pos.set(s, {
      x: width / 2 + (Math.min(width, height) / 3) * Math.cos(angle),
      y: height / 2 + (Math.min(width, height) / 3) * Math.sin(angle),
    });
  });

  const edges = [];
  for (const [from, symbolMap] of dfa.transitions) {
    for (const to of symbolMap.values()) {
      if (from !== to) edges.push([from, to]);
    }
  }

  const k = Math.sqrt((width * height) / Math.max(n, 1)); // distancia "ideal"
  const area = { width, height };

  for (let iter = 0; iter < iterations; iter++) {
    const disp = new Map(states.map((s) => [s, { x: 0, y: 0 }]));

    // repulsión entre todos los pares (o(n^2), suficiente para grafos chicos/medianos)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = states[i], b = states[j];
        const pa = pos.get(a), pb = pos.get(b);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const force = (k * k) / dist;
        dx = (dx / dist) * force; dy = (dy / dist) * force;
        disp.get(a).x += dx; disp.get(a).y += dy;
        disp.get(b).x -= dx; disp.get(b).y -= dy;
      }
    }

    // atracción a lo largo de cada arista
    for (const [from, to] of edges) {
      const pa = pos.get(from), pb = pos.get(to);
      let dx = pa.x - pb.x, dy = pa.y - pb.y;
      let dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      dx = (dx / dist) * force; dy = (dy / dist) * force;
      disp.get(from).x -= dx; disp.get(from).y -= dy;
      disp.get(to).x += dx; disp.get(to).y += dy;
    }

    const temp = k * (1 - iter / iterations); // "enfriamiento": movimientos más chicos con el tiempo
    for (const s of states) {
      const d = disp.get(s);
      const dist = Math.hypot(d.x, d.y) || 0.01;
      const p = pos.get(s);
      p.x += (d.x / dist) * Math.min(dist, temp);
      p.y += (d.y / dist) * Math.min(dist, temp);
      p.x = Math.max(40, Math.min(area.width - 40, p.x));
      p.y = Math.max(40, Math.min(area.height - 40, p.y));
    }
  }

  return pos;
}

function defaultLabel(state) {
  // los estados "prettificados" (ver lib/labels.js) usan " > " como
  // separador de camino ("root > A > A1"); los nombres armados a mano
  // (window.__testState) suelen usar "/" ("root/A"). Probamos los dos.
  const bySeparator = state.includes(' > ') ? state.split(' > ') : state.split('/');
  const last = bySeparator.pop();
  return last.length > 10 ? last.slice(0, 9) + '…' : last;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/**
 * @param {import('./automaton').DFA} dfa
 * @param {Object} [opts]
 * @param {number} [opts.width=900]
 * @param {number} [opts.height=700]
 * @param {(state:string)=>string} [opts.labelFn] - texto corto dentro del círculo (default: último segmento de la ruta)
 * @param {string[]} [opts.highlightPath] - secuencia de símbolos (p.ej. la de diff.js) a resaltar en rojo
 * @returns {string} SVG completo, listo para escribir a un archivo .svg
 */
function toSVG(dfa, opts = {}) {
  const { width = 900, height = 700, labelFn = defaultLabel, highlightPath = [] } = opts;
  const pos = layout(dfa, { width, height });
  const r = 22;

  // qué aristas (from, symbol) están en el camino resaltado, y en qué orden
  const highlighted = new Set();
  let cur = dfa.initial;
  for (const symbol of highlightPath) {
    const next = dfa.step(cur, symbol);
    if (next === null) break;
    highlighted.add(`${cur}\u0000${symbol}`);
    cur = next;
  }

  // agrupar transiciones por par (from,to) para fusionar etiquetas y curvar bidireccionales
  const pairs = new Map(); // "from\u0000to" -> { symbols: string[], selfLoop: bool }
  for (const [from, symbolMap] of dfa.transitions) {
    for (const [symbol, to] of symbolMap) {
      const key = `${from}\u0000${to}`;
      if (!pairs.has(key)) pairs.set(key, { from, to, symbols: [] });
      pairs.get(key).symbols.push(symbol);
    }
  }

  const svgParts = [];
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">`,
    `<title>Autómata (${dfa.states().length} estados)</title>`,
    `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M1,1 L9,5 L1,9 Z" fill="#666"/>
      </marker>
      <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M1,1 L9,5 L1,9 Z" fill="#d33"/>
      </marker>
    </defs>`,
    `<rect width="${width}" height="${height}" fill="white"/>`
  );

  // marca de estado inicial: flecha corta apuntando al nodo inicial desde afuera
  {
    const p = pos.get(dfa.initial);
    const sx = p.x - r - 30, sy = p.y;
    svgParts.push(`<line x1="${sx}" y1="${sy}" x2="${p.x - r - 2}" y2="${sy}" stroke="#666" stroke-width="1.5" marker-end="url(#arrow)"/>`);
  }

  for (const { from, to, symbols } of pairs.values()) {
    const label = symbols.join(', ');
    const isHl = symbols.some((s) => highlighted.has(`${from}\u0000${s}`));
    const stroke = isHl ? '#d33' : '#888';
    const strokeWidth = isHl ? 2.5 : 1;
    const marker = isHl ? 'url(#arrow-hl)' : 'url(#arrow)';

    if (from === to) {
      // autobucle: lazo pequeño arriba del nodo
      const p = pos.get(from);
      const topX = p.x, topY = p.y - r;
      const d = `M ${topX - 10},${topY + 5} C ${topX - 24},${topY - 30} ${topX + 24},${topY - 30} ${topX + 10},${topY + 5}`;
      svgParts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="${marker}"/>`);
      svgParts.push(`<text x="${topX}" y="${topY - 34}" text-anchor="middle" font-size="11" fill="#333">${escapeXml(label)}</text>`);
      continue;
    }

    const hasReverse = pairs.has(`${to}\u0000${from}`);
    const pa = pos.get(from), pb = pos.get(to);
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const start = { x: pa.x + ux * r, y: pa.y + uy * r };
    const end = { x: pb.x - ux * r, y: pb.y - uy * r };

    if (!hasReverse) {
      svgParts.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="${marker}"/>`);
      const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
      svgParts.push(`<text x="${mx}" y="${my - 6}" text-anchor="middle" font-size="11" fill="#333">${escapeXml(label)}</text>`);
    } else {
      // bidireccional: curvar cada sentido hacia un lado distinto para que no se pisen
      const nx = -uy, ny = ux; // perpendicular unitario
      const bow = 28;
      const mx = (start.x + end.x) / 2 + nx * bow, my = (start.y + end.y) / 2 + ny * bow;
      svgParts.push(`<path d="M ${start.x},${start.y} Q ${mx},${my} ${end.x},${end.y}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="${marker}"/>`);
      svgParts.push(`<text x="${mx}" y="${my}" text-anchor="middle" font-size="11" fill="#333">${escapeXml(label)}</text>`);
    }
  }

  for (const state of dfa.states()) {
    const p = pos.get(state);
    const isInitial = state === dfa.initial;
    svgParts.push(
      `<g>`,
      `<title>${escapeXml(state)}</title>`,
      `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${isInitial ? '#e6f1fb' : '#f5f5f5'}" stroke="#333" stroke-width="1"/>`,
      `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="central" font-size="11">${escapeXml(labelFn(state))}</text>`,
      `</g>`
    );
  }

  svgParts.push('</svg>');
  return svgParts.join('\n');
}

module.exports = { layout, toSVG };
