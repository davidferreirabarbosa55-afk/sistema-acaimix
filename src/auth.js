// Autenticação: senha com scrypt + sessões guardadas no banco como hash (nunca o token puro).
'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { rpc } = require('./supabase');

const scrypt = promisify(crypto.scrypt);
const OPCOES = { N: 16384, r: 8, p: 1 };
const SESSAO_HORAS = 12;

async function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(String(senha), sal, 64, OPCOES);
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`;
}

async function conferirSenha(senha, armazenado) {
  const [alg, salHex, hashHex] = String(armazenado).split('$');
  if (alg !== 'scrypt' || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = await scrypt(String(senha), Buffer.from(salHex, 'hex'), esperado.length, OPCOES);
  return crypto.timingSafeEqual(esperado, calculado);
}

// Mesmo custo de uma conferência real: quem tenta um usuário inexistente não descobre isso pelo tempo de resposta.
const HASH_FALSO = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
const conferirFalso = () => conferirSenha('x', HASH_FALSO).then(() => false);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lerCookie(req, nome) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

async function criarSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await rpc('api_criar_sessao', { usuario_id: usuarioId, token_hash: sha256(token), segundos: SESSAO_HORAS * 3600 });
  return { token, maxAge: SESSAO_HORAS * 3600 };
}

async function usuarioDaSessao(req) {
  const token = lerCookie(req, 'sessao');
  if (!token || token.length > 100) return null;
  return rpc('api_sessao', { token_hash: sha256(token) });
}

async function encerrarSessao(req) {
  const token = lerCookie(req, 'sessao');
  if (token && token.length <= 100) await rpc('api_encerrar_sessao', { token_hash: sha256(token) });
}

module.exports = { hashSenha, conferirSenha, conferirFalso, criarSessao, usuarioDaSessao, encerrarSessao };
