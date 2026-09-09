/**
 * Compara dos DFA (mismo tipo: parciales, todo estado aceptante) buscando
 * la secuencia de símbolos MÁS CORTA donde divergen: uno de los dos tiene
 * una transición definida para esa secuencia y el otro no (rechaza), o
 * ambos siguen pero eventualmente esa rama diverge más adelante.
 *
 * BFS sobre pares (estadoA, estadoB) explorando el alfabeto unión de
 * ambos. En cuanto un símbolo está definido en uno y no en el otro,
 * tenemos un contraejemplo concreto y paramos ahí (es el primero, o sea
 * el más corto, gracias a BFS).
 *
 * @returns {{ equivalent: true }} | { equivalent: false, path: string[], reason: string }
 */
function diff(dfaA, dfaB, { maxDepth = 200 } = {}) {
  const alphabet = new Set([...dfaA.alphabet, ...dfaB.alphabet]);
  const startPair = `${dfaA.initial}|${dfaB.initial}`;
  const visited = new Set([startPair]);
  const queue = [{ a: dfaA.initial, b: dfaB.initial, path: [] }];

  while (queue.length) {
    const { a, b, path } = queue.shift();
    if (path.length > maxDepth) continue;

    for (const symbol of alphabet) {
      const nextA = dfaA.step(a, symbol);
      const nextB = dfaB.step(b, symbol);

      if ((nextA === null) !== (nextB === null)) {
        return {
          equivalent: false,
          path: [...path, symbol],
          reason:
            nextA === null
              ? `el observado RECHAZA esta secuencia (no hay transición para "${symbol}" desde "${a}"), pero el esperado la permite`
              : `el esperado RECHAZA esta secuencia (no hay transición para "${symbol}" desde "${b}"), pero el observado la permite`,
        };
      }
      if (nextA === null && nextB === null) continue; // ambos rechazan, coinciden en esto

      const pairKey = `${nextA}|${nextB}`;
      if (!visited.has(pairKey)) {
        visited.add(pairKey);
        queue.push({ a: nextA, b: nextB, path: [...path, symbol] });
      }
    }
  }

  return { equivalent: true };
}

module.exports = { diff };
