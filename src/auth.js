// Autenticação da cozinha: senha com scrypt + sessões guardadas como hash.
'use strict';

const crypto = require('node:crypto');

const SESSAO_HORAS = 12;

function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`;
}

function conferirSenha(senha, armazenado) {
  const [alg, salHex, hashHex] = String(armazenado).split('$');
  if (alg !== 'scrypt' || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = crypto.scryptSync(String(senha), Buffer.from(salHex, 'hex'), esperado.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(esperado, calculado);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function criarSessao(db, usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expira = Date.now() + SESSAO_HORAS * 3600 * 1000;
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)').run(sha256(token), usuarioId, expira);
  return { token, maxAge: SESSAO_HORAS * 3600 };
}

function lerCookie(req, nome) {
  const header = req.headers.cookie || '';
  for (const parte of header.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

function usuarioDaSessao(db, req) {
  const token = lerCookie(req, 'sessao');
  if (!token) return null;
  const linha = db.prepare(`
    SELECT u.id, u.usuario, u.papel, s.expira_em FROM sessoes s
    JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!linha || linha.expira_em < Date.now()) return null;
  return linha;
}

function encerrarSessao(db, req) {
  const token = lerCookie(req, 'sessao');
  if (token) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(sha256(token));
}

module.exports = { hashSenha, conferirSenha, criarSessao, usuarioDaSessao, encerrarSessao };
