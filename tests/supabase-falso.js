// Imita a API do Supabase (RPC e Storage) em cima de um Postgres de verdade, para os testes.
// Cada chamada /rest/v1/rpc/<funcao> roda "select public.<funcao>(p := ...)" COMO service_role,
// então as permissões do schema.sql também são testadas.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { once } = require('node:events');

function psql(conexao, args, entrada) {
  return new Promise((resolve) => {
    const filho = execFile('psql', ['-d', conexao, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', ...args],
      { maxBuffer: 20 * 1024 * 1024 }, (erro, stdout, stderr) => resolve({ erro, stdout, stderr }));
    if (entrada !== undefined) { filho.stdin.write(entrada); filho.stdin.end(); }
  });
}

async function criarBanco(conexaoAdmin, schemaSql) {
  const nome = 'teste_' + crypto.randomBytes(5).toString('hex');
  for (const sql of ['create role anon nologin', 'create role authenticated nologin', 'create role service_role nologin bypassrls']) {
    await psql(conexaoAdmin, ['-c', sql]); // pode já existir
  }
  const r = await psql(conexaoAdmin, ['-c', `create database ${nome}`]);
  if (r.erro) throw new Error('Não consegui criar o banco de teste: ' + r.stderr);
  const url = new URL(conexaoAdmin);
  url.pathname = '/' + nome;
  const conexao = url.toString();
  const s = await psql(conexao, ['-f', '-'], schemaSql);
  if (s.erro) throw new Error('schema.sql falhou: ' + s.stderr);
  return { nome, conexao, apagar: () => psql(conexaoAdmin, ['-c', `drop database if exists ${nome} with (force)`]) };
}

async function subirSupabaseFalso({ conexao, chave }) {
  const arquivos = new Map();
  const servidor = http.createServer(async (req, res) => {
    const responder = (status, corpo, tipo = 'application/json') => {
      res.writeHead(status, { 'Content-Type': tipo });
      res.end(typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
    };
    const partes = [];
    for await (const c of req) partes.push(c);
    const corpo = Buffer.concat(partes);
    const url = new URL(req.url, 'http://x');

    // arquivos públicos não exigem chave
    const publico = url.pathname.match(/^\/storage\/v1\/object\/public\/fotos\/(.+)$/);
    if (req.method === 'GET' && publico) {
      const a = arquivos.get(publico[1]);
      return a ? responder(200, a.dados, a.tipo) : responder(404, { message: 'not found' });
    }
    if (req.headers.apikey !== chave) return responder(401, { message: 'Invalid API key' });

    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (req.method === 'POST' && rpc) {
      const p = JSON.parse(corpo.toString() || '{}').p ?? {};
      const tag = '$j' + crypto.randomBytes(6).toString('hex') + '$';
      const r = await psql(conexao, ['-c', 'set role service_role', '-c', `select public.${rpc[1]}(p := ${tag}${JSON.stringify(p)}${tag}::jsonb)`]);
      if (!r.erro) return responder(200, r.stdout.trim() || 'null');
      const m = r.stderr.match(/ERROR:\s+([A-Z0-9]{5}):\s+(.*)/);
      const codigo = m?.[1] || 'XX000';
      const status = /^PT\d{3}$/.test(codigo) ? Number(codigo.slice(2)) : codigo === 'P0001' ? 400 : codigo === '42501' ? 401 : 500;
      return responder(status, { code: codigo, message: m?.[2] || r.stderr });
    }

    const envio = url.pathname.match(/^\/storage\/v1\/object\/fotos\/(.+)$/);
    if (req.method === 'POST' && envio) {
      if (arquivos.has(envio[1])) return responder(409, { message: 'exists' });
      arquivos.set(envio[1], { dados: corpo, tipo: req.headers['content-type'] });
      return responder(200, { Key: 'fotos/' + envio[1] });
    }
    if (req.method === 'DELETE' && url.pathname === '/storage/v1/object/fotos') {
      for (const pre of JSON.parse(corpo.toString()).prefixes || []) arquivos.delete(pre);
      return responder(200, []);
    }
    responder(404, { message: 'rota falsa inexistente' });
  });
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  return { url: `http://127.0.0.1:${servidor.address().port}`, arquivos, fechar: () => servidor.close() };
}

module.exports = { criarBanco, subirSupabaseFalso, psql };
