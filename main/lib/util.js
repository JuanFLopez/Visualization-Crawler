/**
 * Small helpers used across the crawler and the analysis: deep equality of
 * JSON snapshots, composite Map/Set keys, and key renaming.
 */

const KEY_SEPARATOR = '\u0000';

/**
 * Deep equality for plain JSON-like values (snapshots, effects).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One Map/Set key out of several parts. Each part goes through `String`, so
 * null and undefined stay distinguishable from the empty string, as in a
 * template literal.
 * @param {...*} parts
 * @returns {string}
 */
const compositeKey = (...parts) => parts.map(String).join(KEY_SEPARATOR);

/**
 * The parts of a key built by compositeKey, as strings.
 * @param {string} key
 * @returns {string[]}
 */
const splitKey = (key) => key.split(KEY_SEPARATOR);

/**
 * A copy of `obj` with every key passed through `rename`.
 * @param {Object} obj
 * @param {(key: string) => string} rename
 * @returns {Object}
 */
const mapKeys = (obj, rename) => Object.fromEntries(Object.entries(obj).map(([key, value]) => [rename(key), value]));

module.exports = { sameJson, compositeKey, splitKey, mapKeys };
