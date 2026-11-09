// Cria um usuário ou troca a senha de um existente (útil se esquecer a senha do admin).
// Uso: npm run criar-usuario -- <usuario> <senha> [admin|cozinha]
// Precisa de SUPABASE_URL e SUPABASE_SECRET_KEY no arquivo .env.
'use strict';
require('../src/env').carregar();
const { rpc } = require('../src/supabase');
const { hashSenha } = require('../src/auth');

const [usuario, senha, papelArg] = process.argv.slice(2);
const papel = papelArg === 'cozinha' ? 'cozinha' : 'admin';
if (!usuario || !senha || senha.length < 8) {
  console.log('Uso: npm run criar-usuario -- <usuario> <senha com 8+ caracteres> [admin|cozinha]');
  process.exit(1);
}
(async () => {
  await rpc('api_usuario_definir', { usuario: usuario.toLowerCase(), senha_hash: await hashSenha(senha), papel });
  console.log(`Usuário "${usuario.toLowerCase()}" (${papel}) salvo. Sessões antigas encerradas.`);
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
