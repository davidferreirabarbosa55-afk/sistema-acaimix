// Testes da integração com o Mercado Pago, usando uma API falsa (nenhum dinheiro, nenhuma rede).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { subirServidor } = require('./ajuda');

const SEGREDO = 'segredo-do-webhook';
const pagamentosMP = new Map();
let enviadoMP = [];

// Substitui o fetch só para o domínio do Mercado Pago.
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, op = {}) => {
  if (!String(url).startsWith('https://api.mercadopago.com')) return fetchReal(url, op);
  const resp = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const corpo = op.body ? JSON.parse(op.body) : null;
  enviadoMP.push({ url: String(url), headers: op.headers, corpo });
  if (op.method === 'POST' && url.endsWith('/v1/payments')) {
    const id = String(5000 + pagamentosMP.size);
    pagamentosMP.set(id, { id: Number(id), status: 'pending', external_reference: corpo.external_reference, transaction_amount: corpo.transaction_amount, payment_type_id: 'bank_transfer' });
    return resp({ id: Number(id), status: 'pending', point_of_interaction: { transaction_data: { qr_code: '000201PIX', qr_code_base64: 'iVBORw0KGgo=' } } });
  }
  if (op.method === 'POST' && url.endsWith('/checkout/preferences')) return resp({ id: 'pref1', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref1' });
  const m = String(url).match(/\/v1\/payments\/(\d+)$/);
  if (m && pagamentosMP.has(m[1])) return resp(pagamentosMP.get(m[1]));
  return resp({ message: 'not found' }, 404);
};

let s;
before(async () => {
  s = await subirServidor({ MP_ACCESS_TOKEN: 'TEST-123', MP_WEBHOOK_SECRET: SEGREDO, URL_PUBLICA: 'https://acaimix.exemplo.com' });
});
after(async () => { await s.fechar(); globalThis.fetch = fetchReal; });

function assinatura(id, pedidoId = 'req-' + crypto.randomUUID(), ts = String(Date.now())) {
  const v1 = crypto.createHmac('sha256', SEGREDO).update(`id:${id};request-id:${pedidoId};ts:${ts};`).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': pedidoId };
}
const webhook = (id, cabecalhos) => s.chamar(`/api/webhooks/mercadopago?data.id=${id}&type=payment`, { metodo: 'POST', corpo: { type: 'payment', data: { id } }, cabecalhos });

async function novoPedidoPix(produtoNome = 'Açaí 300ml') {
  const { json } = await s.chamar('/api/cardapio');
  const prod = json.categorias.flatMap((c) => c.produtos).find((p) => p.nome === produtoNome);
  const r = await s.chamar('/api/pedidos', { metodo: 'POST', corpo: { cliente: { nome: 'Ana', email: 'ana@exemplo.com' }, forma_pagamento: 'pix', itens: [{ produto_id: prod.id, quantidade: 1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { token: r.json.token, pedido: r.json.pedido, idMP: [...pagamentosMP.keys()].pop() };
}
const statusDo = async (token) => (await s.chamar(`/api/pedidos/${token}`)).json.status;

test('Pix: gera QR code com valor certo, idempotência e URL de notificação', async () => {
  enviadoMP = [];
  const { pedido } = await novoPedidoPix();
  assert.equal(pedido.pagamento.pix_copia_cola, '000201PIX');
  const req = enviadoMP[0];
  assert.equal(req.corpo.transaction_amount, 12);
  assert.ok(req.headers['X-Idempotency-Key']);
  assert.equal(req.corpo.notification_url, 'https://acaimix.exemplo.com/api/webhooks/mercadopago');
  assert.ok(!('simular' in pedido) && pedido.modo_simulado === false);
});

test('Pix real exige e-mail do cliente', async () => {
  const { json } = await s.chamar('/api/cardapio');
  const r = await s.chamar('/api/pedidos', { metodo: 'POST', corpo: { cliente: { nome: 'Ana' }, forma_pagamento: 'pix', itens: [{ produto_id: json.categorias[0].produtos[0].id, quantidade: 1 }] } });
  assert.equal(r.status, 400);
});

test('webhook com assinatura falsa ou antiga é recusado', async () => {
  const { idMP } = await novoPedidoPix();
  assert.equal((await webhook(idMP, { 'x-signature': 'ts=1,v1=' + 'a'.repeat(64), 'x-request-id': 'x' })).status, 401);
  const antiga = String(Date.now() - 60 * 60 * 1000);
  assert.equal((await webhook(idMP, assinatura(idMP, 'req-1', antiga))).status, 401);
  assert.equal((await webhook(idMP, {})).status, 401);
});

test('webhook válido + pagamento aprovado libera o pedido para a cozinha', async () => {
  const { token, idMP } = await novoPedidoPix();
  pagamentosMP.get(idMP).status = 'approved';
  assert.equal((await webhook(idMP, assinatura(idMP))).status, 200);
  assert.equal(await statusDo(token), 'recebido');
});

test('webhook válido mas pagamento ainda pendente não libera', async () => {
  const { token, idMP } = await novoPedidoPix();
  assert.equal((await webhook(idMP, assinatura(idMP))).status, 200);
  assert.equal(await statusDo(token), 'aguardando_pagamento');
});

test('valor pago diferente do pedido é bloqueado e gera alerta', async () => {
  const { token, idMP } = await novoPedidoPix('Barca de Açaí');
  Object.assign(pagamentosMP.get(idMP), { status: 'approved', transaction_amount: 1 });
  await webhook(idMP, assinatura(idMP));
  assert.equal(await statusDo(token), 'aguardando_pagamento');
  const admin = await s.entrar('admin', 'admin-teste-123');
  const { json } = await s.chamar('/api/admin/resumo', { cookie: admin });
  assert.ok(json.alertas.some((a) => /valor pago diferente/.test(a.acao)));
});

test('cartão vai para o Checkout Pro com link que expira', async () => {
  enviadoMP = [];
  const { json } = await s.chamar('/api/cardapio');
  const r = await s.chamar('/api/pedidos', { metodo: 'POST', corpo: { cliente: { nome: 'Caio' }, forma_pagamento: 'cartao', itens: [{ produto_id: json.categorias[0].produtos[0].id, quantidade: 1 }] } });
  assert.match(r.json.pedido.pagamento.checkout_url, /^https:\/\/www\.mercadopago\.com\.br/);
  assert.equal(enviadoMP[0].corpo.expires, true);
  assert.ok(enviadoMP[0].corpo.back_urls.success.startsWith('https://acaimix.exemplo.com/pedido.html'));
});

test('payment_id de outro pedido na URL de retorno é ignorado', async () => {
  const a = await novoPedidoPix();
  pagamentosMP.get(a.idMP).status = 'approved';
  const b = await novoPedidoPix();
  const r = await s.chamar(`/api/pedidos/${b.token}?payment_id=${a.idMP}`);
  assert.equal(r.json.status, 'aguardando_pagamento');
});

test('botão de simular pagamento não existe com Mercado Pago ativo', async () => {
  const { token } = await novoPedidoPix();
  assert.equal((await s.chamar(`/api/pedidos/${token}/simular-pagamento`, { metodo: 'POST' })).status, 404);
});
