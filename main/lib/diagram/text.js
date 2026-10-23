/**
 * Text helpers for the diagram: state labels, edge labels, XML escaping and
 * line wrapping.
 */

const { displayAction } = require('../actions');
const { HIERARCHY_SEPARATOR } = require('../constants');

const MAX_EDGE_LABEL = 26;

/** Text inside a state: the last segment of its path, cut when long. */
function defaultLabel(state) {
  // "prettified" states (see lib/labels.js) use " > " as the path separator
  // ("root > A > A1"); hand-built names (window.__testState) usually use "/"
  // ("root/A"). Both are tried.
  const bySeparator = state.includes(HIERARCHY_SEPARATOR) ? state.split(HIERARCHY_SEPARATOR) : state.split('/');
  const last = bySeparator.pop();
  return last.length > 24 ? last.slice(0, 23) + '…' : last;
}

/** Escapes the five characters that XML text and attribute values cannot hold. */
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** The action names of an edge on one line; when too long, the first ones and "+N". */
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

module.exports = { defaultLabel, escapeXml, abbreviate, wrapText };
