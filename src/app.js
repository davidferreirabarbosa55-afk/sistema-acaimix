// API da Açaí Mix. Roda como função da Vercel (api/index.js) ou no servidor local (src/local.js).
// Todo dado fica no Supabase; aqui não há estado guardado entre requisições.
'use strict';

require('./env').carregar();

const crypto = require('node:crypto');
const { rpc, enviarFoto, apagarFoto, problemasDeConfiguracao, ErroHttp } = require('./supabase');
const auth = require('./auth');
const pag = require('./pagamentos');

const PRODUCAO = process.env.NODE_ENV === 'production';
const FUSO = Number(process.env.FUSO_HORARIO || -3);
const LIMITE_CORPO = 32 * 1024;
const LIMITE_IMAGEM = 3 * 1024 * 1024;

// ======================= utilidades HTTP =======================
const CABECALHOS_SEGURANCA = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function json(res, status, dados, extras = {}) {
  res.writeHead(status, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extras });
  res.end(JSON.stringify(dados));
}

function lerCorpo(req, limite = LIMITE_CORPO) {
  // Na Vercel, req.body é interpretado na hora do acesso e LANÇA erro se o JSON for inválido.
  // Por isso o acesso fica dentro do try: assim a função sempre devolve uma promessa (nunca lança direto).
  let corpoPronto;
  try { corpoPronto = req.body; } catch { return Promise.reject(new ErroHttp(400, 'JSON inválido')); }
  if (corpoPronto !== undefined && req.readableEnded) {
    if (Buffer.isBuffer(req.body)) req.body = req.body.toString('utf8');
    if (typeof req.body === 'string') {
      if (req.body.length > limite) return Promise.reject(new ErroHttp(413, 'Arquivo ou requisição muito grande'));
      try { return Promise.resolve(req.body ? JSON.parse(req.body) : {}); } catch { return Promise.reject(new ErroHttp(400, 'JSON inválido')); }
    }
    return Promise.resolve(req.body && typeof req.body === 'object' ? req.body : {});
  }
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
  // Na Vercel, o IP real do visitante vem em x-real-ip (a Vercel sobrescreve; o visitante não forja).
  if (process.env.VERCEL) {
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) return ip;
  }
  if (process.env.CONFIAR_PROXY === 'true') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // o último é o que o proxy adicionou
  }
  return req.socket?.remoteAddress || '?';
}

// Limite de tentativas por IP, guardado no banco (funciona com várias cópias da função na Vercel).
// O Wi-Fi da loja coloca muitos clientes atrás do mesmo IP, por isso os limites públicos são folgados.
const LIMITES = {
  login:    { max: 10,  janela: 15 * 60, msg: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  pedido:   { max: 20,  janela: 60 },
  consulta: { max: 600, janela: 60 },
  webhook:  { max: 300, janela: 60 },
};
async function limitar(req, chave) {
  const { max, janela, msg } = LIMITES[chave];
  const ok = await rpc('api_limitar', { chave: `${chave}:${ipDe(req)}`, max, janela_seg: janela });
  if (!ok) throw new ErroHttp(429, msg || 'Muitas tentativas. Aguarde um minuto.');
}

// Proteção CSRF: só aceita mudanças vindas do próprio site (segunda camada; o cookie SameSite=Strict é a primeira).
function exigirMesmaOrigem(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new ErroHttp(403, 'Origem não permitida');
  const origem = req.headers.origin;
  if (!origem) return;
  const host = req.headers['x-forwarded-host'] && (process.env.VERCEL || process.env.CONFIAR_PROXY === 'true')
    ? req.headers['x-forwarded-host'] : req.headers.host;
  try {
    if (new URL(origem).host !== host) throw new Error();
  } catch { throw new ErroHttp(403, 'Origem não permitida'); }
}

async function exigirLogin(req, papeis) {
  if (req.method !== 'GET') exigirMesmaOrigem(req);
  const u = await auth.usuarioDaSessao(req);
  if (!u) throw new ErroHttp(401, 'Faça login');
  if (!papeis.includes(u.papel)) throw new ErroHttp(403, 'Sem permissão para esta área.');
  return u;
}
const exigirCozinha = (req) => exigirLogin(req, ['cozinha', 'admin']);
const exigirAdmin = (req) => exigirLogin(req, ['admin']);
const quem = (req, u) => ({ usuario: u.usuario, ip: ipDe(req) });

const texto = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const bool = (v) => v === true || v === 1 || v === 'true' || v === '1';
const id = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new ErroHttp(400, 'Identificador inválido.'); return n; };

function centavos(v, { min = 0, max = 10_000_000 } = {}) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new ErroHttp(400, 'Preço inválido.');
  const c = Math.round(n);
  if (c < min || c > max) throw new ErroHttp(400, 'Preço fora do permitido.');
  return c;
}

// ======================= usuários iniciais =======================
// Na primeira vez, cria o admin e a cozinha com as senhas das variáveis ADMIN_SENHA e COZINHA_SENHA.
let usuariosIniciais = null;
function garantirUsuariosIniciais() {
  usuariosIniciais ||= (async () => {
    const tem = await rpc('api_tem_usuarios');
    for (const [papel, usuario, senha] of [
      ['admin', process.env.ADMIN_USUARIO || 'admin', process.env.ADMIN_SENHA],
      ['cozinha', process.env.COZINHA_USUARIO || 'cozinha', process.env.COZINHA_SENHA],
    ]) {
      if (tem[papel] || !senha || senha.length < 8) continue;
      await rpc('api_usuario_inicial', { papel, usuario, senha_hash: await auth.hashSenha(senha) });
    }
  })().catch((e) => { usuariosIniciais = null; throw e; });
  return usuariosIniciais;
}

// ======================= imagens enviadas pelo admin =======================
// Aceita só JPG, PNG e WEBP, conferindo os bytes do arquivo (não o nome nem o tipo informado).
async function salvarImagem(dataUrl, pasta) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new ErroHttp(400, 'Envie uma imagem JPG, PNG ou WEBP.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) throw new ErroHttp(413, 'Imagem maior que 2 MB. Diminua e tente de novo.');
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) throw new ErroHttp(400, 'Arquivo de imagem inválido.');
  const tipo = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext];
  return enviarFoto(`${pasta}/${crypto.randomBytes(12).toString('hex')}.${ext}`, buf, tipo);
}

// ======================= pagamentos =======================
async function aplicarPagamento(info) {
  const r = await rpc('api_aplicar_pagamento', {
    id: info.id, pedido_id: info.pedidoId, status: info.status, valor_centavos: info.valorCentavos, metodo: info.metodo,
  });
  if (r.resultado === 'liberado') console.log(`[pagamento] Pedido ${r.codigo} pago e enviado para a cozinha.`);
  if (r.resultado?.startsWith('alerta')) console.error(`[ALERTA] Pedido ${r.codigo}: ${r.resultado}. Veja o Resumo do admin.`);
}

// Se o webhook não chegar, a página do cliente faz o servidor conferir na API do Mercado Pago.
async function conferirPagamentoPendente(pedido, paymentIdDaUrl) {
  if (pag.modoSimulado || pedido.status !== 'aguardando_pagamento') return false;
  // No máximo uma conferência a cada 10 segundos por pedido (a página consulta a cada 4 s).
  if (!(await rpc('api_limitar', { chave: `conferir:${pedido.id}`, max: 1, janela_seg: 10 }))) return false;
  const ids = new Set(pedido.ids_pagamento || []);
  if (paymentIdDaUrl && /^\d{1,20}$/.test(paymentIdDaUrl)) ids.add(paymentIdDaUrl);
  let mudou = false;
  for (const idMP of ids) {
    try {
      const info = await pag.consultarPagamento(idMP);
      if (info.pedidoId === pedido.id) { await aplicarPagamento(info); mudou = true; } // ignora ids de outros pedidos
    } catch (e) { console.error('[pagamento] Falha ao conferir', idMP, e.message); }
  }
  return mudou;
}

// ======================= rotas =======================
const rotas = [];
const rota = (metodo, padrao, fn) => rotas.push({ metodo, padrao, fn });
const CACHE_CURTO = { 'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30' };

// ---------------- Público ----------------
// Diagnóstico: diz o que falta configurar, sem revelar nenhum valor secreto.
rota('GET', /^\/api\/saude$/, async (req, res) => {
  const problemas = problemasDeConfiguracao();
  let banco = 'não testado (corrija as variáveis primeiro)';
  if (!problemas.length) {
    try { await rpc('api_config'); banco = 'ok'; }
    catch (e) { banco = 'com problema'; problemas.push(e.motivo || e.message); }
  }
  json(res, problemas.length ? 503 : 200, {
    ok: !problemas.length, banco, problemas,
    node: process.version, pagamentos: pag.modoSimulado ? 'modo de teste (simulado)' : 'Mercado Pago ativo',
    cron: process.env.CRON_SECRET ? 'configurado' : 'falta CRON_SECRET (a limpeza diária não vai rodar)',
  });
});

rota('GET', /^\/api\/config$/, async (req, res) => {
  json(res, 200, { ...(await rpc('api_config')), modo_simulado: pag.modoSimulado }, CACHE_CURTO);
});

rota('GET', /^\/api\/cardapio$/, async (req, res) => {
  json(res, 200, await rpc('api_cardapio'), CACHE_CURTO);
});

rota('POST', /^\/api\/pedidos$/, async (req, res) => {
  await limitar(req, 'pedido');
  const b = await lerCorpo(req);

  // Validação do formato aqui; regras que dependem do banco (preços, disponibilidade, loja aberta) ficam no banco.
  const nome = texto(b.cliente?.nome, 60);
  const email = texto(b.cliente?.email, 120).toLowerCase();
  const tipo = b.tipo === 'mesa' ? 'mesa' : 'retirada';
  const mesa = tipo === 'mesa' ? texto(b.mesa, 10) : '';
  const forma = ['pix', 'cartao', 'balcao'].includes(b.forma_pagamento) ? b.forma_pagamento : null;
  if (nome.length < 2) throw new ErroHttp(400, 'Informe seu nome.');
  if (tipo === 'mesa' && !mesa) throw new ErroHttp(400, 'Informe o número da mesa.');
  if (!forma) throw new ErroHttp(400, 'Escolha a forma de pagamento.');
  if (forma === 'pix' && !pag.modoSimulado && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ErroHttp(400, 'Para pagar com Pix, informe um e-mail válido.');
  }
  if (!Array.isArray(b.itens)) throw new ErroHttp(400, 'Sacola vazia ou inválida.');

  const token = crypto.randomBytes(24).toString('base64url');
  const criado = await rpc('api_criar_pedido', {
    token, nome, tipo, mesa, forma_pagamento: forma, email,
    telefone: texto(b.cliente?.telefone, 20).replace(/[^\d+() -]/g, ''),
    observacao: texto(b.observacao, 200),
    itens: b.itens.slice(0, 31).map((i) => ({
      produto_id: i?.produto_id, quantidade: i?.quantidade, observacao: texto(i?.observacao, 140),
      adicionais: Array.isArray(i?.adicionais) ? i.adicionais.slice(0, 30) : [],
    })),
  });

  let cliente = criado.cliente;
  if (forma !== 'balcao') {
    const pedido = { id: criado.id, codigo: criado.codigo, token, total_centavos: criado.total_centavos, cliente_nome: nome, cliente_email: email };
    try {
      const itensPagamento = criado.itens.map((i) => ({ ...i, nome: i.adicionais ? `${i.nome} (${i.adicionais})`.slice(0, 250) : i.nome }));
      const r = forma === 'pix' ? await pag.criarPix(pedido) : await pag.criarCheckoutCartao(pedido, itensPagamento);
      cliente = (await rpc('api_registrar_pagamento', { pedido_id: criado.id, valor_centavos: criado.total_centavos, ...r })).cliente;
    } catch (e) {
      console.error('[pagamento] Erro ao criar cobrança:', e.message);
      await rpc('api_cancelar_pedido_sistema', { pedido_id: criado.id }).catch(() => {});
      throw new ErroHttp(502, 'Não foi possível gerar o pagamento agora. Tente novamente.');
    }
  }
  json(res, 201, { token, pedido: { ...cliente, modo_simulado: pag.modoSimulado } });
});

rota('GET', /^\/api\/pedidos\/([A-Za-z0-9_-]{20,64})$/, async (req, res, m, url) => {
  await limitar(req, 'consulta');
  let p = await rpc('api_pedido_cliente', { token: m[1] });
  if (await conferirPagamentoPendente(p, url.searchParams.get('payment_id'))) p = await rpc('api_pedido_cliente', { token: m[1] });
  const { id: _id, ids_pagamento: _ids, ...publico } = p;
  json(res, 200, { ...publico, modo_simulado: pag.modoSimulado });
});

// Só no MODO SIMULADO: botão para fingir que o pagamento foi aprovado.
rota('POST', /^\/api\/pedidos\/([A-Za-z0-9_-]{20,64})\/simular-pagamento$/, async (req, res, m) => {
  if (!pag.modoSimulado) throw new ErroHttp(404, 'Não encontrado');
  json(res, 200, { ...(await rpc('api_simular_pagamento', { token: m[1] })), modo_simulado: true });
});

// Webhook do Mercado Pago: assinatura conferida e pagamento CONSULTADO na API antes de liberar.
rota('POST', /^\/api\/webhooks\/mercadopago$/, async (req, res, m, url) => {
  await limitar(req, 'webhook');
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
    await aplicarPagamento(await pag.consultarPagamento(String(dataId)));
  } catch (e) {
    console.error('[webhook] Erro ao consultar pagamento', dataId, e.message);
    return json(res, 500, { erro: 'tente novamente' }); // o Mercado Pago reenvia depois
  }
  json(res, 200, { ok: true });
});

// Manutenção diária (cron da Vercel): LGPD, pedidos não pagos, sessões vencidas.
rota('GET', /^\/api\/cron\/manutencao$/, async (req, res) => {
  const segredo = process.env.CRON_SECRET || '';
  const recebido = String(req.headers.authorization || '');
  const esperado = `Bearer ${segredo}`;
  if (!segredo || recebido.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
    throw new ErroHttp(401, 'Não autorizado');
  }
  const r = await rpc('api_manutencao', { retencao_dias: Number(process.env.RETENCAO_DIAS || 180) });
  console.log(`[manutenção] ${r.anonimizados} pedido(s) anonimizados, ${r.cancelados} não pago(s) cancelado(s).`);
  json(res, 200, r);
});

// ---------------- Login (cozinha e admin) ----------------
rota('POST', /^\/api\/(?:cozinha\/)?login$/, async (req, res) => {
  exigirMesmaOrigem(req);
  await limitar(req, 'login');
  await garantirUsuariosIniciais();
  const b = await lerCorpo(req);
  const usuario = texto(b.usuario, 40);
  const u = await rpc('api_usuario_para_login', { usuario });
  const ok = u ? await auth.conferirSenha(String(b.senha || ''), u.senha_hash) : await auth.conferirFalso();
  if (!ok) {
    await rpc('api_registrar', { usuario, acao: 'login recusado', detalhe: '', ip: ipDe(req) });
    throw new ErroHttp(401, 'Usuário ou senha incorretos.');
  }
  await rpc('api_registrar', { usuario: u.usuario, acao: 'login', detalhe: '', ip: ipDe(req) });
  const s = await auth.criarSessao(u.id);
  json(res, 200, { usuario: u.usuario, papel: u.papel }, {
    'Set-Cookie': `sessao=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${s.maxAge}${PRODUCAO ? '; Secure' : ''}`,
  });
});
rota('POST', /^\/api\/(?:cozinha\/)?logout$/, async (req, res) => {
  exigirMesmaOrigem(req);
  await auth.encerrarSessao(req);
  json(res, 200, { ok: true }, { 'Set-Cookie': `sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${PRODUCAO ? '; Secure' : ''}` });
});
rota('GET', /^\/api\/(?:cozinha\/)?me$/, async (req, res) => {
  const u = await auth.usuarioDaSessao(req);
  if (!u) throw new ErroHttp(401, 'Faça login');
  json(res, 200, { usuario: u.usuario, papel: u.papel });
});

// ---------------- Cozinha ----------------
rota('GET', /^\/api\/cozinha\/pedidos$/, async (req, res) => {
  await exigirCozinha(req);
  json(res, 200, await rpc('api_cozinha_pedidos'));
});
rota('PATCH', /^\/api\/cozinha\/pedidos\/(\d+)$/, async (req, res, m) => {
  const u = await exigirCozinha(req);
  const b = await lerCorpo(req);
  json(res, 200, await rpc('api_mudar_status', { id: id(m[1]), status: texto(b.status, 30), ...quem(req, u) }));
});
rota('GET', /^\/api\/cozinha\/produtos$/, async (req, res) => {
  await exigirCozinha(req);
  json(res, 200, await rpc('api_disponibilidade'));
});
rota('PATCH', /^\/api\/cozinha\/(produtos|adicionais)\/(\d+)$/, async (req, res, m) => {
  const u = await exigirCozinha(req);
  const b = await lerCorpo(req);
  json(res, 200, await rpc('api_definir_disponivel', { tipo: m[1], id: id(m[2]), disponivel: bool(b.disponivel), ...quem(req, u) }));
});

// ---------------- Administrador ----------------
rota('GET', /^\/api\/admin\/resumo$/, async (req, res) => {
  await exigirAdmin(req);
  json(res, 200, await rpc('api_resumo', { fuso: FUSO }));
});
rota('GET', /^\/api\/admin\/pedidos$/, async (req, res, m, url) => {
  await exigirAdmin(req);
  const dia = url.searchParams.get('dia');
  json(res, 200, await rpc('api_admin_pedidos', /^\d{4}-\d{2}-\d{2}$/.test(dia || '') ? { dia, fuso: FUSO } : {}));
});
rota('GET', /^\/api\/admin\/atividade$/, async (req, res) => {
  await exigirAdmin(req);
  json(res, 200, await rpc('api_atividade'));
});

// Categorias
rota('GET', /^\/api\/admin\/categorias$/, async (req, res) => { await exigirAdmin(req); json(res, 200, await rpc('api_categorias')); });
async function salvarCategoria(req, res, idCat) {
  const u = await exigirAdmin(req);
  const nome = texto((await lerCorpo(req)).nome, 40);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome da categoria muito curto.');
  json(res, idCat ? 200 : 201, await rpc('api_categoria_salvar', { id: idCat, nome, ...quem(req, u) }));
}
rota('POST', /^\/api\/admin\/categorias$/, (req, res) => salvarCategoria(req, res, null));
rota('PUT', /^\/api\/admin\/categorias\/(\d+)$/, (req, res, m) => salvarCategoria(req, res, id(m[1])));
rota('DELETE', /^\/api\/admin\/categorias\/(\d+)$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  json(res, 200, await rpc('api_categoria_excluir', { id: id(m[1]), ...quem(req, u) }));
});
rota('POST', /^\/api\/admin\/(categorias|produtos)\/ordem$/, async (req, res, m) => {
  await exigirAdmin(req);
  const b = await lerCorpo(req);
  if (!Array.isArray(b.ids)) throw new ErroHttp(400, 'Lista inválida.');
  json(res, 200, await rpc('api_ordenar', { tabela: m[1], ids: b.ids.slice(0, 500).map(id) }));
});

// Produtos
function lerProduto(b) {
  const nome = texto(b.nome, 60);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome do produto muito curto.');
  return {
    categoria_id: id(b.categoria_id), nome, descricao: texto(b.descricao, 200),
    preco_centavos: centavos(b.preco_centavos, { min: 1 }), emoji: texto(b.emoji, 8) || '🍧',
    disponivel: bool(b.disponivel ?? true), permite_adicionais: bool(b.permite_adicionais), destaque: bool(b.destaque),
  };
}
rota('GET', /^\/api\/admin\/produtos$/, async (req, res) => { await exigirAdmin(req); json(res, 200, await rpc('api_produtos')); });
rota('POST', /^\/api\/admin\/produtos$/, async (req, res) => {
  const u = await exigirAdmin(req);
  json(res, 201, await rpc('api_produto_salvar', { ...lerProduto(await lerCorpo(req)), ...quem(req, u) }));
});
rota('PUT', /^\/api\/admin\/produtos\/(\d+)$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  json(res, 200, await rpc('api_produto_salvar', { id: id(m[1]), ...lerProduto(await lerCorpo(req)), ...quem(req, u) }));
});
rota('DELETE', /^\/api\/admin\/produtos\/(\d+)$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  const r = await rpc('api_produto_excluir', { id: id(m[1]), ...quem(req, u) });
  await apagarFoto(r.imagem_apagar);
  json(res, 200, { ok: true });
});
rota('POST', /^\/api\/admin\/produtos\/(\d+)\/imagem$/, async (req, res, m) => {
  await exigirAdmin(req);
  const b = await lerCorpo(req, LIMITE_IMAGEM);
  const nova = b.imagem ? await salvarImagem(b.imagem, 'produtos') : '';
  let r;
  try { r = await rpc('api_produto_imagem', { id: id(m[1]), imagem: nova }); }
  catch (e) { await apagarFoto(nova); throw e; }
  await apagarFoto(r.antiga);
  json(res, 200, { imagem: nova });
});

// Adicionais
function lerAdicional(b) {
  const nome = texto(b.nome, 40);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome do adicional muito curto.');
  return { nome, preco_centavos: centavos(b.preco_centavos ?? 0), disponivel: bool(b.disponivel ?? true) };
}
rota('GET', /^\/api\/admin\/adicionais$/, async (req, res) => { await exigirAdmin(req); json(res, 200, await rpc('api_adicionais')); });
rota('POST', /^\/api\/admin\/adicionais$/, async (req, res) => {
  const u = await exigirAdmin(req);
  json(res, 201, await rpc('api_adicional_salvar', { ...lerAdicional(await lerCorpo(req)), ...quem(req, u) }));
});
rota('PUT', /^\/api\/admin\/adicionais\/(\d+)$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  json(res, 200, await rpc('api_adicional_salvar', { id: id(m[1]), ...lerAdicional(await lerCorpo(req)), ...quem(req, u) }));
});
rota('DELETE', /^\/api\/admin\/adicionais\/(\d+)$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  json(res, 200, await rpc('api_adicional_excluir', { id: id(m[1]), ...quem(req, u) }));
});

// Configurações da loja
rota('GET', /^\/api\/admin\/config$/, async (req, res) => {
  await exigirAdmin(req);
  json(res, 200, { ...(await rpc('api_config')), modo_simulado: pag.modoSimulado });
});
rota('PUT', /^\/api\/admin\/config$/, async (req, res) => {
  const u = await exigirAdmin(req);
  const b = await lerCorpo(req);
  const nome = texto(b.nome_loja, 40);
  if (nome.length < 2) throw new ErroHttp(400, 'Nome da loja muito curto.');
  json(res, 200, await rpc('api_config_salvar', {
    nome_loja: nome, slogan: texto(b.slogan, 80), aviso: texto(b.aviso, 160),
    whatsapp: texto(b.whatsapp, 20).replace(/\D/g, ''),
    loja_aberta: String(bool(b.loja_aberta)), permitir_balcao: String(bool(b.permitir_balcao)),
    acao: 'alterou informações da loja', ...quem(req, u),
  }));
});
rota('PATCH', /^\/api\/admin\/loja-aberta$/, async (req, res) => {
  const u = await exigirAdmin(req);
  const aberta = bool((await lerCorpo(req)).loja_aberta);
  json(res, 200, await rpc('api_config_salvar', { loja_aberta: String(aberta), acao: aberta ? 'abriu a loja' : 'fechou a loja', ...quem(req, u) }));
});
rota('POST', /^\/api\/admin\/logo$/, async (req, res) => {
  const u = await exigirAdmin(req);
  const b = await lerCorpo(req, LIMITE_IMAGEM);
  const antiga = (await rpc('api_config')).logo;
  const nova = b.imagem ? await salvarImagem(b.imagem, 'logo') : '/logo-horizontal.jpg';
  await rpc('api_config_salvar', { logo: nova, acao: 'trocou a logo', ...quem(req, u) });
  await apagarFoto(antiga);
  json(res, 200, { logo: nova });
});

// Usuários
rota('GET', /^\/api\/admin\/usuarios$/, async (req, res) => {
  const u = await exigirAdmin(req);
  json(res, 200, await rpc('api_usuarios', { eu: u.id }));
});
rota('POST', /^\/api\/admin\/usuarios$/, async (req, res) => {
  const u = await exigirAdmin(req);
  const b = await lerCorpo(req);
  const usuario = texto(b.usuario, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new ErroHttp(400, 'Usuário: 3 a 40 letras, números, ponto, hífen ou _.');
  if (String(b.senha || '').length < 8) throw new ErroHttp(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (String(b.senha).length > 200) throw new ErroHttp(400, 'Senha longa demais.');
  json(res, 201, await rpc('api_usuario_criar', {
    usuario, papel: b.papel === 'admin' ? 'admin' : 'cozinha', senha_hash: await auth.hashSenha(b.senha), por: u.usuario, ip: ipDe(req),
  }));
});
rota('PUT', /^\/api\/admin\/usuarios\/(\d+)\/senha$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  const b = await lerCorpo(req);
  if (String(b.senha || '').length < 8) throw new ErroHttp(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (String(b.senha).length > 200) throw new ErroHttp(400, 'Senha longa demais.');
  json(res, 200, await rpc('api_usuario_senha', { id: id(m[1]), senha_hash: await auth.hashSenha(b.senha), por: u.usuario, ip: ipDe(req) }));
});
rota('DELETE', /^\/api\/admin\/usuarios\/(\d+)$/, async (req, res, m) => {
  const u = await exigirAdmin(req);
  json(res, 200, await rpc('api_usuario_excluir', { id: id(m[1]), eu: u.id, por: u.usuario, ip: ipDe(req) }));
});

// ======================= ponto de entrada =======================
// Na Vercel, o vercel.json manda /api/* para api/index.js; o caminho original fica em req.url.
async function tratar(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let caminho = url.pathname;
  if (url.searchParams.has('__rota')) caminho = '/api/' + url.searchParams.get('__rota');
  try {
    for (const r of rotas) {
      if (r.metodo !== req.method) continue;
      const m = caminho.match(r.padrao);
      if (m) return await r.fn(req, res, m, url);
    }
    throw new ErroHttp(404, 'Rota não encontrada');
  } catch (e) {
    // Este bloco NUNCA pode lançar erro: se lançasse, a Vercel derrubaria a função (FUNCTION_INVOCATION_FAILED).
    try {
      const status = Number.isInteger(e?.status) ? e.status : 500;
      if (status >= 500) console.error(`[erro] ${req.method} ${caminho}:`, e?.motivo || '', e);
      if (!res.headersSent) json(res, status, { erro: status === 500 ? 'Erro interno. Tente novamente.' : e.message });
      else res.end();
    } catch (e2) {
      console.error('[erro] falha ao responder:', e2);
      try { res.end(); } catch { /* conexão já fechada */ }
    }
  }
}

module.exports = { tratar, CABECALHOS_SEGURANCA };
