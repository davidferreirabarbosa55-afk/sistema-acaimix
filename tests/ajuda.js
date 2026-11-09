// Utilitários dos testes: cria um banco Postgres novo com o schema.sql, sobe o "Supabase falso"
// e o servidor local do sistema apontando para ele.
//
// Precisa de um Postgres acessível. Por padrão usa o do ambiente de testes; para outro, defina PG_TESTE,
// ex.: PG_TESTE="postgresql://postgres:postgres@localhost:5432/postgres" npm test
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { criarBanco, subirSupabaseFalso } = require('./supabase-falso');

const PG = process.env.PG_TESTE || 'postgresql://postgres@localhost:54329/postgres?host=/tmp/pgteste';
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');

async function subirServidor(env = {}) {
  const banco = await criarBanco(PG, SCHEMA);
  const chave = 'sb_secret_teste_' + Math.random().toString(36).slice(2);
  const supabase = await subirSupabaseFalso({ conexao: banco.conexao, chave });
  Object.assign(process.env, {
    SUPABASE_URL: supabase.url, SUPABASE_SECRET_KEY: chave, NODE_ENV: 'test', CRON_SECRET: 'segredo-do-cron-123',
    ADMIN_USUARIO: 'admin', ADMIN_SENHA: 'admin-teste-123', COZINHA_USUARIO: 'cozinha', COZINHA_SENHA: 'cozinha-teste-123',
    MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', URL_PUBLICA: '',
    ...env,
  });
  const { servidor } = require('../src/local');
  servidor.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const fechar = async () => {
    servidor.closeAllConnections();
    servidor.close();
    supabase.fechar();
    await banco.apagar();
  };

  async function chamar(caminho, { metodo = 'GET', corpo, cookie, cabecalhos = {} } = {}) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...cabecalhos },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    let json; try { json = JSON.parse(texto); } catch { json = texto; }
    return { status: r.status, json, cabecalhos: r.headers };
  }

  async function entrar(usuario, senha) {
    const r = await chamar('/api/login', { metodo: 'POST', corpo: { usuario, senha } });
    if (r.status !== 200) throw new Error(`login falhou: ${JSON.stringify(r.json)}`);
    return r.cabecalhos.get('set-cookie').split(';')[0];
  }

  return { base, chamar, entrar, fechar, supabase, banco };
}

module.exports = { subirServidor };
