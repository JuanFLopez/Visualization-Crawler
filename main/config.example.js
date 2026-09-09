// Poné este archivo como "config.js" AL LADO del index.html de la
// visualización que ya instrumentaste a mano (data-name + window.__testState,
// como el sunburst zoomable original). Si no existe este archivo, run.js
// usa el modo genérico (detección automática, sin instrumentar nada).
//
// settleMs/discoverySettleMs ya NO hace falta ponerlos: si se omiten, se
// calibran solos (clickeando un elemento y midiendo cuándo el estado deja
// de cambiar). Dejalos solo si querés forzar un valor puntual y saltear
// la calibración (por ejemplo, si ya sabés que tu visualización nunca se
// asienta del todo y necesitás un valor fijo igual).
module.exports = {
  clickableSelector: 'path[data-name][pointer-events="auto"][style*="cursor"], circle.center-circle',
  backSelector: 'circle.center-circle',
  maxStates: 60,
  maxSteps: 3000,
};
