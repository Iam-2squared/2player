'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createHandler} = require('../server/router.cjs');
const {securityHeaders} = require('../server/http.cjs');
const root = path.resolve(__dirname, '..');
if (process.env.NODE_ENV !== 'test' && process.loadEnvFile && fs.existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const publicRoot = path.join(root, 'public');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json'};
function createServer(overrides = {}) {
  const handler = createHandler(overrides);
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.statusCode = 400; return res.end(); }
    if (url.pathname.startsWith('/api/')) return handler(req, res);
    securityHeaders(res);
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; return res.end(); }
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end(); }
    const target = path.resolve(publicRoot, '.' + (decoded === '/' ? '/index.html' : decoded));
    if (!target.startsWith(publicRoot + path.sep) || decoded.includes('\0')) { res.statusCode = 404; return res.end(); }
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('missing');
      res.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(target).pipe(res);
    } catch { res.statusCode = 404; res.end('Not found'); }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const server = createServer();
  server.listen(port, process.env.HOST || '0.0.0.0', () => process.stdout.write('2player dev server ready on port ' + server.address().port + '\n'));
}
module.exports = {createServer};
