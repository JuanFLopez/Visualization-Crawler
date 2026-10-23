/**
 * Hosting the page under test: a local static file server and the headless
 * Chromium (Playwright) that loads from it. The crawler never opens the page
 * from disk, so relative URLs, fetch and XHR (d3.json, d3.csv) behave as on a
 * real site.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml' };

/**
 * Serves `dir` on 127.0.0.1. Port 0 lets the system pick a free one, so several
 * runs (or a GUI with several tabs) do not step on each other: read it back
 * with server.address().port. "/" is served as index.html and anything outside
 * `dir` is refused. The caller closes the server.
 * @param {string} dir - absolute path of the folder to serve
 * @returns {Promise<import('http').Server>} a listening server
 */
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      const filePath = path.join(dir, decodeURIComponent(url === '/' ? '/index.html' : url));
      if (!filePath.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Which Chromium executable to launch. On Linux (a server, a lambda) the one
 * bundled in @sparticuz/chromium when it is installed; everywhere else
 * undefined, which makes Playwright use its own downloaded browser.
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

module.exports = { startServer, resolveChromePath, launchBrowser };
