// Cria um usuário ou troca a senha de um existente (útil se esquecer a senha do admin).
// Uso: npm run criar-usuario -- <usuario> <senha> [admin|cozinha]
'use strict';
require('../src/env').carregar();
const { db } = require('../src/db');
const { hashSenha } = require('../src/auth');

const [usuario, senha, papelArg] = process.argv.slice(2);
const papel = papelArg === 'cozinha' ? 'cozinha' : 'admin';
if (!usuario || !senha || senha.length < 8) {
  console.log('Uso: npm run criar-usuario -- <usuario> <senha com 8+ caracteres> [admin|cozinha]');
  process.exit(1);
}
db.prepare(`INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (?, ?, ?)
  ON CONFLICT(usuario) DO UPDATE SET senha_hash = excluded.senha_hash, papel = excluded.papel`).run(usuario, hashSenha(senha), papel);
db.prepare('DELETE FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE usuario = ?)').run(usuario);
console.log(`Usuário "${usuario}" (${papel}) salvo. Sessões antigas encerradas.`);
