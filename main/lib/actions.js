/**
 * Cómo se NOMBRAN las acciones, los símbolos del alfabeto del autómata:
 * "<Tipo>_<elemento>" ("Click_vis"). El prefijo dice qué tipo de
 * interacción es y el resto sobre qué elemento. Todo lo que arma o muestra
 * nombres (el crawler, los nombres limpios, el diagrama, el regex
 * esperado) pasa por acá en vez de asumir "Click_".
 *
 *   click    clickear el elemento
 *   hover    poner el puntero encima (mouseover/mouseenter)
 *   unhover  sacarlo; solo existe como la vuelta de un hover que cambia
 *            qué se puede hacer (un menú que se abre), no para los que son
 *            un resaltado: esos no cambian de estado
 */

// tipo de interacción -> prefijo del nombre de sus acciones
const PREFIXES = { click: 'Click_', hover: 'Hover_', unhover: 'Unhover_' };

// tipo que se asume para un nombre escrito sin prefijo (el regex esperado)
const DEFAULT_KIND = 'click';

const UNKNOWN = 'unknown_';

const prefixes = Object.values(PREFIXES).join('|');
const PREFIX_RE = new RegExp(`^(?:${prefixes})`);
const INTERNAL_RE = new RegExp(`^(?:${prefixes})${UNKNOWN}\\d+$`);

function actionName(kind, base) {
  if (!Object.hasOwn(PREFIXES, kind)) throw new Error(`tipo de acción desconocido: ${kind}`);
  return PREFIXES[kind] + base;
}

// nombre para un elemento sin identidad legible (ver createNaming en crawler.js)
function internalName(kind, n) {
  return actionName(kind, `${UNKNOWN}${n}`);
}

// ese nombre es un id interno, no un valor
function isInternalName(action) {
  return INTERNAL_RE.test(action);
}

// "Click_vis" -> "click" (null si el nombre no lleva ningún prefijo conocido)
function kindOfAction(action) {
  return Object.keys(PREFIXES).find((kind) => action.startsWith(PREFIXES[kind])) ?? null;
}

// "Click_vis" -> "vis"
function shortAction(action) {
  return action.replace(PREFIX_RE, '');
}

// El nombre tal como se lo muestra, o se lo usa dentro del nombre de un
// estado: los clicks sin prefijo ("vis"), el resto con él ("Hover_vis") --
// sin el prefijo, un hover sobre "vis" y un click sobre "vis" se leerían igual.
function displayAction(action) {
  return kindOfAction(action) === 'click' ? shortAction(action) : action;
}

// el verbo para hablar de la acción en un mensaje; un nombre sin prefijo
// (una tabla escrita a mano) se lee como click
function verbOf(action) {
  return kindOfAction(action) ?? 'click';
}

// "Hover_vis" -> "Unhover_vis": el hover y su vuelta se nombran en par
function unhoverOf(hoverAction) {
  return actionName('unhover', shortAction(hoverAction));
}

// el prefijo solo, con o sin el "_" final: lo que queda de un nombre al
// sacarle todo lo demás
function isBarePrefix(s) {
  return Object.values(PREFIXES).some((p) => s === p || s === p.slice(0, -1));
}

module.exports = {
  DEFAULT_KIND, actionName, internalName, isInternalName, kindOfAction, shortAction, displayAction, verbOf, unhoverOf, isBarePrefix,
};
