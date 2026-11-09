// Página de acompanhamento do pedido (cliente).
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let token = params.get('t');
  try { token = token || localStorage.getItem('ultimo_pedido'); } catch { /* ok */ }
  // Retorno do Checkout Pro: o Mercado Pago acrescenta payment_id na URL.
  const paymentId = params.get('payment_id') || params.get('collection_id');
  const ETAPAS = [['recebido', 'Recebido', '📥'], ['em_preparo', 'Preparando', '🥄'], ['pronto', 'Pronto', '🔔'], ['entregue', 'Entregue', '💜']];
  let timer;
  let statusAnterior = null;

  api('/api/config').then((c) => { if (c.logo) $('logo').src = c.logo; $('logo').alt = c.nome_loja; document.title = `Meu pedido · ${c.nome_loja}`; }).catch(() => {});

  if (!token) {
    $('codigo').textContent = '—';
    $('status').textContent = 'Nenhum pedido encontrado';
    return;
  }

  async function atualizar() {
    try {
      const q = paymentId ? `?payment_id=${encodeURIComponent(paymentId)}` : '';
      const p = await api(`/api/pedidos/${encodeURIComponent(token)}${q}`);
      desenhar(p);
      if (!['entregue', 'cancelado'].includes(p.status)) timer = setTimeout(atualizar, p.status === 'aguardando_pagamento' ? 4000 : 8000);
    } catch (e) {
      $('status').textContent = e.message;
      timer = setTimeout(atualizar, 10000);
    }
  }

  function avisar(p) {
    if (statusAnterior && statusAnterior !== p.status && p.status === 'pronto') {
      try { navigator.vibrate?.([200, 100, 200]); } catch { /* ok */ }
      document.title = '🔔 Pedido pronto!';
    }
    statusAnterior = p.status;
  }

  function desenhar(p) {
    avisar(p);
    $('codigo').textContent = p.codigo;
    $('status').textContent = NOMES_STATUS[p.status] || p.status;

    const idx = ETAPAS.findIndex(([s]) => s === p.status);
    $('cartao-etapas').classList.toggle('escondido', p.status === 'cancelado');
    $('etapas').replaceChildren(...ETAPAS.map(([, rotulo, ico], i) =>
      el('div', { class: 'etapa' + (idx >= i ? ' feita' : '') + (idx === i && p.status !== 'entregue' ? ' atual' : '') },
        el('div', { class: 'ponto' }, idx >= i ? ico : ''), rotulo)));
    $('dica-pronto').classList.toggle('escondido', p.status !== 'pronto');

    $('itens').replaceChildren(...p.itens.map((i) =>
      el('li', {},
        el('span', {}, el('b', {}, `${i.quantidade}× `), i.nome,
          i.adicionais ? el('small', {}, '+ ' + i.adicionais) : null,
          i.observacao ? el('small', {}, '📝 ' + i.observacao) : null),
        el('span', {}, dinheiro(i.preco_centavos * i.quantidade)))));
    $('total').textContent = dinheiro(p.total_centavos);

    const entrega = p.tipo === 'mesa' ? `Entrega na mesa ${p.mesa}` : 'Retirada no balcão';
    const forma = { pix: 'Pix', cartao: 'Cartão', balcao: 'Pagar no balcão' }[p.forma_pagamento];
    $('info').textContent = `${entrega} · ${forma} · ${p.cliente_nome}`;

    const aguardando = p.status === 'aguardando_pagamento';
    $('area-pagamento').classList.toggle('escondido', !aguardando);
    if (aguardando && p.pagamento) {
      const pg = p.pagamento;
      const ehPix = pg.metodo === 'pix';
      $('pix').classList.toggle('escondido', !ehPix);
      $('cartao').classList.toggle('escondido', ehPix || !pg.checkout_url);
      $('simulado').classList.toggle('escondido', !p.modo_simulado);
      if (ehPix) {
        if (pg.pix_qr_base64) { $('qr').src = `data:image/png;base64,${pg.pix_qr_base64}`; $('qr').classList.remove('escondido'); }
        $('copia-cola').value = pg.pix_copia_cola || '';
      }
      if (pg.checkout_url && /^https:\/\//.test(pg.checkout_url)) $('link-checkout').href = pg.checkout_url;
    }
  }

  $('copiar').addEventListener('click', async (ev) => {
    const botao = ev.currentTarget;
    const campo = $('copia-cola');
    try { await navigator.clipboard.writeText(campo.value); } catch { campo.select(); document.execCommand('copy'); }
    botao.textContent = 'Copiado ✓';
    setTimeout(() => { botao.textContent = 'Copiar código Pix'; }, 2000);
  });

  $('simular').addEventListener('click', async () => {
    try {
      const p = await api(`/api/pedidos/${encodeURIComponent(token)}/simular-pagamento`, { method: 'POST' });
      clearTimeout(timer);
      desenhar(p);
      timer = setTimeout(atualizar, 8000);
    } catch (e) { alert(e.message); }
  });

  atualizar();
})();
