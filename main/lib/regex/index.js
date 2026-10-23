/**
 * Regexes over an alphabet of tokens (action names such as "Click_A"), in both
 * directions:
 *   parse.js       regex text -> AST (grammar in its header)
 *   compile.js     AST -> NFA -> DFA
 *   eliminate.js   DFA -> regex by state elimination (ast.js builds and prints the result)
 */

const { tokenize, literalsOf } = require('./parse');
const { compileRegex } = require('./compile');
const { dfaToRegexTrace } = require('./eliminate');

module.exports = { compileRegex, dfaToRegexTrace, tokenize, literalsOf };
