// Petit serveur local pour voir le site avant de le publier : node serve.js puis http://localhost:4174
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  if (path.includes('..')) { res.writeHead(400); return res.end(); }
  try {
    const body = await readFile(new URL('./site' + path, import.meta.url));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Introuvable'); }
}).listen(Number(process.env.PORT ?? 4174), () => console.log(`http://localhost:${process.env.PORT ?? 4174}`));
