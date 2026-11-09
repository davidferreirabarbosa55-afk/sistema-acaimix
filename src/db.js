// Banco de dados SQLite (embutido no Node 22+, sem dependências externas).
// Valores em dinheiro são sempre guardados em CENTAVOS (inteiros) para evitar erros de arredondamento.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { hashSenha } = require('./auth');

const PASTA_DADOS = process.env.PASTA_DADOS || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(PASTA_DADOS, 'lanchonete.db');
const PASTA_UPLOADS = path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(PASTA_UPLOADS, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS categorias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT NOT NULL UNIQUE,
  ordem     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS produtos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  categoria_id  INTEGER NOT NULL REFERENCES categorias(id),
  nome          TEXT NOT NULL,
  descricao     TEXT NOT NULL DEFAULT '',
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos > 0),
  emoji         TEXT NOT NULL DEFAULT '🍧',
  disponivel    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS adicionais (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nome            TEXT NOT NULL,
  preco_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (preco_centavos >= 0),
  disponivel      INTEGER NOT NULL DEFAULT 1,
  ordem           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pedidos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo          TEXT NOT NULL,                 -- número curto mostrado ao cliente e à cozinha (ex: A042)
  token           TEXT NOT NULL UNIQUE,          -- segredo para o cliente acompanhar o pedido
  cliente_nome    TEXT NOT NULL,
  cliente_telefone TEXT NOT NULL DEFAULT '',
  cliente_email   TEXT NOT NULL DEFAULT '',
  tipo            TEXT NOT NULL CHECK (tipo IN ('retirada','mesa')),
  mesa            TEXT NOT NULL DEFAULT '',
  observacao      TEXT NOT NULL DEFAULT '',
  forma_pagamento TEXT NOT NULL CHECK (forma_pagamento IN ('pix','cartao','balcao')),
  total_centavos  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('aguardando_pagamento','recebido','em_preparo','pronto','entregue','cancelado')),
  criado_em       TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_criado ON pedidos(criado_em);

CREATE TABLE IF NOT EXISTS itens_pedido (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id      INTEGER NOT NULL REFERENCES produtos(id),
  nome            TEXT NOT NULL,                 -- cópia do nome/preço no momento da compra
  preco_centavos  INTEGER NOT NULL,              -- preço unitário JÁ com adicionais
  quantidade      INTEGER NOT NULL CHECK (quantidade BETWEEN 1 AND 50),
  observacao      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id         INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  provedor          TEXT NOT NULL,               -- 'mercadopago' ou 'simulado'
  metodo            TEXT NOT NULL,               -- 'pix' ou 'cartao'
  id_externo        TEXT,                        -- id do pagamento / preferência no Mercado Pago
  status            TEXT NOT NULL,               -- pending, approved, rejected, cancelled...
  valor_centavos    INTEGER NOT NULL,
  pix_copia_cola    TEXT,
  pix_qr_base64     TEXT,
  checkout_url      TEXT,
  criado_em         TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pag_pedido ON pagamentos(pedido_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pag_externo ON pagamentos(provedor, id_externo);

CREATE TABLE IF NOT EXISTS usuarios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario     TEXT NOT NULL UNIQUE,
  senha_hash  TEXT NOT NULL,
  papel       TEXT NOT NULL DEFAULT 'cozinha'      -- 'admin' ou 'cozinha'
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  quando    TEXT NOT NULL DEFAULT (datetime('now')),
  usuario   TEXT NOT NULL,
  acao      TEXT NOT NULL,
  detalhe   TEXT NOT NULL DEFAULT '',
  ip        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auditoria_quando ON auditoria(quando);
`);

// ---------- Migrações: atualiza bancos criados por versões anteriores ----------
function adicionarColuna(tabela, coluna, definicao) {
  const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
  if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}
adicionarColuna('produtos', 'imagem', "TEXT NOT NULL DEFAULT ''");
adicionarColuna('produtos', 'permite_adicionais', 'INTEGER NOT NULL DEFAULT 0');
adicionarColuna('produtos', 'destaque', 'INTEGER NOT NULL DEFAULT 0');
adicionarColuna('produtos', 'arquivado', 'INTEGER NOT NULL DEFAULT 0');
adicionarColuna('produtos', 'ordem', 'INTEGER NOT NULL DEFAULT 0');
adicionarColuna('itens_pedido', 'adicionais', "TEXT NOT NULL DEFAULT ''");

// ---------- Configurações da loja (editáveis no painel do admin) ----------
const CONFIG_PADRAO = {
  nome_loja: process.env.NOME_LOJA || 'Açaí Mix',
  slogan: 'Açaí e sorvetes do jeito que você gosta',
  loja_aberta: 'true',
  aviso: '',
  permitir_balcao: process.env.PERMITIR_BALCAO === 'false' ? 'false' : 'true',
  whatsapp: '',
  logo: '/logo-horizontal.jpg',
};
const insConfig = db.prepare('INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(CONFIG_PADRAO)) insConfig.run(k, v);

function lerConfig() {
  const c = { ...CONFIG_PADRAO };
  for (const { chave, valor } of db.prepare('SELECT chave, valor FROM configuracoes').all()) c[chave] = valor;
  return {
    nome_loja: c.nome_loja, slogan: c.slogan, aviso: c.aviso, whatsapp: c.whatsapp, logo: c.logo,
    loja_aberta: c.loja_aberta === 'true', permitir_balcao: c.permitir_balcao === 'true',
  };
}
function salvarConfig(chave, valor) {
  db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, String(valor));
}

// ---------- Dados iniciais (só na primeira execução) ----------
function semear() {
  const temCategoria = db.prepare('SELECT COUNT(*) AS n FROM categorias').get().n;
  if (!temCategoria) {
    // [nome, descrição, preço em centavos, emoji, permite adicionais, destaque]
    const cardapio = [
      ['Açaí', [
        ['Açaí 300ml', 'Açaí cremoso no copo. Escolha seus complementos', 1200, '🍧', 1, 0],
        ['Açaí 500ml', 'O tamanho preferido da casa. Escolha seus complementos', 1700, '🍧', 1, 1],
        ['Açaí 700ml', 'Para quem está com fome de verdade', 2200, '🍧', 1, 0],
        ['Açaí 1 litro', 'Para dividir (ou não 😉)', 3000, '🍧', 1, 0],
        ['Barca de Açaí', 'Açaí, frutas, granola e coberturas. Serve 2 a 3 pessoas', 4500, '🛶', 1, 1],
      ]],
      ['Sorvetes', [
        ['Sorvete 2 bolas', 'Escolha os sabores na observação', 1000, '🍨', 1, 0],
        ['Sorvete 3 bolas', 'Escolha os sabores na observação', 1400, '🍨', 1, 0],
        ['Casquinha', 'Baunilha, chocolate ou mista', 500, '🍦', 0, 0],
        ['Sundae', 'Sorvete com calda e cobertura', 1400, '🍨', 1, 0],
        ['Picolé de fruta', 'Pergunte os sabores do dia', 400, '🍡', 0, 0],
        ['Pote 1,5 litro', 'Para levar. Informe o sabor na observação', 3200, '🧊', 0, 0],
      ]],
      ['Milkshakes', [
        ['Milkshake 300ml', 'Morango, chocolate, ovomaltine ou açaí', 1500, '🥤', 0, 0],
        ['Milkshake 500ml', 'Morango, chocolate, ovomaltine ou açaí', 1900, '🥤', 0, 1],
      ]],
      ['Bebidas', [
        ['Água mineral', '500ml', 300, '💧', 0, 0],
        ['Refrigerante lata', '350ml', 600, '🥫', 0, 0],
        ['Suco natural', '400ml: laranja, maracujá, acerola ou umbu', 800, '🧃', 0, 0],
      ]],
    ];
    const insCat = db.prepare('INSERT INTO categorias (nome, ordem) VALUES (?, ?)');
    const insProd = db.prepare('INSERT INTO produtos (categoria_id, nome, descricao, preco_centavos, emoji, permite_adicionais, destaque, ordem) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    cardapio.forEach(([cat, itens], i) => {
      const catId = insCat.run(cat, i).lastInsertRowid;
      itens.forEach(([nome, desc, preco, emoji, adic, dest], j) => insProd.run(catId, nome, desc, preco, emoji, adic, dest, j));
    });
    db.exec('COMMIT');
  }

  const temAdicional = db.prepare('SELECT COUNT(*) AS n FROM adicionais').get().n;
  if (!temAdicional) {
    const adicionais = [
      ['Granola', 0], ['Banana', 0], ['Leite em pó', 200], ['Leite condensado', 200], ['Paçoca', 200],
      ['Granulado', 150], ['Confete', 200], ['Calda de chocolate', 150], ['Morango', 300], ['Kiwi', 300],
      ['Ovomaltine', 300], ['Bis', 300], ['Nutella', 500],
    ];
    const ins = db.prepare('INSERT INTO adicionais (nome, preco_centavos, ordem) VALUES (?, ?, ?)');
    adicionais.forEach(([n, p], i) => ins.run(n, p, i));
  }

  // Usuário da cozinha (primeira vez)
  if (!db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'cozinha'").get().n) {
    const senha = process.env.COZINHA_SENHA;
    if (senha && senha.length >= 8) {
      db.prepare("INSERT OR IGNORE INTO usuarios (usuario, senha_hash, papel) VALUES (?, ?, 'cozinha')")
        .run(process.env.COZINHA_USUARIO || 'cozinha', hashSenha(senha));
    }
  }
  // Administrador (primeira vez, ou ao atualizar um sistema que ainda não tinha admin)
  if (!db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'admin'").get().n) {
    const senha = process.env.ADMIN_SENHA;
    if (senha && senha.length >= 8) {
      db.prepare("INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (?, ?, 'admin') ON CONFLICT(usuario) DO UPDATE SET papel = 'admin', senha_hash = excluded.senha_hash")
        .run(process.env.ADMIN_USUARIO || 'admin', hashSenha(senha));
    } else {
      console.warn('[AVISO] Nenhum administrador cadastrado. Defina ADMIN_SENHA (mín. 8 caracteres) no arquivo .env e reinicie.');
    }
  }
}
semear();

// ---------- Manutenção periódica (roda ao iniciar e a cada 6 horas) ----------
// LGPD: dados pessoais do cliente só ficam o tempo necessário. Depois de RETENCAO_DIAS,
// o pedido continua nos relatórios, mas sem nome, telefone e e-mail.
const RETENCAO_DIAS = Math.max(7, Number(process.env.RETENCAO_DIAS || 180));
function manutencao() {
  const anon = db.prepare(`UPDATE pedidos SET cliente_nome = 'Cliente', cliente_telefone = '', cliente_email = ''
    WHERE criado_em < datetime('now', ?) AND (cliente_telefone <> '' OR cliente_email <> '' OR cliente_nome <> 'Cliente')`)
    .run(`-${RETENCAO_DIAS} days`).changes;
  db.prepare(`UPDATE pagamentos SET pix_copia_cola = NULL, pix_qr_base64 = NULL WHERE criado_em < datetime('now', '-2 days') AND pix_qr_base64 IS NOT NULL`).run();
  // Pedidos que nunca foram pagos (o Pix vence em 30 min) são cancelados depois de 2 horas.
  const cancelados = db.prepare(`UPDATE pedidos SET status = 'cancelado', atualizado_em = datetime('now')
    WHERE status = 'aguardando_pagamento' AND criado_em < datetime('now', '-2 hours')`).run().changes;
  db.prepare("DELETE FROM sessoes WHERE expira_em < ?").run(Date.now());
  db.prepare("DELETE FROM auditoria WHERE quando < datetime('now', '-365 days')").run();
  if (anon || cancelados) console.log(`[manutenção] ${anon} pedido(s) anonimizados, ${cancelados} não pago(s) cancelado(s).`);
}
manutencao();
setInterval(manutencao, 6 * 3600_000).unref();

module.exports = { db, lerConfig, salvarConfig, PASTA_UPLOADS };
