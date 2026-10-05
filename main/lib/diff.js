/**
 * Compara los lenguajes de dos DFA (con aceptación, ver automaton.js)
 * buscando secuencias de símbolos que uno acepta y el otro no.
 *
 * BFS sobre pares (estadoA, estadoB) explorando el alfabeto unión de
 * ambos; null representa "ya rechazó" (el DFA es parcial). Cada vez que
 * un par difiere en aceptación, el camino hasta él es un contraejemplo
 * concreto -- y por ser BFS, de los más cortos. No se reporta uno solo:
 * se juntan hasta `limit` por dirección (cada par se visita una vez, así
 * que son contraejemplos de "lugares" distintos del autómata, no
 * extensiones triviales del mismo).
 *
 * @returns {{
 *   equivalent: boolean,
 *   onlyInA: string[][],   // secuencias que A acepta y B no
 *   onlyInB: string[][],   // secuencias que B acepta y A no
 *   truncated: boolean,    // se cortó al llegar a `limit` en alguna dirección
 * }}
 */
function diff(dfaA, dfaB, { limit = 10, maxDepth = 200 } = {}) {
  const alphabet = [...new Set([...dfaA.alphabet, ...dfaB.alphabet])].sort();
  const acc = (dfa, s) => s !== null && dfa.isAccepting(s);
  const step = (dfa, s, sym) => (s === null ? null : dfa.step(s, sym));

  const onlyInA = [], onlyInB = [];
  let truncated = false;
  const visited = new Set();
  const queue = [{ a: dfaA.initial, b: dfaB.initial, path: [] }];
  visited.add(`${dfaA.initial}\u0000${dfaB.initial}`);

  while (queue.length) {
    const { a, b, path } = queue.shift();
    const accA = acc(dfaA, a), accB = acc(dfaB, b);

    if (accA !== accB) {
      const list = accA ? onlyInA : onlyInB;
      if (list.length < limit) list.push(path);
      else truncated = true;
      // si un lado ya rechazó, toda extensión aceptada por el otro es la
      // misma diferencia "más larga": no aporta nada nuevo seguir
      if (a === null || b === null) continue;
    }
    if (path.length >= maxDepth) continue;
    if (onlyInA.length >= limit && onlyInB.length >= limit) { truncated = true; break; }

    for (const sym of alphabet) {
      const na = step(dfaA, a, sym), nb = step(dfaB, b, sym);
      if (na === null && nb === null) continue;
      const k = `${na}\u0000${nb}`;
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push({ a: na, b: nb, path: [...path, sym] });
    }
  }

  return { equivalent: onlyInA.length === 0 && onlyInB.length === 0, onlyInA, onlyInB, truncated };
}

module.exports = { diff };
