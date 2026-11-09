// Gera uma cópia segura do banco de dados (pode rodar com o sistema ligado).
// Uso: npm run backup      → cria data/backup-AAAA-MM-DD-HHMM.db (ou /data/... no Fly.io)
'use strict';
require('../src/env').carregar();
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const pasta = process.env.PASTA_DADOS || path.join(__dirname, '..', 'data');
const origem = process.env.DB_PATH || path.join(pasta, 'lanchonete.db');
const agora = new Date(Date.now() - 3 * 3600_000).toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15);
const destino = path.join(path.dirname(origem), `backup-${agora}.db`);

const db = new DatabaseSync(origem, { readOnly: true });
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup criado: ${destino}`);
console.log('As fotos dos produtos ficam na pasta "uploads", ao lado do banco.');
