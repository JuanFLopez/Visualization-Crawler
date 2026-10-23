/**
 * Launching the headless Chromium the crawler drives (Playwright). Used by
 * crawler.js and diagnose.js; run.js only resolves which executable to use.
 */
const { chromium } = require('playwright');

/**
 * Which Chromium executable to launch. On Linux (a server, a lambda) the one
 * bundled in @sparticuz/chromium when it is installed; everywhere else
 * undefined, which makes Playwright use its own downloaded browser.
 * @returns {Promise<string|undefined>}
 */
async function resolveChromePath() {
  if (process.platform !== 'linux') return undefined;
  try {
    return await require('@sparticuz/chromium').executablePath();
  } catch (e) {
    return undefined;
  }
}

/**
 * @param {string} [executablePath] - from resolveChromePath()
 * @returns {Promise<import('playwright').Browser>}
 */
function launchBrowser(executablePath) {
  return chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
}

module.exports = { resolveChromePath, launchBrowser };
