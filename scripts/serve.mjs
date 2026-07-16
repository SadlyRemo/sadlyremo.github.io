/* Preview server for the generated SANDŌ site.
   Serves /dist as root, but transparently maps /images/* and /naruto.jpg
   to the repo's real folders — so no copying/junctioning is needed.
   Usage: node scripts/serve.mjs [port]                                    */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.argv[2]) || 8900;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };

const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'text/plain' }); res.end(body); };

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  // map real asset roots
  let file;
  if (url.startsWith('/images/')) file = path.join(ROOT, url);
  else if (url === '/naruto.jpg') file = path.join(ROOT, 'naruto.jpg');
  else file = path.join(DIST, url);

  // directory -> index.html
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {}

  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-ish fallback to 404 page
      const nf = path.join(DIST, '404.html');
      if (fs.existsSync(nf)) return send(res, 404, fs.readFileSync(nf), TYPES['.html']);
      return send(res, 404, 'Not found');
    }
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}).listen(PORT, () => console.log(`SANDŌ preview → http://localhost:${PORT}/`));
