// Cardápio, escolha de adicionais, sacola e finalização do pedido.
(() => {
  const $ = (id) => document.getElementById(id);
  let config = {};
  const produtos = new Map();
  const adicionais = new Map();
  let sacola = carregar(); // [{ chave, produto_id, adicionais: [ids], quantidade, observacao }]

  function carregar() {
    try { const s = JSON.parse(localStorage.getItem('sacola') || '[]'); return Array.isArray(s) ? s : []; } catch { return []; }
  }
  function salvar() { try { localStorage.setItem('sacola', JSON.stringify(sacola)); } catch { /* ok */ } }
  const normalizar = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ================= carregar =================
  async function iniciar() {
    try {
      const [cfg, dados] = await Promise.all([api('/api/config'), api('/api/cardapio')]);
      config = cfg;
      aplicarConfig();
      for (const a of dados.adicionais) adicionais.set(a.id, a);
      desenharCardapio(dados.categorias);
      sacola = sacola.filter((i) => produtos.has(i.produto_id) && (i.adicionais || []).every((a) => adicionais.has(a)));
      salvar();
      atualizarSacola();
    } catch (e) {
      $('cardapio').replaceChildren(el('p', { class: 'erro' }, 'Não foi possível carregar o cardápio. ' + e.message));
    }
  }

  function aplicarConfig() {
    document.title = `${config.nome_loja} · Cardápio`;
    $('logo').alt = config.nome_loja;
    if (config.logo) $('logo').src = config.logo;
    $('slogan').textContent = config.slogan || '';
    $('status-loja').classList.toggle('fechado', !config.loja_aberta);
    $('status-texto').textContent = config.loja_aberta ? 'Aberto agora' : 'Fechado no momento';
    $('aviso').classList.toggle('escondido', !config.aviso);
    $('aviso-texto').textContent = config.aviso || '';
    $('aviso-teste').classList.toggle('escondido', !config.modo_simulado || !!config.aviso);
    $('opcao-balcao').classList.toggle('escondido', !config.permitir_balcao);
    if (config.whatsapp) {
      $('whatsapp').href = `https://wa.me/55${config.whatsapp.replace(/^55/, '')}`;
      $('whatsapp').classList.remove('escondido');
    }
    try { if (localStorage.getItem('ultimo_pedido')) $('meu-pedido').hidden = false; } catch { /* ok */ }
  }

  // ================= cardápio =================
  function cartaoProduto(p) {
    const foto = fotoProduto(p);
    foto.append(el('span', { class: 'mais', 'aria-hidden': 'true' }, '+'));
    return el('button', { type: 'button', class: 'produto', 'data-busca': normalizar(`${p.nome} ${p.descricao}`), onclick: () => abrirProduto(p.id) },
      el('div', {},
        el('span', { class: 'titulo-prod' }, p.nome),
        el('span', { class: 'desc-prod' }, p.descricao),
        el('span', { class: 'preco' }, dinheiro(p.preco_centavos)),
        p.permite_adicionais ? el('span', { class: 'tag-adic' }, '+ adicionais') : null),
      foto);
  }

  function desenharCardapio(categorias) {
    const area = $('cardapio');
    const chips = $('chips');
    area.replaceChildren();
    chips.replaceChildren();
    const destaques = [];

    for (const cat of categorias) {
      for (const p of cat.produtos) { produtos.set(p.id, p); if (p.destaque) destaques.push(p); }
      const secao = el('section', { class: 'categoria', id: `cat-${cat.id}`, 'data-cat': cat.id },
        el('div', { class: 'titulo-secao' }, el('h2', {}, cat.nome), el('span', {}, `${cat.produtos.length} ${cat.produtos.length === 1 ? 'item' : 'itens'}`)),
        el('div', { class: 'produtos' }, cat.produtos.map(cartaoProduto)));
      area.append(secao);
      chips.append(el('button', { type: 'button', 'data-cat': cat.id, onclick: () => secao.scrollIntoView({ behavior: 'smooth' }) }, cat.nome));
    }
    if (!categorias.length) area.append(el('p', { class: 'sem-resultado' }, 'O cardápio está sendo preparado. Volte em instantes!'));

    $('secao-destaques').classList.toggle('escondido', !destaques.length);
    $('destaques').replaceChildren(...destaques.map((p) => {
      const foto = fotoProduto(p);
      foto.append(el('span', { class: 'selo' }, 'Mais pedido'));
      return el('button', { type: 'button', class: 'destaque', onclick: () => abrirProduto(p.id) },
        foto, el('span', { class: 'corpo' }, el('span', { class: 'titulo-prod' }, p.nome), el('span', { class: 'preco' }, dinheiro(p.preco_centavos))));
    }));
    observarCategorias();
  }

  // Destaca a categoria visível na barra de chips.
  function observarCategorias() {
    const marcar = (id) => {
      for (const b of $('chips').children) {
        const ativo = b.dataset.cat === String(id);
        b.classList.toggle('ativo', ativo);
        if (ativo) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    };
    const obs = new IntersectionObserver((entradas) => {
      const visivel = entradas.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visivel) marcar(visivel.target.dataset.cat);
    }, { rootMargin: '-140px 0px -55% 0px' });
    document.querySelectorAll('.categoria').forEach((s) => obs.observe(s));
    window.addEventListener('scroll', () => $('barra').classList.toggle('rolou', window.scrollY > $('barra').offsetTop - 1), { passive: true });
  }

  $('busca').addEventListener('input', () => {
    const termo = normalizar($('busca').value.trim());
    let algum = false;
    document.querySelectorAll('.categoria').forEach((secao) => {
      let n = 0;
      secao.querySelectorAll('.produto').forEach((p) => {
        const mostra = !termo || p.dataset.busca.includes(termo);
        p.classList.toggle('escondido', !mostra);
        if (mostra) n++;
      });
      secao.classList.toggle('escondido', !n);
      if (n) algum = true;
    });
    $('secao-destaques').classList.toggle('escondido', !!termo || !$('destaques').children.length);
    $('sem-resultado').classList.toggle('escondido', algum);
  });

  // ================= janela do produto =================
  let atual = null; // { produto, quantidade, adicionais: Set }
  const janelaProduto = $('janela-produto');

  function abrirProduto(id) {
    const p = produtos.get(id);
    if (!p) return;
    atual = { produto: p, quantidade: 1, adicionais: new Set() };
    $('prod-foto').replaceChildren(fotoProduto(p));
    $('prod-nome').textContent = p.nome;
    $('prod-desc').textContent = p.descricao;
    $('prod-preco').textContent = dinheiro(p.preco_centavos);
    $('prod-obs').value = '';
    const temAdic = p.permite_adicionais && adicionais.size;
    $('bloco-adicionais').classList.toggle('escondido', !temAdic);
    if (temAdic) {
      $('lista-adicionais').replaceChildren(...[...adicionais.values()].map((a) => {
        const caixa = el('input', { type: 'checkbox' });
        caixa.addEventListener('change', () => { caixa.checked ? atual.adicionais.add(a.id) : atual.adicionais.delete(a.id); atualizarProduto(); });
        return el('label', { class: 'opcao-adic' }, caixa, el('span', { class: 'nome' }, a.nome),
          el('span', { class: 'valor' + (a.preco_centavos ? '' : ' gratis') }, a.preco_centavos ? `+ ${dinheiro(a.preco_centavos)}` : 'Grátis'));
      }));
    }
    atualizarProduto();
    janelaProduto.showModal();
    janelaProduto.querySelector('.rolagem').scrollTop = 0;
  }

  function precoUnitario(produto, idsAdic) {
    return produto.preco_centavos + [...idsAdic].reduce((s, id) => s + (adicionais.get(id)?.preco_centavos || 0), 0);
  }

  function atualizarProduto() {
    $('prod-qtd').textContent = atual.quantidade;
    $('prod-menos').disabled = atual.quantidade <= 1;
    $('prod-mais').disabled = atual.quantidade >= 20;
    const total = precoUnitario(atual.produto, atual.adicionais) * atual.quantidade;
    $('prod-adicionar').textContent = `Adicionar · ${dinheiro(total)}`;
  }
  $('prod-menos').addEventListener('click', () => { atual.quantidade = Math.max(1, atual.quantidade - 1); atualizarProduto(); });
  $('prod-mais').addEventListener('click', () => { atual.quantidade = Math.min(20, atual.quantidade + 1); atualizarProduto(); });

  $('prod-adicionar').addEventListener('click', () => {
    const ids = [...atual.adicionais].sort((a, b) => a - b);
    const obs = $('prod-obs').value.trim();
    const chave = `${atual.produto.id}|${ids.join(',')}|${obs}`;
    const existente = sacola.find((i) => i.chave === chave);
    if (existente) existente.quantidade = Math.min(20, existente.quantidade + atual.quantidade);
    else sacola.push({ chave, produto_id: atual.produto.id, adicionais: ids, quantidade: atual.quantidade, observacao: obs });
    salvar();
    janelaProduto.close();
    atualizarSacola(true);
  });

  // ================= sacola =================
  const janelaSacola = $('janela-sacola');
  const totalSacola = () => sacola.reduce((s, i) => s + precoUnitario(produtos.get(i.produto_id), i.adicionais) * i.quantidade, 0);

  function atualizarSacola(pular = false) {
    const qtd = sacola.reduce((s, i) => s + i.quantidade, 0);
    const total = dinheiro(totalSacola());
    $('contador').textContent = qtd;
    $('total-flutuante').textContent = total;
    $('total-sacola').textContent = total;
    const flut = $('flutuante');
    flut.classList.toggle('visivel', qtd > 0);
    if (pular) { flut.classList.remove('pulo'); void flut.offsetWidth; flut.classList.add('pulo'); }

    const lista = $('itens-sacola');
    lista.replaceChildren();
    if (!sacola.length) {
      lista.append(el('div', { class: 'vazio' }, el('span', { class: 'grande' }, '🍧'), 'Sua sacola está vazia.'));
    }
    sacola.forEach((item, idx) => {
      const p = produtos.get(item.produto_id);
      const nomesAdic = item.adicionais.map((id) => adicionais.get(id)?.nome).filter(Boolean).join(', ');
      lista.append(el('div', { class: 'item-sacola' },
        fotoProduto(p),
        el('div', {},
          el('div', { class: 'nome' }, p.nome),
          nomesAdic ? el('small', {}, '+ ' + nomesAdic) : null,
          item.observacao ? el('small', {}, '📝 ' + item.observacao) : null),
        el('div', { class: 'lado' },
          el('strong', {}, dinheiro(precoUnitario(p, item.adicionais) * item.quantidade)),
          el('div', { class: 'stepper mini' },
            el('button', { type: 'button', 'aria-label': item.quantidade === 1 ? 'Remover' : 'Diminuir', onclick: () => mudarQtd(idx, -1) }, item.quantidade === 1 ? '🗑' : '−'),
            el('span', {}, item.quantidade),
            el('button', { type: 'button', 'aria-label': 'Aumentar', disabled: item.quantidade >= 20, onclick: () => mudarQtd(idx, 1) }, '+')))));
    });
    atualizarBotaoAvancar();
  }

  function mudarQtd(idx, delta) {
    sacola[idx].quantidade += delta;
    if (sacola[idx].quantidade <= 0) sacola.splice(idx, 1);
    salvar();
    atualizarSacola();
    if (!sacola.length) mostrarEtapa('itens');
  }

  let etapa = 'itens';
  function mostrarEtapa(nova) {
    etapa = nova;
    $('etapa-itens').classList.toggle('escondido', nova !== 'itens');
    $('etapa-dados').classList.toggle('escondido', nova !== 'dados');
    $('sacola-titulo').textContent = nova === 'itens' ? 'Sua sacola' : 'Finalizar pedido';
    atualizarBotaoAvancar();
  }
  function atualizarBotaoAvancar() {
    const b = $('avancar');
    const total = dinheiro(totalSacola());
    if (!config.loja_aberta) { b.disabled = true; b.textContent = 'Loja fechada no momento'; return; }
    b.disabled = !sacola.length;
    b.textContent = etapa === 'itens' ? `Continuar · ${total}` : `Fazer pedido · ${total}`;
  }

  $('abrir-sacola').addEventListener('click', () => { mostrarEtapa('itens'); janelaSacola.showModal(); });
  $('voltar-itens').addEventListener('click', () => mostrarEtapa('itens'));

  const form = $('etapa-dados');
  const atualizarCampos = () => {
    $('campo-mesa').classList.toggle('escondido', form.tipo.value !== 'mesa');
    $('campo-email').classList.toggle('escondido', form.pagamento.value !== 'pix' || config.modo_simulado);
  };
  form.addEventListener('change', atualizarCampos);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); enviar(); });

  $('avancar').addEventListener('click', () => {
    if (etapa === 'itens') {
      mostrarEtapa('dados');
      atualizarCampos();
      try { const salvo = JSON.parse(localStorage.getItem('cliente') || '{}'); if (salvo.nome && !form.nome.value) { form.nome.value = salvo.nome; form.telefone.value = salvo.telefone || ''; form.email.value = salvo.email || ''; } } catch { /* ok */ }
      form.nome.focus();
    } else {
      enviar();
    }
  });

  async function enviar() {
    const erro = $('erro');
    const botao = $('avancar');
    erro.classList.add('escondido');
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      const cliente = { nome: form.nome.value, telefone: form.telefone.value, email: form.email.value };
      const r = await api('/api/pedidos', {
        method: 'POST',
        body: JSON.stringify({
          cliente, tipo: form.tipo.value, mesa: form.mesa.value, observacao: form.observacao.value,
          forma_pagamento: form.pagamento.value,
          itens: sacola.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade, adicionais: i.adicionais, observacao: i.observacao })),
        }),
      });
      sacola = [];
      salvar();
      try { localStorage.setItem('ultimo_pedido', r.token); localStorage.setItem('cliente', JSON.stringify(cliente)); } catch { /* ok */ }
      const pg = r.pedido.pagamento;
      location.href = r.pedido.forma_pagamento === 'cartao' && pg?.checkout_url
        ? pg.checkout_url // página segura do Mercado Pago
        : `/pedido.html?t=${encodeURIComponent(r.token)}`;
    } catch (e) {
      erro.textContent = e.message;
      erro.classList.remove('escondido');
      erro.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      atualizarBotaoAvancar();
    }
  }

  // Fechar janelas: botão ✕ ou clique fora.
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target === d || ev.target.closest('[data-fechar]')) d.close(); });
  });

  iniciar();
})();
