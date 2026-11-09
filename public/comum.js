// Funções compartilhadas entre as páginas.
const dinheiro = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
    credentials: 'same-origin',
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error(dados.erro || 'Algo deu errado. Tente novamente.');
    erro.status = resp.status;
    throw erro;
  }
  return dados;
}

// Cria elementos com segurança (textContent, nunca innerHTML com dados do usuário).
function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}

// Foto do produto (ou emoji num fundo colorido, se não houver foto).
function fotoProduto(p, classe = '') {
  const caixa = el('div', { class: `foto ${classe}` });
  if (p.imagem && p.imagem.startsWith('/uploads/')) {
    caixa.append(el('img', { src: p.imagem, alt: '', loading: 'lazy', decoding: 'async' }));
  } else {
    caixa.append(el('span', { class: 'emoji', 'aria-hidden': 'true' }, p.emoji || '🍧'));
  }
  return caixa;
}

const NOMES_STATUS = {
  aguardando_pagamento: 'Aguardando pagamento',
  recebido: 'Pedido recebido',
  em_preparo: 'Em preparo',
  pronto: 'Pronto! Pode retirar 💜',
  entregue: 'Entregue. Bom apetite!',
  cancelado: 'Pedido cancelado',
};
