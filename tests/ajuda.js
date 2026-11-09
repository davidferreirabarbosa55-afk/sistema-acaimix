// Utilitários dos testes: sobe o servidor numa porta livre com um banco temporário.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

async function subirServidor(env = {}) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'acaimix-teste-'));
  Object.assign(process.env, {
    DB_PATH: path.join(pasta, 'teste.db'), PORTA: '0', NODE_ENV: 'test',
    ADMIN_USUARIO: 'admin', ADMIN_SENHA: 'admin-teste-123',
    COZINHA_USUARIO: 'cozinha', COZINHA_SENHA: 'cozinha-teste-123',
    MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', URL_PUBLICA: '',
    ...env,
  });
  const console_log = console.log;
  console.log = () => {}; // silencia a mensagem de início
  const { servidor } = require('../src/server');
  if (!servidor.listening) await once(servidor, 'listening');
  console.log = console_log;
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const fechar = () => {
    servidor.closeAllConnections();
    servidor.close();
    fs.rmSync(pasta, { recursive: true, force: true });
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

  return { base, chamar, entrar, fechar };
}

module.exports = { subirServidor };
