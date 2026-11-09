// Integração com o Mercado Pago.
//
// Regras de segurança aplicadas aqui:
//  1. O Access Token fica SÓ no servidor (variável de ambiente), nunca vai para o navegador.
//  2. Dados de cartão NUNCA passam pelo nosso servidor: cartão usa o Checkout Pro (página do Mercado Pago).
//  3. O webhook tem a assinatura (x-signature) conferida com HMAC-SHA256 e comparação em tempo constante.
//  4. Mesmo com assinatura válida, o status é sempre CONSULTADO na API do Mercado Pago
//     e o valor pago é comparado com o total do pedido antes de liberar para a cozinha.
//  5. Toda criação de pagamento usa X-Idempotency-Key para não cobrar duas vezes.
//
// Sem MP_ACCESS_TOKEN configurado, o sistema roda em MODO SIMULADO (para testes).
'use strict';

const crypto = require('node:crypto');

const API = 'https://api.mercadopago.com';
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const URL_PUBLICA = (process.env.URL_PUBLICA || '').replace(/\/$/, '');

const modoSimulado = !ACCESS_TOKEN;

async function chamarMP(metodo, caminho, corpo, idempotencia) {
  const headers = { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  if (idempotencia) headers['X-Idempotency-Key'] = idempotencia;
  const resp = await fetch(API + caminho, {
    method: metodo,
    headers,
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = dados.message || dados.error || `HTTP ${resp.status}`;
    throw new Error(`Mercado Pago: ${msg}`);
  }
  return dados;
}

const reais = (centavos) => Math.round(centavos) / 100;

// ---------- Pix: gera QR code e "copia e cola" ----------
async function criarPix(pedido) {
  if (modoSimulado) {
    return {
      provedor: 'simulado', metodo: 'pix', id_externo: 'sim-' + crypto.randomUUID(), status: 'pending',
      pix_copia_cola: `00020126SIMULADO-PEDIDO-${pedido.codigo}-NAO-PAGUE-ESTE-CODIGO`,
      pix_qr_base64: null, checkout_url: null,
    };
  }
  const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('Z', '-00:00');
  const dados = await chamarMP('POST', '/v1/payments', {
    transaction_amount: reais(pedido.total_centavos),
    description: `Pedido ${pedido.codigo}`,
    payment_method_id: 'pix',
    external_reference: String(pedido.id),
    date_of_expiration: expira,
    notification_url: URL_PUBLICA ? `${URL_PUBLICA}/api/webhooks/mercadopago` : undefined,
    payer: { email: pedido.cliente_email, first_name: pedido.cliente_nome.split(' ')[0] },
  }, `pedido-${pedido.id}-pix`);

  const t = dados.point_of_interaction?.transaction_data || {};
  return {
    provedor: 'mercadopago', metodo: 'pix', id_externo: String(dados.id), status: dados.status,
    pix_copia_cola: t.qr_code || null, pix_qr_base64: t.qr_code_base64 || null, checkout_url: t.ticket_url || null,
  };
}

// ---------- Cartão (e outros meios): Checkout Pro do Mercado Pago ----------
async function criarCheckoutCartao(pedido, itens) {
  if (modoSimulado) {
    return {
      provedor: 'simulado', metodo: 'cartao', id_externo: 'sim-' + crypto.randomUUID(), status: 'pending',
      pix_copia_cola: null, pix_qr_base64: null, checkout_url: null,
    };
  }
  const voltar = `${URL_PUBLICA}/pedido.html?t=${encodeURIComponent(pedido.token)}`;
  const agora = new Date();
  const dados = await chamarMP('POST', '/checkout/preferences', {
    items: itens.map((i) => ({
      id: String(i.produto_id), title: i.nome, quantity: i.quantidade,
      unit_price: reais(i.preco_centavos), currency_id: 'BRL',
    })),
    external_reference: String(pedido.id),
    notification_url: URL_PUBLICA ? `${URL_PUBLICA}/api/webhooks/mercadopago` : undefined,
    // O link de pagamento vence em 30 minutos (pedidos não pagos são cancelados depois de 2 horas).
    expires: true,
    expiration_date_from: agora.toISOString(),
    expiration_date_to: new Date(agora.getTime() + 30 * 60 * 1000).toISOString(),
    // Sem endereço público (rodando no computador local) não há para onde voltar.
    ...(URL_PUBLICA ? { back_urls: { success: voltar, pending: voltar, failure: voltar }, auto_return: 'approved' } : {}),
    statement_descriptor: (process.env.NOME_FATURA || 'ACAIMIX').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 13),
  }, `pedido-${pedido.id}-cartao`);

  return {
    provedor: 'mercadopago', metodo: 'cartao', id_externo: `pref-${dados.id}`, status: 'pending',
    pix_copia_cola: null, pix_qr_base64: null, checkout_url: dados.init_point,
  };
}

// ---------- Webhook: confere a assinatura x-signature ----------
// Formato do cabeçalho: "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839"
// Manifesto assinado: "id:{data.id};request-id:{x-request-id};ts:{ts};"
function assinaturaValida(headers, dataId) {
  if (!WEBHOOK_SECRET) return modoSimulado; // em produção, sem segredo = rejeita tudo
  const xSig = String(headers['x-signature'] || '');
  const xReq = String(headers['x-request-id'] || '');
  const partes = Object.fromEntries(xSig.split(',').map((p) => p.trim().split('=').map((s) => s.trim())));
  const ts = partes.ts, v1 = partes.v1;
  if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;

  // Recusa notificações muito antigas (proteção contra reenvio). ts vem em milissegundos ou segundos.
  const tsMs = ts.length > 11 ? Number(ts) : Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 15 * 60 * 1000) return false;

  const id = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : String(dataId);
  let manifesto = '';
  if (id) manifesto += `id:${id};`;
  if (xReq) manifesto += `request-id:${xReq};`;
  manifesto += `ts:${ts};`;

  const esperado = crypto.createHmac('sha256', WEBHOOK_SECRET).update(manifesto).digest();
  const recebido = Buffer.from(v1, 'hex');
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

// Consulta o pagamento direto na API (fonte da verdade).
async function consultarPagamento(idPagamento) {
  const d = await chamarMP('GET', `/v1/payments/${encodeURIComponent(idPagamento)}`);
  return {
    id: String(d.id),
    status: d.status,                         // approved, pending, rejected, cancelled, refunded...
    pedidoId: Number(d.external_reference),
    valorCentavos: Math.round(Number(d.transaction_amount) * 100),
    metodo: d.payment_type_id === 'bank_transfer' ? 'pix' : 'cartao',
  };
}

module.exports = { modoSimulado, criarPix, criarCheckoutCartao, assinaturaValida, consultarPagamento };
