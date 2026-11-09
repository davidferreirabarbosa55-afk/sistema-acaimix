// Servidor da Açaí Mix: API + cardápio + painel da cozinha + painel do administrador.
// Sem dependências externas: usa apenas módulos do Node.js 22+.
'use strict';

require('./env').carregar();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { db, lerConfig, salvarConfig, PASTA_UPLOADS } = require('./db');
const auth = require('./auth');
const pag = require('./pagamentos');

const PORTA = Number(process.env.PORTA || 3000);
const PRODUCAO = process.env.NODE_ENV === 'production';
const FUSO = `${Number(process.env.FUSO_HORARIO || -3)} hours`; // para relatórios "de hoje" no horário local
const PASTA_PUBLICA = path.join(__dirname, '..', 'public');
const LIMITE_CORPO = 32 * 1024;
const LIMITE_IMAGEM = 3 * 1024 * 1024;

// ======================= utilidades HTTP =======================
const CABECALHOS_SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; script-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  ...(PRODUCAO ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

function json(res, status, dados, extras = {}) {
  res.writeHead(status, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extras });
  res.end(JSON.stringify(dados));
}

class ErroHttp extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function lerCorpo(req, limite = LIMITE_CORPO) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > limite) { reject(new ErroHttp(413, 'Arquivo ou requisição muito grande')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      const texto = Buffer.concat(partes).toString('utf8');
      if (!texto) return resolve({});
      try { resolve(JSON.parse(texto)); } catch { reject(new ErroHttp(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function ipDe(req) {
  // Atrás de um proxy confiável (Fly.io, Nginx, Render...), ative CONFIAR_PROXY=true.
  if (process.env.CONFIAR_PROXY === 'true') {
    // O Fly.io informa o IP real do visitante neste cabeçalho (o visitante não consegue forjá-lo).
    const fly = String(req.headers['fly-client-ip'] || '').trim();
    if (fly) return fly;
    // Em outros proxies: o ÚLTIMO endereço é o que o proxy adicionou. Os primeiros podem ser
    // inventados pelo próprio visitante para driblar o limite de tentativas.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

// Limite de requisições por IP, com janela própria para cada tipo de rota.
// Atenção: o Wi-Fi da loja coloca muitos clientes atrás do MESMO IP, por isso os
// limites públicos são folgados; o login é o mais rígido (10 tentativas a cada 15 min).
// O contador fica na memória: rode UM processo só (o normal para uma loja).
const LIMITES = {
  login:    { max: 10,  janela: 15 * 60_000, msg: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  pedido:   { max: 20,  janela: 60_000 },
  consulta: { max: 600, janela: 60_000 },
  webhook:  { max: 300, janela: 60_000 },
};
const contadores = new Map();
function limitar(req, chave) {
  const { max, janela, msg } = LIMITES[chave];
  const k = `${chave}:${ipDe(req)}`;
  const agora = Date.now();
  const reg = contadores.get(k);
  if (!reg || agora - reg.inicio > janela) { contadores.set(k, { inicio: agora, n: 1, janela }); return; }
  if (++reg.n > max) throw new ErroHttp(429, msg || 'Muitas tentativas. Aguarde um minuto.');
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of contadores) if (agora - v.inicio > v.janela) contadores.delete(k);
}, 60_000).unref();

// Proteção CSRF para rotas com login: só aceita requisições vindas do próprio site.
// (O cookie SameSite=Strict já barra a maioria; isto é a segunda camada.)
function exigirMesmaOrigem(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new ErroHttp(403, 'Origem não permitida');
  const origem = req.headers.origin;
  if (!origem) return;
  const host = (process.env.CONFIAR_PROXY === 'true' && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    if (new URL(origem).host !== host) throw new Error();
  } catch { throw new ErroHttp(403, 'Origem não permitida'); }
}

// Registro de atividades (quem fez o quê): logins, mudanças de preço, usuários, cancelamentos.
function registrar(req, usuario, acao, detalhe = '') {
  try {
    db.prepare('INSERT INTO auditoria (usuario, acao, detalhe, ip) VALUES (?, ?, ?, ?)')
      .run(usuario || '-', acao, String(detalhe).slice(0, 300), req ? ipDe(req) : '');
  } catch (e) { console.error('[auditoria]', e.message); }
}

function exigirLogin(req, papeis) {
  const u = auth.usuarioDaSessao(db, req);
  if (!u) throw new ErroHttp(401, 'Faça login');
  if (!papeis.includes(u.papel)) throw new ErroHttp(403, 'Sem permissão para esta área.');
  if (req.method !== 'GET') exigirMesmaOrigem(req);
  return u;
}
const exigirCozinha = (req) => exigirLogin(req, ['cozinha', 'admin']);
const exigirAdmin = (req) => exigirLogin(req, ['admin']);

const dinheiroTxt = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
const texto = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const bool = (v) => v === true || v === 1 || v === 'true' || v === '1';

// Aceita "12,50", "12.50", 12.5 ou centavos inteiros em campo *_centavos.
function centavos(v, { min = 0, max = 10_000_000 } = {}) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new ErroHttp(400, 'Preço inválido.');
  const c = Math.round(n);
  if (c < min || c > max) throw new ErroHttp(400, 'Preço fora do permitido.');
  return c;
}

// ======================= tempo real (cozinha) =======================
const ouvintesCozinha = new Set();
function avisarCozinha(evento, dados) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of ouvintesCozinha) res.write(msg);
}
setInterval(() => { for (const res of ouvintesCozinha) res.write(': ping\n\n'); }, 25000).unref();

// ======================= consultas de pedidos =======================
function itensDoPedido(pedidoId) {
  return db.prepare('SELECT produto_id, nome, preco_centavos, quantidade, observacao, adicionais FROM itens_pedido WHERE pedido_id = ? ORDER BY id').all(pedidoId);
}

// A cozinha não precisa do telefone do cliente (dado pessoal); só o admin vê.
function pedidoParaCozinha(p, itens = itensDoPedido(p.id), comTelefone = false) {
  return {
    id: p.id, codigo: p.codigo, status: p.status, cliente_nome: p.cliente_nome,
    ...(comTelefone ? { cliente_telefone: p.cliente_telefone } : {}),
    tipo: p.tipo, mesa: p.mesa, observacao: p.observacao, forma_pagamento: p.forma_pagamento, total_centavos: p.total_centavos,
    criado_em: p.criado_em, atualizado_em: p.atualizado_em, itens,
  };
}

// Monta uma lista de pedidos com UMA consulta de itens (em vez de uma por pedido).
function listaDePedidos(pedidos, comTelefone = false) {
  if (!pedidos.length) return [];
  const ids = pedidos.map((p) => p.id);
  const porPedido = new Map(ids.map((id) => [id, []]));
  const itens = db.prepare(`SELECT pedido_id, produto_id, nome, preco_centavos, quantidade, observacao, adicionais
    FROM itens_pedido WHERE pedido_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  for (const { pedido_id, ...i } of itens) porPedido.get(pedido_id).push(i);
  return pedidos.map((p) => pedidoParaCozinha(p, porPedido.get(p.id), comTelefone));
}

function pedidoParaCliente(p) {
  const pg = db.prepare('SELECT metodo, status, pix_copia_cola, pix_qr_base64, checkout_url FROM pagamentos WHERE pedido_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
  return {
    codigo: p.codigo, status: p.status, cliente_nome: p.cliente_nome, tipo: p.tipo, mesa: p.mesa,
    forma_pagamento: p.forma_pagamento, total_centavos: p.total_centavos, criado_em: p.criado_em,
    itens: itensDoPedido(p.id).map(({ nome, preco_centavos, quantidade, observacao, adicionais }) => ({ nome, preco_centavos, quantidade, observacao, adicionais })),
    pagamento: pg || null,
    modo_simulado: pag.modoSimulado,
  };
}

function mudarStatus(pedidoId, novo) {
  db.prepare("UPDATE pedidos SET status = ?, atualizado_em = datetime('now') WHERE id = ?").run(novo, pedidoId);
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
  avisarCozinha('pedido', pedidoParaCozinha(p));
  return p;
}

// Aplica o resultado de um pagamento CONSULTADO na API (nunca o corpo do webhook).
function aplicarPagamento(info) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(info.pedidoId);
  if (!pedido) return;

  const existente = db.prepare("SELECT id FROM pagamentos WHERE provedor = 'mercadopago' AND id_externo = ?").get(info.id);
  if (existente) {
    db.prepare("UPDATE pagamentos SET status = ?, atualizado_em = datetime('now') WHERE id = ?").run(info.status, existente.id);
  } else {
    db.prepare('INSERT INTO pagamentos (pedido_id, provedor, metodo, id_externo, status, valor_centavos) VALUES (?, ?, ?, ?, ?, ?)')
      .run(pedido.id, 'mercadopago', info.metodo, info.id, info.status, info.valorCentavos);
  }

  if (info.status === 'approved' && pedido.status === 'cancelado') {
    // Ex.: cliente pagou um Pix depois que o pedido foi cancelado por demora. Precisa de reembolso.
    console.error(`[ALERTA] Pedido ${pedido.codigo} estava CANCELADO mas recebeu pagamento ${info.id}. Faça o reembolso no Mercado Pago.`);
    registrar(null, 'sistema', 'ALERTA: pagamento em pedido cancelado', `Pedido ${pedido.codigo}, pagamento ${info.id}: reembolsar no Mercado Pago`);
    return;
  }
  if (info.status === 'approved' && pedido.status === 'aguardando_pagamento') {
    if (info.valorCentavos !== pedido.total_centavos) {
      console.error(`[ALERTA] Pedido ${pedido.codigo}: valor pago ${info.valorCentavos} difere do total ${pedido.total_centavos}. Não liberado.`);
      registrar(null, 'sistema', 'ALERTA: valor pago diferente', `Pedido ${pedido.codigo}: pago ${info.valorCentavos}, total ${pedido.total_centavos}`);
      return;
    }
    mudarStatus(pedido.id, 'recebido');
    console.log(`[pagamento] Pedido ${pedido.codigo} pago e enviado para a cozinha.`);
  }
}

// Se o webhook não chegar (ex.: rodando no computador local), o cliente pode
// disparar uma conferência direto na API, no máximo a cada 10 segundos por pedido.
const ultimaConferencia = new Map();
async function conferirPagamentoPendente(pedido, paymentIdDaUrl) {
  if (pag.modoSimulado || pedido.status !== 'aguardando_pagamento') return;
  const agora = Date.now();
  if (agora - (ultimaConferencia.get(pedido.id) || 0) < 10000) return;
  ultimaConferencia.set(pedido.id, agora);

  const ids = new Set();
  if (paymentIdDaUrl && /^\d{1,20}$/.test(paymentIdDaUrl)) ids.add(paymentIdDaUrl);
  for (const r of db.prepare("SELECT id_externo FROM pagamentos WHERE pedido_id = ? AND provedor = 'mercadopago' AND id_externo NOT LIKE 'pref-%'").all(pedido.id)) {
    ids.add(r.id_externo);
  }
  for (const id of ids) {
    try {
      const info = await pag.consultarPagamento(id);
      if (info.pedidoId === pedido.id) aplicarPagamento(info); // ignora ids de outros pedidos
    } catch (e) { console.error('[pagamento] Falha ao conferir', id, e.message); }
  }
}

function gerarCodigo(id) {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return letras[Math.floor(id / 1000) % letras.length] + String(id % 1000).padStart(3, '0');
}

// ======================= imagens enviadas pelo admin =======================
// Aceita só JPG, PNG e WEBP, conferindo os bytes do arquivo (não o nome).
function salvarImagem(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new ErroHttp(400, 'Envie uma imagem JPG, PNG ou WEBP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw new ErroHttp(413, 'Imagem maior que 2 MB. Diminua e tente de novo.');
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) throw new ErroHttp(400, 'Arquivo de imagem inválido.');
  const nome = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PASTA_UPLOADS, nome), buf);
  return `/uploads/${nome}`;
}
function apagarImagem(caminho) {
  if (!caminho || !caminho.startsWith('/uploads/')) return;
  const arq = path.join(PASTA_UPLOADS, path.basename(caminho));
  fs.rm(arq, { force: true }, () => {});
}

// ======================= rotas =======================
const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, padrao, fn });

// ---------------- Público ----------------
// Verificação de saúde usada pelo Fly.io para saber se o app está no ar.
rota('GET', /^\/api\/saude$/, async (req, res) => {
  db.prepare('SELECT 1').get();
  json(res, 200, { ok: true });
});

rota('GET', /^\/api\/config$/, async (req, res) => {
  json(res, 200, { ...lerConfig(), modo_simulado: pag.modoSimulado });
});

rota('GET', /^\/api\/cardapio$/, async (req, res) => {
  const categorias = db.prepare('SELECT id, nome FROM categorias ORDER BY ordem, id').all();
  const produtos = db.prepare(`SELECT id, categoria_id, nome, descricao, preco_centavos, emoji, imagem, permite_adicionais, destaque
    FROM produtos WHERE disponivel = 1 AND arquivado = 0 ORDER BY ordem, id`).all();
  const adicionais = db.prepare('SELECT id, nome, preco_centavos FROM adicionais WHERE disponivel = 1 ORDER BY ordem, id').all();
  json(res, 200, {
    categorias: categorias.map((c) => ({ ...c, produtos: produtos.filter((p) => p.categoria_id === c.id) })).filter((c) => c.produtos.length),
    adicionais,
  });
});

rota('POST', /^\/api\/pedidos$/, async (req, res) => {
  limitar(req, 'pedido');
  const cfg = lerConfig();
  if (!cfg.loja_aberta) throw new ErroHttp(400, 'Estamos fechados no momento. Volte mais tarde! 💜');
  const b = await lerCorpo(req);

  // ---- validação ----
  const nome = texto(b.cliente?.nome, 60);
  const telefone = texto(b.cliente?.telefone, 20).replace(/[^\d+() -]/g, '');
  const email = texto(b.cliente?.email, 120).toLowerCase();
  const tipo = b.tipo === 'mesa' ? 'mesa' : 'retirada';
  const mesa = tipo === 'mesa' ? texto(b.mesa, 10) : '';
  const observacao = texto(b.observacao, 200);
  const forma = ['pix', 'cartao', 'balcao'].includes(b.forma_pagamento) ? b.forma_pagamento : null;

  if (nome.length < 2) throw new ErroHttp(400, 'Informe seu nome.');
  if (tipo === 'mesa' && !mesa) throw new ErroHttp(400, 'Informe o número da mesa.');
  if (!forma) throw new ErroHttp(400, 'Escolha a forma de pagamento.');
  if (forma === 'balcao' && !cfg.permitir_balcao) throw new ErroHttp(400, 'Pagamento no balcão indisponível.');
  if (forma === 'pix' && !pag.modoSimulado && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ErroHttp(400, 'Para pagar com Pix, informe um e-mail válido.');
  }
  if (!Array.isArray(b.itens) || b.itens.length < 1 || b.itens.length > 30) throw new ErroHttp(400, 'Sacola vazia ou inválida.');

  // ---- preços SEMPRE vêm do banco, nunca do navegador ----
  const buscarProduto = db.prepare('SELECT id, nome, preco_centavos, permite_adicionais FROM produtos WHERE id = ? AND disponivel = 1 AND arquivado = 0');
  const buscarAdicional = db.prepare('SELECT id, nome, preco_centavos FROM adicionais WHERE id = ? AND disponivel = 1');
  const itens = b.itens.map((i) => {
    const qtd = Number(i.quantidade);
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > 20) throw new ErroHttp(400, 'Quantidade inválida.');
    const prod = buscarProduto.get(Number(i.produto_id));
    if (!prod) throw new ErroHttp(400, 'Um dos itens não está mais disponível. Atualize o cardápio.');

    const idsAdic = Array.isArray(i.adicionais) ? [...new Set(i.adicionais.map(Number))] : [];
    if (idsAdic.length && !prod.permite_adicionais) throw new ErroHttp(400, `${prod.nome} não aceita adicionais.`);
    if (idsAdic.length > 15) throw new ErroHttp(400, 'Muitos adicionais em um item.');
    const adics = idsAdic.map((id) => {
      const a = buscarAdicional.get(id);
      if (!a) throw new ErroHttp(400, 'Um adicional não está mais disponível. Atualize o cardápio.');
      return a;
    });
    const unitario = prod.preco_centavos + adics.reduce((s, a) => s + a.preco_centavos, 0);
    return {
      produto_id: prod.id, nome: prod.nome, preco_centavos: unitario, quantidade: qtd,
      observacao: texto(i.observacao, 140), adicionais: adics.map((a) => a.nome).join(', '),
    };
  });
  const total = itens.reduce((s, i) => s + i.preco_centavos * i.quantidade, 0);

  // ---- grava pedido e itens numa única transação ----
  const token = crypto.randomBytes(24).toString('base64url');
  const statusInicial = forma === 'balcao' ? 'recebido' : 'aguardando_pagamento';
  let pedido;
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = db.prepare(`INSERT INTO pedidos (codigo, token, cliente_nome, cliente_telefone, cliente_email, tipo, mesa, observacao, forma_pagamento, total_centavos, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, token, nome, telefone, email, tipo, mesa, observacao, forma, total, statusInicial).lastInsertRowid;
    db.prepare('UPDATE pedidos SET codigo = ? WHERE id = ?').run(gerarCodigo(Number(id)), id);
    const insItem = db.prepare('INSERT INTO itens_pedido (pedido_id, produto_id, nome, preco_centavos, quantidade, observacao, adicionais) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const i of itens) insItem.run(id, i.produto_id, i.nome, i.preco_centavos, i.quantidade, i.observacao, i.adicionais);
    db.exec('COMMIT');
    pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // ---- pagamento ----
  if (forma === 'balcao') {
    avisarCozinha('pedido', pedidoParaCozinha(pedido));
  } else {
    try {
      const itensPagamento = itens.map((i) => ({ ...i, nome: i.adicionais ? `${i.nome} (${i.adicionais})`.slice(0, 250) : i.nome }));
      const r = forma === 'pix' ? await pag.criarPix(pedido) : await pag.criarCheckoutCartao(pedido, itensPagamento);
      db.prepare(`INSERT INTO pagamentos (pedido_id, provedor, metodo, id_externo, status, valor_centavos, pix_copia_cola, pix_qr_base64, checkout_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pedido.id, r.provedor, r.metodo, r.id_externo, r.status, total, r.pix_copia_cola, r.pix_qr_base64, r.checkout_url);
    } catch (e) {
      console.error('[pagamento] Erro ao criar cobrança:', e.message);
      mudarStatus(pedido.id, 'cancelado');
      throw new ErroHttp(502, 'Não foi possível gerar o pagamento agora. Tente novamente.');
    }
  }

  json(res, 201, { token, pedido: pedidoParaCliente(pedido) });
});

rota('GET', /^\/api\/pedidos\/([A-Za-z0-9_-]{20,64})$/, async (req, res, m, url) => {
  limitar(req, 'consulta');
  let pedido = db.prepare('SELECT * FROM pedidos WHERE token = ?').get(m[1]);
  if (!pedido) throw new ErroHttp(404, 'Pedido não encontrado.');
  await conferirPagamentoPendente(pedido, url.searchParams.get('payment_id'));
  pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id);
  json(res, 200, pedidoParaCliente(pedido));
});

// Apenas no MODO SIMULADO: botão para fingir que o pagamento foi aprovado.
rota('POST', /^\/api\/pedidos\/([A-Za-z0-9_-]{20,64})\/simular-pagamento$/, async (req, res, m) => {
  if (!pag.modoSimulado) throw new ErroHttp(404, 'Não encontrado');
  const pedido = db.prepare('SELECT * FROM pedidos WHERE token = ?').get(m[1]);
  if (!pedido) throw new ErroHttp(404, 'Pedido não encontrado.');
  if (pedido.status === 'aguardando_pagamento') {
    db.prepare("UPDATE pagamentos SET status = 'approved', atualizado_em = datetime('now') WHERE pedido_id = ?").run(pedido.id);
    mudarStatus(pedido.id, 'recebido');
  }
  json(res, 200, pedidoParaCliente(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id)));
});

// Webhook do Mercado Pago.
rota('POST', /^\/api\/webhooks\/mercadopago$/, async (req, res, m, url) => {
  limitar(req, 'webhook');
  const corpo = await lerCorpo(req).catch(() => ({}));
  const tipoEvento = url.searchParams.get('type') || url.searchParams.get('topic') || corpo.type || corpo.topic;
  const dataId = url.searchParams.get('data.id') || corpo?.data?.id || url.searchParams.get('id');

  if (!dataId) return json(res, 200, { ok: true });
  if (!pag.assinaturaValida(req.headers, String(dataId))) {
    console.warn('[webhook] Assinatura inválida recusada. IP:', ipDe(req));
    return json(res, 401, { erro: 'assinatura inválida' });
  }
  if (tipoEvento !== 'payment' || pag.modoSimulado) return json(res, 200, { ok: true });

  try {
    const info = await pag.consultarPagamento(String(dataId));
    aplicarPagamento(info);
  } catch (e) {
    console.error('[webhook] Erro ao consultar pagamento', dataId, e.message);
    return json(res, 500, { erro: 'tente novamente' }); // o Mercado Pago reenvia depois
  }
  json(res, 200, { ok: true });
});

// ---------------- Login (cozinha e admin) ----------------
async function fazerLogin(req, res) {
  exigirMesmaOrigem(req);
  limitar(req, 'login');
  const b = await lerCorpo(req);
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(texto(b.usuario, 40));
  const ok = u ? auth.conferirSenha(String(b.senha || ''), u.senha_hash) : (auth.conferirSenha('x', 'scrypt$00$00'), false);
  if (!ok) {
    registrar(req, texto(b.usuario, 40), 'login recusado');
    throw new ErroHttp(401, 'Usuário ou senha incorretos.');
  }
  registrar(req, u.usuario, 'login');
  const s = auth.criarSessao(db, u.id);
  const seguro = PRODUCAO ? '; Secure' : '';
  json(res, 200, { usuario: u.usuario, papel: u.papel }, {
    'Set-Cookie': `sessao=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${s.maxAge}${seguro}`,
  });
}
async function fazerLogout(req, res) {
  exigirMesmaOrigem(req);
  auth.encerrarSessao(db, req);
  json(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
}
rota('POST', /^\/api\/(?:cozinha\/)?login$/, (req, res) => fazerLogin(req, res));
rota('POST', /^\/api\/(?:cozinha\/)?logout$/, (req, res) => fazerLogout(req, res));
rota('GET', /^\/api\/(?:cozinha\/)?me$/, async (req, res) => {
  const u = auth.usuarioDaSessao(db, req);
  if (!u) throw new ErroHttp(401, 'Faça login');
  json(res, 200, { usuario: u.usuario, papel: u.papel });
});

// ---------------- Cozinha ----------------
rota('GET', /^\/api\/cozinha\/pedidos$/, async (req, res) => {
  exigirCozinha(req);
  const ativos = db.prepare(`SELECT * FROM pedidos WHERE status IN ('recebido','em_preparo','pronto') ORDER BY id`).all();
  json(res, 200, listaDePedidos(ativos));
});

const TRANSICOES = {
  recebido: ['em_preparo', 'cancelado'],
  em_preparo: ['pronto', 'recebido', 'cancelado'],
  pronto: ['entregue', 'em_preparo'],
  entregue: ['pronto'],
};
rota('PATCH', /^\/api\/cozinha\/pedidos\/(\d+)$/, async (req, res, m) => {
  const eu = exigirCozinha(req);
  const b = await lerCorpo(req);
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(Number(m[1]));
  if (!p) throw new ErroHttp(404, 'Pedido não encontrado.');
  if (!(TRANSICOES[p.status] || []).includes(b.status)) throw new ErroHttp(400, 'Mudança de status não permitida.');
  if (b.status === 'cancelado') {
    registrar(req, eu.usuario, 'cancelou pedido', `${p.codigo} (${dinheiroTxt(p.total_centavos)}, ${{ pix: 'Pix', cartao: 'cartão', balcao: 'balcão' }[p.forma_pagamento]})` +
      (p.forma_pagamento === 'balcao' ? '' : ' — já estava pago: reembolsar no Mercado Pago'));
  }
  json(res, 200, pedidoParaCozinha(mudarStatus(p.id, b.status)));
});

rota('GET', /^\/api\/cozinha\/produtos$/, async (req, res) => {
  exigirCozinha(req);
  json(res, 200, {
    produtos: db.prepare('SELECT p.id, p.nome, p.emoji, p.disponivel, c.nome AS categoria FROM produtos p JOIN categorias c ON c.id = p.categoria_id WHERE p.arquivado = 0 ORDER BY c.ordem, p.ordem, p.id').all(),
    adicionais: db.prepare('SELECT id, nome, disponivel FROM adicionais ORDER BY ordem, id').all(),
  });
});

rota('PATCH', /^\/api\/cozinha\/(produtos|adicionais)\/(\d+)$/, async (req, res, m) => {
  const eu = exigirCozinha(req);
  const b = await lerCorpo(req);
  const tabela = m[1] === 'produtos' ? 'produtos' : 'adicionais';
  const r = db.prepare(`UPDATE ${tabela} SET disponivel = ? WHERE id = ?`).run(bool(b.disponivel) ? 1 : 0, Number(m[2]));
  if (!r.changes) throw new ErroHttp(404, 'Item não encontrado.');
  const item = db.prepare(`SELECT nome FROM ${tabela} WHERE id = ?`).get(Number(m[2]));
  registrar(req, eu.usuario, bool(b.disponivel) ? 'voltou ao cardápio' : 'tirou do cardápio', item.nome);
  json(res, 200, { ok: true });
});

rota('GET', /^\/api\/cozinha\/eventos$/, async (req, res) => {
  exigirCozinha(req);
  res.writeHead(200, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  ouvintesCozinha.add(res);
  req.on('close', () => ouvintesCozinha.delete(res));
});

// ---------------- Administrador ----------------
rota('GET', /^\/api\/admin\/resumo$/, async (req, res) => {
  exigirAdmin(req);
  const VALIDO = "status NOT IN ('aguardando_pagamento','cancelado')";
  const hoje = db.prepare(`SELECT COUNT(*) AS pedidos, COALESCE(SUM(total_centavos),0) AS faturamento
    FROM pedidos WHERE ${VALIDO} AND date(criado_em, ?) = date('now', ?)`).get(FUSO, FUSO);
  const emAndamento = db.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE status IN ('recebido','em_preparo','pronto')").get().n;
  const dias = db.prepare(`SELECT date(criado_em, ?) AS dia, COUNT(*) AS pedidos, SUM(total_centavos) AS faturamento
    FROM pedidos WHERE ${VALIDO} AND date(criado_em, ?) >= date('now', ?, '-6 days')
    GROUP BY dia ORDER BY dia`).all(FUSO, FUSO, FUSO);
  const maisVendidos = db.prepare(`SELECT i.nome, SUM(i.quantidade) AS quantidade, SUM(i.quantidade * i.preco_centavos) AS total
    FROM itens_pedido i JOIN pedidos p ON p.id = i.pedido_id
    WHERE p.${VALIDO} AND date(p.criado_em, ?) >= date('now', ?, '-29 days')
    GROUP BY i.nome ORDER BY quantidade DESC LIMIT 5`).all(FUSO, FUSO);
  const porPagamento = db.prepare(`SELECT forma_pagamento, COUNT(*) AS pedidos, SUM(total_centavos) AS total
    FROM pedidos WHERE ${VALIDO} AND date(criado_em, ?) = date('now', ?) GROUP BY forma_pagamento`).all(FUSO, FUSO);
  const alertas = db.prepare("SELECT quando, acao, detalhe FROM auditoria WHERE (acao LIKE 'ALERTA%' OR detalhe LIKE '%reembolsar%') AND quando >= datetime('now', '-7 days') ORDER BY id DESC LIMIT 5").all();
  json(res, 200, { hoje: { ...hoje, ticket_medio: hoje.pedidos ? Math.round(hoje.faturamento / hoje.pedidos) : 0, em_andamento: emAndamento }, dias, mais_vendidos: maisVendidos, por_pagamento: porPagamento, alertas });
});

rota('GET', /^\/api\/admin\/pedidos$/, async (req, res, m, url) => {
  exigirAdmin(req);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('dia') || '') ? url.searchParams.get('dia') : null;
  const lista = dia
    ? db.prepare('SELECT * FROM pedidos WHERE date(criado_em, ?) = ? ORDER BY id DESC LIMIT 500').all(FUSO, dia)
    : db.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 100').all();
  json(res, 200, listaDePedidos(lista, true));
});

// Categorias
rota('GET', /^\/api\/admin\/categorias$/, async (req, res) => {
  exigirAdmin(req);
  json(res, 200, db.prepare(`SELECT c.id, c.nome, c.ordem, COUNT(p.id) AS produtos FROM categorias c
    LEFT JOIN produtos p ON p.categoria_id = c.id AND p.arquivado = 0 GROUP BY c.id ORDER BY c.ordem, c.id`).all());
});
rota('POST', /^\/api\/admin\/categorias$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req);
  const nome = texto(b.nome, 40);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome da categoria muito curto.');
  if (db.prepare('SELECT 1 FROM categorias WHERE nome = ?').get(nome)) throw new ErroHttp(400, 'Já existe uma categoria com esse nome.');
  registrar(req, eu.usuario, 'criou categoria', nome);
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 AS o FROM categorias').get().o;
  const id = db.prepare('INSERT INTO categorias (nome, ordem) VALUES (?, ?)').run(nome, ordem).lastInsertRowid;
  json(res, 201, { id: Number(id) });
});
rota('PUT', /^\/api\/admin\/categorias\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req);
  const nome = texto(b.nome, 40);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome da categoria muito curto.');
  if (db.prepare('SELECT 1 FROM categorias WHERE nome = ? AND id <> ?').get(nome, Number(m[1]))) throw new ErroHttp(400, 'Já existe uma categoria com esse nome.');
  registrar(req, eu.usuario, 'renomeou categoria', nome);
  const r = db.prepare('UPDATE categorias SET nome = ?, ordem = COALESCE(?, ordem) WHERE id = ?')
    .run(nome, Number.isInteger(b.ordem) ? b.ordem : null, Number(m[1]));
  if (!r.changes) throw new ErroHttp(404, 'Categoria não encontrada.');
  json(res, 200, { ok: true });
});
rota('POST', /^\/api\/admin\/categorias\/ordem$/, async (req, res) => {
  exigirAdmin(req);
  const b = await lerCorpo(req);
  if (!Array.isArray(b.ids)) throw new ErroHttp(400, 'Lista inválida.');
  const up = db.prepare('UPDATE categorias SET ordem = ? WHERE id = ?');
  b.ids.slice(0, 200).forEach((id, i) => up.run(i, Number(id)));
  json(res, 200, { ok: true });
});
rota('DELETE', /^\/api\/admin\/categorias\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const id = Number(m[1]);
  if (db.prepare('SELECT 1 FROM produtos WHERE categoria_id = ? AND arquivado = 0').get(id)) throw new ErroHttp(400, 'Mova ou exclua os produtos desta categoria antes.');
  if (db.prepare('SELECT 1 FROM produtos WHERE categoria_id = ?').get(id)) {
    throw new ErroHttp(400, 'Esta categoria tem produtos com histórico de vendas. Renomeie-a em vez de excluir.');
  }
  const cat = db.prepare('SELECT nome FROM categorias WHERE id = ?').get(id);
  db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
  if (cat) registrar(req, eu.usuario, 'excluiu categoria', cat.nome);
  json(res, 200, { ok: true });
});

// Produtos
function lerProduto(b) {
  const nome = texto(b.nome, 60);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome do produto muito curto.');
  const categoria = db.prepare('SELECT id FROM categorias WHERE id = ?').get(Number(b.categoria_id));
  if (!categoria) throw new ErroHttp(400, 'Escolha uma categoria.');
  return {
    categoria_id: categoria.id, nome, descricao: texto(b.descricao, 200),
    preco_centavos: centavos(b.preco_centavos, { min: 1 }),
    emoji: texto(b.emoji, 8) || '🍧',
    disponivel: bool(b.disponivel ?? true) ? 1 : 0,
    permite_adicionais: bool(b.permite_adicionais) ? 1 : 0,
    destaque: bool(b.destaque) ? 1 : 0,
  };
}
rota('GET', /^\/api\/admin\/produtos$/, async (req, res) => {
  exigirAdmin(req);
  json(res, 200, db.prepare(`SELECT id, categoria_id, nome, descricao, preco_centavos, emoji, imagem, disponivel, permite_adicionais, destaque, ordem
    FROM produtos WHERE arquivado = 0 ORDER BY ordem, id`).all());
});
rota('POST', /^\/api\/admin\/produtos$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const p = lerProduto(await lerCorpo(req));
  registrar(req, eu.usuario, 'criou produto', `${p.nome} por ${dinheiroTxt(p.preco_centavos)}`);
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 AS o FROM produtos WHERE categoria_id = ?').get(p.categoria_id).o;
  const id = db.prepare(`INSERT INTO produtos (categoria_id, nome, descricao, preco_centavos, emoji, disponivel, permite_adicionais, destaque, ordem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.categoria_id, p.nome, p.descricao, p.preco_centavos, p.emoji, p.disponivel, p.permite_adicionais, p.destaque, ordem).lastInsertRowid;
  json(res, 201, { id: Number(id) });
});
rota('PUT', /^\/api\/admin\/produtos\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const p = lerProduto(await lerCorpo(req));
  const antes = db.prepare('SELECT nome, preco_centavos, disponivel FROM produtos WHERE id = ? AND arquivado = 0').get(Number(m[1]));
  const r = db.prepare(`UPDATE produtos SET categoria_id = ?, nome = ?, descricao = ?, preco_centavos = ?, emoji = ?, disponivel = ?, permite_adicionais = ?, destaque = ?
    WHERE id = ? AND arquivado = 0`).run(p.categoria_id, p.nome, p.descricao, p.preco_centavos, p.emoji, p.disponivel, p.permite_adicionais, p.destaque, Number(m[1]));
  if (!r.changes) throw new ErroHttp(404, 'Produto não encontrado.');
  const mudancas = [];
  if (antes.preco_centavos !== p.preco_centavos) mudancas.push(`preço ${dinheiroTxt(antes.preco_centavos)} → ${dinheiroTxt(p.preco_centavos)}`);
  if (antes.nome !== p.nome) mudancas.push(`nome "${antes.nome}" → "${p.nome}"`);
  if (antes.disponivel !== p.disponivel) mudancas.push(p.disponivel ? 'voltou ao cardápio' : 'tirado do cardápio');
  registrar(req, eu.usuario, 'editou produto', `${p.nome}${mudancas.length ? ': ' + mudancas.join('; ') : ''}`);
  json(res, 200, { ok: true });
});
rota('POST', /^\/api\/admin\/produtos\/ordem$/, async (req, res) => {
  exigirAdmin(req);
  const b = await lerCorpo(req);
  if (!Array.isArray(b.ids)) throw new ErroHttp(400, 'Lista inválida.');
  const up = db.prepare('UPDATE produtos SET ordem = ? WHERE id = ?');
  b.ids.slice(0, 500).forEach((id, i) => up.run(i, Number(id)));
  json(res, 200, { ok: true });
});
rota('DELETE', /^\/api\/admin\/produtos\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const id = Number(m[1]);
  const p = db.prepare('SELECT nome, imagem FROM produtos WHERE id = ?').get(id);
  if (!p) throw new ErroHttp(404, 'Produto não encontrado.');
  registrar(req, eu.usuario, 'excluiu produto', p.nome);
  // Produtos que já foram vendidos são arquivados para não quebrar o histórico de pedidos.
  if (db.prepare('SELECT 1 FROM itens_pedido WHERE produto_id = ?').get(id)) {
    db.prepare('UPDATE produtos SET arquivado = 1, disponivel = 0 WHERE id = ?').run(id);
  } else {
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
    apagarImagem(p.imagem);
  }
  json(res, 200, { ok: true });
});
rota('POST', /^\/api\/admin\/produtos\/(\d+)\/imagem$/, async (req, res, m) => {
  exigirAdmin(req);
  const b = await lerCorpo(req, LIMITE_IMAGEM);
  const p = db.prepare('SELECT imagem FROM produtos WHERE id = ?').get(Number(m[1]));
  if (!p) throw new ErroHttp(404, 'Produto não encontrado.');
  const nova = b.imagem ? salvarImagem(b.imagem) : '';
  db.prepare('UPDATE produtos SET imagem = ? WHERE id = ?').run(nova, Number(m[1]));
  apagarImagem(p.imagem);
  json(res, 200, { imagem: nova });
});

// Adicionais
rota('GET', /^\/api\/admin\/adicionais$/, async (req, res) => {
  exigirAdmin(req);
  json(res, 200, db.prepare('SELECT id, nome, preco_centavos, disponivel, ordem FROM adicionais ORDER BY ordem, id').all());
});
function lerAdicional(b) {
  const nome = texto(b.nome, 40);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome do adicional muito curto.');
  return { nome, preco_centavos: centavos(b.preco_centavos ?? 0), disponivel: bool(b.disponivel ?? true) ? 1 : 0 };
}
rota('POST', /^\/api\/admin\/adicionais$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const a = lerAdicional(await lerCorpo(req));
  registrar(req, eu.usuario, 'criou adicional', `${a.nome} por ${dinheiroTxt(a.preco_centavos)}`);
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 AS o FROM adicionais').get().o;
  const id = db.prepare('INSERT INTO adicionais (nome, preco_centavos, disponivel, ordem) VALUES (?, ?, ?, ?)').run(a.nome, a.preco_centavos, a.disponivel, ordem).lastInsertRowid;
  json(res, 201, { id: Number(id) });
});
rota('PUT', /^\/api\/admin\/adicionais\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const a = lerAdicional(await lerCorpo(req));
  const antes = db.prepare('SELECT preco_centavos FROM adicionais WHERE id = ?').get(Number(m[1]));
  if (antes && antes.preco_centavos !== a.preco_centavos) {
    registrar(req, eu.usuario, 'mudou preço de adicional', `${a.nome}: ${dinheiroTxt(antes.preco_centavos)} → ${dinheiroTxt(a.preco_centavos)}`);
  }
  const r = db.prepare('UPDATE adicionais SET nome = ?, preco_centavos = ?, disponivel = ? WHERE id = ?').run(a.nome, a.preco_centavos, a.disponivel, Number(m[1]));
  if (!r.changes) throw new ErroHttp(404, 'Adicional não encontrado.');
  json(res, 200, { ok: true });
});
rota('DELETE', /^\/api\/admin\/adicionais\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const a = db.prepare('SELECT nome FROM adicionais WHERE id = ?').get(Number(m[1]));
  db.prepare('DELETE FROM adicionais WHERE id = ?').run(Number(m[1]));
  if (a) registrar(req, eu.usuario, 'excluiu adicional', a.nome);
  json(res, 200, { ok: true });
});

// Configurações da loja
rota('GET', /^\/api\/admin\/config$/, async (req, res) => {
  exigirAdmin(req);
  json(res, 200, { ...lerConfig(), modo_simulado: pag.modoSimulado });
});
rota('PUT', /^\/api\/admin\/config$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req);
  const nome = texto(b.nome_loja, 40);
  registrar(req, eu.usuario, 'alterou informações da loja');
  if (nome.length < 2) throw new ErroHttp(400, 'Nome da loja muito curto.');
  salvarConfig('nome_loja', nome);
  salvarConfig('slogan', texto(b.slogan, 80));
  salvarConfig('aviso', texto(b.aviso, 160));
  salvarConfig('whatsapp', texto(b.whatsapp, 20).replace(/\D/g, ''));
  salvarConfig('loja_aberta', bool(b.loja_aberta));
  salvarConfig('permitir_balcao', bool(b.permitir_balcao));
  json(res, 200, lerConfig());
});
rota('PATCH', /^\/api\/admin\/loja-aberta$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req);
  salvarConfig('loja_aberta', bool(b.loja_aberta));
  registrar(req, eu.usuario, bool(b.loja_aberta) ? 'abriu a loja' : 'fechou a loja');
  json(res, 200, lerConfig());
});
rota('POST', /^\/api\/admin\/logo$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req, LIMITE_IMAGEM);
  const antiga = lerConfig().logo;
  registrar(req, eu.usuario, 'trocou a logo');
  const nova = b.imagem ? salvarImagem(b.imagem) : '/logo-horizontal.jpg';
  salvarConfig('logo', nova);
  apagarImagem(antiga);
  json(res, 200, { logo: nova });
});

// Usuários
rota('GET', /^\/api\/admin\/usuarios$/, async (req, res) => {
  const eu = exigirAdmin(req);
  json(res, 200, db.prepare('SELECT id, usuario, papel FROM usuarios ORDER BY papel, usuario').all().map((u) => ({ ...u, sou_eu: u.id === eu.id })));
});
rota('POST', /^\/api\/admin\/usuarios$/, async (req, res) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req);
  const usuario = texto(b.usuario, 40).toLowerCase();
  const papel = b.papel === 'admin' ? 'admin' : 'cozinha';
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new ErroHttp(400, 'Usuário: 3 a 40 letras, números, ponto, hífen ou _.');
  if (String(b.senha || '').length < 8) throw new ErroHttp(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario)) throw new ErroHttp(400, 'Esse usuário já existe.');
  db.prepare('INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (?, ?, ?)').run(usuario, auth.hashSenha(String(b.senha)), papel);
  registrar(req, eu.usuario, 'criou usuário', `${usuario} (${papel})`);
  json(res, 201, { ok: true });
});
rota('PUT', /^\/api\/admin\/usuarios\/(\d+)\/senha$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const b = await lerCorpo(req);
  if (String(b.senha || '').length < 8) throw new ErroHttp(400, 'A senha precisa ter pelo menos 8 caracteres.');
  const alvo = db.prepare('SELECT usuario FROM usuarios WHERE id = ?').get(Number(m[1]));
  if (alvo) registrar(req, eu.usuario, 'trocou senha', alvo.usuario);
  const r = db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(auth.hashSenha(String(b.senha)), Number(m[1]));
  if (!r.changes) throw new ErroHttp(404, 'Usuário não encontrado.');
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(Number(m[1])); // desconecta quem estava logado com a senha antiga
  json(res, 200, { ok: true });
});
rota('DELETE', /^\/api\/admin\/usuarios\/(\d+)$/, async (req, res, m) => {
  const eu = exigirAdmin(req);
  const id = Number(m[1]);
  if (id === eu.id) throw new ErroHttp(400, 'Você não pode excluir a si mesmo.');
  const alvo = db.prepare('SELECT usuario FROM usuarios WHERE id = ?').get(id);
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
  if (alvo) registrar(req, eu.usuario, 'excluiu usuário', alvo.usuario);
  json(res, 200, { ok: true });
});

rota('GET', /^\/api\/admin\/atividade$/, async (req, res) => {
  exigirAdmin(req);
  json(res, 200, db.prepare('SELECT quando, usuario, acao, detalhe, ip FROM auditoria ORDER BY id DESC LIMIT 200').all());
});

// ======================= arquivos estáticos =======================
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const PAGINAS = { '/': '/index.html', '/cozinha': '/cozinha.html', '/admin': '/admin.html', '/pedido': '/pedido.html' };
function servirEstatico(req, res, url) {
  let caminho;
  try { caminho = decodeURIComponent(url.pathname); } catch { return json(res, 400, { erro: 'Endereço inválido' }); }
  caminho = PAGINAS[caminho] || caminho;
  let base = PASTA_PUBLICA;
  if (caminho.startsWith('/uploads/')) { base = PASTA_UPLOADS; caminho = caminho.slice('/uploads'.length); }
  const arquivo = path.normalize(path.join(base, caminho));
  const tipo = TIPOS[path.extname(arquivo).toLowerCase()];
  if (!arquivo.startsWith(base + path.sep) || !tipo) {
    res.writeHead(404, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada');
  }
  fs.stat(arquivo, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada'); }
    // ETag: o celular só baixa de novo quando o arquivo mudou (responde 304 em vez do arquivo inteiro).
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const cache = base === PASTA_UPLOADS ? 'public, max-age=31536000, immutable' : 'no-cache';
    const cab = { ...CABECALHOS_SEGURANCA, 'Content-Type': tipo, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, cab); return res.end(); }
    lerComCompressao(arquivo, etag, tipo, (erro, conteudo) => {
      if (erro) { res.writeHead(500, cab); return res.end(); }
      const gzip = conteudo.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const corpo = gzip ? conteudo.gz : conteudo.bruto;
      res.writeHead(200, { ...cab, 'Content-Length': corpo.length, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(req.method === 'HEAD' ? undefined : corpo);
    });
  });
}

// Guarda na memória os arquivos de texto (HTML, CSS, JS) já comprimidos com gzip.
// Imagens não são comprimidas de novo (JPG/PNG/WEBP já são comprimidos).
const cacheEstatico = new Map();
function lerComCompressao(arquivo, etag, tipo, cb) {
  const c = cacheEstatico.get(arquivo);
  if (c && c.etag === etag) return cb(null, c);
  fs.readFile(arquivo, (err, bruto) => {
    if (err) return cb(err);
    const ehTexto = /^(text\/|application\/(json|manifest))/.test(tipo);
    const item = { etag, bruto, gz: ehTexto && bruto.length > 1024 ? zlib.gzipSync(bruto, { level: 9 }) : null };
    if (ehTexto) cacheEstatico.set(arquivo, item);
    cb(null, item);
  });
}

// ======================= servidor =======================
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of rotas) {
        if (r.metodo !== req.method) continue;
        const m = url.pathname.match(r.padrao);
        if (m) return await r.fn(req, res, m, url);
      }
      throw new ErroHttp(404, 'Rota não encontrada');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ErroHttp(405, 'Método não permitido');
    servirEstatico(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { erro: status === 500 ? 'Erro interno. Tente novamente.' : e.message });
  }
});

// Desligamento limpo (o Fly.io envia SIGINT/SIGTERM ao reiniciar ou publicar uma nova versão):
// para de aceitar conexões, fecha a cozinha ao vivo e grava o banco antes de sair.
function desligar(sinal) {
  console.log(`[${sinal}] desligando…`);
  for (const r of ouvintesCozinha) r.end();
  servidor.close(() => {
    try { db.close(); } catch { /* já fechado */ }
    process.exit(0);
  });
  servidor.closeIdleConnections();
  setTimeout(() => process.exit(0), 8000).unref();
}
if (require.main === module) {
  process.once('SIGINT', () => desligar('SIGINT'));
  process.once('SIGTERM', () => desligar('SIGTERM'));
}

servidor.listen(PORTA, () => {
  const nome = lerConfig().nome_loja;
  console.log(`\n💜 ${nome} rodando em http://localhost:${PORTA}`);
  console.log(`   Cardápio:  http://localhost:${PORTA}/`);
  console.log(`   Cozinha:   http://localhost:${PORTA}/cozinha`);
  console.log(`   Admin:     http://localhost:${PORTA}/admin`);
  console.log(`   Pagamentos: ${pag.modoSimulado ? 'MODO SIMULADO (configure MP_ACCESS_TOKEN no .env para cobrar de verdade)' : 'Mercado Pago ATIVO'}\n`);
});

module.exports = { servidor };
