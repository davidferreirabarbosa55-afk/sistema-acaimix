// Servidor para rodar no seu computador (npm run dev). Em produção, quem faz este papel é a Vercel.
// Serve os arquivos de public/ e manda /api/* para o mesmo código que roda na Vercel.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { tratar, CABECALHOS_SEGURANCA } = require('./app');
const { URL_SUPABASE } = require('./supabase');

const PORTA = Number(process.env.PORTA || 3000);
const PUBLICA = path.join(__dirname, '..', 'public');
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; img-src 'self' data: https://*.supabase.co; script-src 'self'; " +
  "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function estatico(req, res, url) {
  let caminho;
  try { caminho = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (caminho === '/') caminho = '/index.html';
  else if (!path.extname(caminho)) caminho += '.html'; // /admin → admin.html (como na Vercel)
  const arquivo = path.normalize(path.join(PUBLICA, caminho));
  const tipo = TIPOS[path.extname(arquivo)];
  const naoAchou = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Página não encontrada'); };
  if (!arquivo.startsWith(PUBLICA + path.sep) || !tipo) return naoAchou();
  fs.readFile(arquivo, (err, dados) => {
    if (err) return naoAchou();
    const gzip = /^text\//.test(tipo) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const corpo = gzip ? zlib.gzipSync(dados) : dados;
    res.writeHead(200, {
      ...CABECALHOS_SEGURANCA, 'Content-Security-Policy': CSP, 'Content-Type': tipo, 'Cache-Control': 'no-cache',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : corpo);
  });
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return tratar(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  estatico(req, res, url);
});

if (require.main === module) {
  servidor.listen(PORTA, () => {
    console.log(`\n💜 Açaí Mix (local) em http://localhost:${PORTA}`);
    console.log(`   Admin: http://localhost:${PORTA}/admin   Cozinha: http://localhost:${PORTA}/cozinha`);
    console.log(`   Banco: ${URL_SUPABASE || '⚠ SUPABASE_URL não configurado no .env'}\n`);
  });
}

module.exports = { servidor };
