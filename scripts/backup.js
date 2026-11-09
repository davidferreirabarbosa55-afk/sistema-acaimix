// Baixa uma cópia dos dados do Supabase para o seu computador (arquivo JSON).
// Uso: npm run backup   → cria backups/acaimix-AAAA-MM-DD-HHMM.json
// Senhas e tokens de acompanhamento NÃO vão para o backup. As fotos continuam no Supabase Storage.
'use strict';
require('../src/env').carregar();
const fs = require('node:fs');
const path = require('node:path');
const { rpc } = require('../src/supabase');

(async () => {
  const dados = await rpc('api_exportar');
  const pasta = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(pasta, { recursive: true });
  const agora = new Date(Date.now() - 3 * 3600_000).toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15);
  const arquivo = path.join(pasta, `acaimix-${agora}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 1));
  console.log(`Backup salvo em ${arquivo}`);
  console.log(`${dados.pedidos.length} pedidos, ${dados.produtos.length} produtos.`);
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
