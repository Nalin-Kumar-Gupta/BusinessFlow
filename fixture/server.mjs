// TestTrace fixture server — plain Node.js HTTP, zero dependencies.
//
// Serves static files from fixture/public/ on http://localhost:3737.
// Used by Playwright e2e tests as the target web application.
// No framework, no middleware — deliberately boring.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3737;
const HOST = 'localhost';
const PUBLIC = join(fileURLToPath(import.meta.url), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = createServer(async (req, res) => {
  // Normalise path and prevent directory traversal.
  const raw = req.url ?? '/';
  const pathname = normalize(raw.split('?')[0] ?? '/').replace(/\\/g, '/');
  const safePath = pathname.startsWith('/') ? pathname : `/${pathname}`;

  // Resolve to filesystem path.
  let filePath = join(PUBLIC, safePath);

  // Directory → index.html
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Not a directory — try as-is.
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] ?? 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      // Permissive CORS so Playwright can fetch fixture resources cross-origin.
      'Access-Control-Allow-Origin': '*',
      // No caching in fixture — always fresh.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404 Not Found: ${safePath}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[fixture] http://${HOST}:${PORT}  (serving ${PUBLIC})`);
});

server.on('error', (err) => {
  console.error('[fixture] server error', err);
  process.exit(1);
});
