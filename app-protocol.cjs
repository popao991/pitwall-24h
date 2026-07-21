// Serves project files over app://root/... so the renderer can use native
// ES modules (Chromium blocks module scripts on file:// origins).
// CJS so both the ESM main process and CJS test drivers can load it.
const { protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
};

// Must run before app 'ready'. Deliberately NOT flagged secure: the pages
// open plain ws:// sockets to the pit wall PC, which a secure origin would
// block as mixed content.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, supportFetchAPI: true } }
  ]);
}

// Call after app 'ready'. root is the project directory.
function installHandler(root) {
  const rootPrefix = path.normalize(root + path.sep);
  protocol.handle('app', async req => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(rootPrefix)) return new Response('forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
      });
    } catch {
      return new Response('not found: ' + pathname, { status: 404 });
    }
  });
}

module.exports = { registerScheme, installHandler };
