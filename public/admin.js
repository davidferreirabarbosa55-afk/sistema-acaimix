// Painel do administrador.
(() => {
  const $ = (id) => document.getElementById(id);
  let categorias = [];
  let produtos = [];
  let config = {};

  // ================= utilidades =================
  let timerToast;
  function toast(msg, erro = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('erro-toast', erro);
    t.classList.add('visivel');
    clearTimeout(timerToast);
    timerToast = setTimeout(() => t.classList.remove('visivel'), 2600);
  }
  async function tentar(fn, sucesso) {
    try { const r = await fn(); if (sucesso) toast(sucesso); return r; }
    catch (e) { if (e.status === 401) mostrarLogin(); else toast(e.message, true); e.mostrado = true; throw e; }
  }
  // "12,50" / "12.50" / "12" → 1250 centavos
  function paraCentavos(txt) {
    let s = String(txt || '').trim().replace(/[R$\s]/g, '');
    if (!s) return 0;
    s = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) throw new Error('Preço inválido. Use o formato 12,50');
    return Math.round(n * 100);
  }
  const reais = (c) => (c / 100).toFixed(2).replace('.', ',');
  const dataUTC = (s) => new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  const hojeLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  // Reduz a foto no próprio navegador antes de enviar (mais rápido e leve).
  function lerImagem(arquivo, max = 900) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(arquivo.type)) return reject(new Error('Use uma imagem JPG, PNG ou WEBP.'));
      const leitor = new FileReader();
      leitor.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      leitor.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Imagem inválida.'));
        img.onload = () => {
          const escala = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.src = leitor.result;
      };
      leitor.readAsDataURL(arquivo);
    });
  }

  // ================= login =================
  function mostrarLogin() {
    $('tela-login').classList.remove('escondido');
    $('tela-painel').classList.add('escondido');
  }
  async function entrar(u) {
    if (u.papel !== 'admin') {
      $('erro-login').textContent = 'Este usuário não é administrador. Use a tela da cozinha.';
      $('erro-login').classList.remove('escondido');
      mostrarLogin();
      return;
    }
    $('quem').textContent = `👤 ${u.usuario}`;
    $('tela-login').classList.add('escondido');
    $('tela-painel').classList.remove('escondido');
    await carregarConfig();
    abrirAba(location.hash.slice(1) || 'resumo');
  }
  $('form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('erro-login').classList.add('escondido');
    try {
      const u = await api('/api/login', { method: 'POST', body: JSON.stringify({ usuario: $('usuario').value.trim(), senha: $('senha').value }) });
      $('senha').value = '';
      entrar(u);
    } catch (e) { $('erro-login').textContent = e.message; $('erro-login').classList.remove('escondido'); }
  });
  $('sair').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); mostrarLogin(); });

  // ================= abas =================
  const CARREGAR = { resumo: carregarResumo, pedidos: carregarPedidos, cardapio: carregarCardapio, adicionais: carregarAdicionais, loja: carregarLoja, usuarios: carregarUsuarios };
  function abrirAba(aba) {
    if (!CARREGAR[aba]) aba = 'resumo';
    document.querySelectorAll('#menu button').forEach((b) => b.classList.toggle('ativo', b.dataset.aba === aba));
    document.querySelectorAll('[data-secao]').forEach((s) => s.classList.toggle('escondido', s.dataset.secao !== aba));
    history.replaceState(null, '', '#' + aba);
    window.scrollTo(0, 0);
    CARREGAR[aba]().catch(() => {});
  }
  $('menu').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) abrirAba(b.dataset.aba); });

  // ================= configuração / loja aberta =================
  async function carregarConfig() {
    config = await tentar(() => api('/api/admin/config'));
    document.querySelectorAll('.logo-img').forEach((i) => { i.src = config.logo; });
    mostrarEstadoLoja();
  }
  function mostrarEstadoLoja() {
    $('loja-aberta').checked = config.loja_aberta;
    $('chave-loja').className = 'chave-loja ' + (config.loja_aberta ? 'aberta' : 'fechada');
    $('texto-loja').textContent = config.loja_aberta ? '🟢 Loja aberta' : '🔴 Loja fechada';
    $('sub-loja').textContent = config.loja_aberta ? 'Recebendo pedidos pelo cardápio online' : 'O cardápio mostra "Fechado" e não aceita pedidos';
  }
  $('loja-aberta').addEventListener('change', async (ev) => {
    try {
      config = await tentar(() => api('/api/admin/loja-aberta', { method: 'PATCH', body: JSON.stringify({ loja_aberta: ev.target.checked }) }),
        ev.target.checked ? 'Loja aberta!' : 'Loja fechada');
      mostrarEstadoLoja();
    } catch { ev.target.checked = !ev.target.checked; }
  });

  // ================= resumo =================
  async function carregarResumo() {
    await carregarConfig();
    const r = await tentar(() => api('/api/admin/resumo'));
    $('alertas').classList.toggle('escondido', !r.alertas.length);
    $('lista-alertas').replaceChildren(...r.alertas.map((a) => el('li', {}, el('strong', {}, a.acao.replace('ALERTA: ', '')), ' · ', a.detalhe)));
    $('r-fat').textContent = dinheiro(r.hoje.faturamento);
    $('r-ped').textContent = r.hoje.pedidos;
    $('r-ticket').textContent = dinheiro(r.hoje.ticket_medio);
    $('r-andamento').textContent = r.hoje.em_andamento;

    // 7 dias, incluindo dias sem venda
    const porDia = new Map(r.dias.map((d) => [d.dia, d]));
    const dias = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      const chave = d.toISOString().slice(0, 10);
      dias.push({ chave, rotulo: i === 0 ? 'Hoje' : d.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', ''), fat: porDia.get(chave)?.faturamento || 0 });
    }
    const max = Math.max(...dias.map((d) => d.fat), 1);
    $('barras').replaceChildren(...dias.map((d) => {
      const col = el('div', { class: 'coluna-barra', title: dinheiro(d.fat) });
      col.style.height = `${Math.max(2, (d.fat / max) * 100)}%`;
      return el('div', { class: 'barra-dia' + (d.rotulo === 'Hoje' ? ' hoje' : '') },
        el('span', { class: 'valor-barra' }, d.fat ? dinheiro(d.fat).replace(',00', '') : ''), col, el('span', { class: 'dia' }, d.rotulo));
    }));

    $('ranking').replaceChildren(...(r.mais_vendidos.length
      ? r.mais_vendidos.map((p) => el('li', {}, el('span', {}, p.nome), el('small', {}, `${p.quantidade} ${p.quantidade == 1 ? 'vendido' : 'vendidos'}`)))
      : [el('p', { class: 'suave' }, 'Ainda sem vendas.')]));
  }

  // ================= pedidos =================
  $('dia-pedidos').value = hojeLocal();
  $('dia-pedidos').addEventListener('change', () => carregarPedidos());
  async function carregarPedidos() {
    const dia = $('dia-pedidos').value || hojeLocal();
    const lista = await tentar(() => api(`/api/admin/pedidos?dia=${dia}`));
    const validos = lista.filter((p) => !['aguardando_pagamento', 'cancelado'].includes(p.status));
    const total = validos.reduce((s, p) => s + p.total_centavos, 0);
    $('resumo-dia').textContent = `${validos.length} pedido(s) · ${dinheiro(total)} faturado`;
    const forma = { pix: 'Pix', cartao: 'Cartão', balcao: 'Balcão' };
    $('tabela-pedidos').replaceChildren(...(lista.length ? lista.map((p) => el('tr', {},
      el('td', {}, el('strong', {}, p.codigo)),
      el('td', {}, dataUTC(p.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })),
      el('td', {}, p.cliente_nome, p.cliente_telefone ? el('div', { class: 'itens-mini' }, p.cliente_telefone) : null),
      el('td', { class: 'itens-mini' }, p.itens.map((i) => `${i.quantidade}× ${i.nome}${i.adicionais ? ' (+ ' + i.adicionais + ')' : ''}`).join('; ')),
      el('td', {}, forma[p.forma_pagamento]),
      el('td', {}, el('strong', {}, dinheiro(p.total_centavos))),
      el('td', {}, el('span', { class: `status-pill ${p.status}` }, NOMES_STATUS[p.status].replace(/[!.].*$/, '')))))
      : [el('tr', {}, el('td', { colspan: '7', class: 'suave centro' }, 'Nenhum pedido neste dia.'))]));
  }

  // ================= cardápio =================
  async function carregarCardapio() {
    [categorias, produtos] = await Promise.all([tentar(() => api('/api/admin/categorias')), tentar(() => api('/api/admin/produtos'))]);
    const area = $('lista-cardapio');
    area.replaceChildren();
    if (!categorias.length) area.append(el('div', { class: 'painel suave' }, 'Crie uma categoria para começar (ex.: Açaí, Sorvetes).'));

    categorias.forEach((cat, ci) => {
      const prods = produtos.filter((p) => p.categoria_id === cat.id);
      const bloco = el('div', { class: 'cat-bloco' },
        el('div', { class: 'cat-cabeca' },
          el('h3', {}, cat.nome),
          el('div', { class: 'ordem-botoes' },
            el('button', { class: 'mini-botao', type: 'button', title: 'Subir', disabled: ci === 0, onclick: () => moverCategoria(ci, -1) }, '↑'),
            el('button', { class: 'mini-botao', type: 'button', title: 'Descer', disabled: ci === categorias.length - 1, onclick: () => moverCategoria(ci, 1) }, '↓')),
          el('button', { class: 'mini-botao', type: 'button', onclick: () => renomearCategoria(cat) }, 'Renomear'),
          el('button', { class: 'mini-botao perigo', type: 'button', onclick: () => excluirCategoria(cat) }, 'Excluir'),
          el('button', { class: 'mini-botao', type: 'button', onclick: () => editarProduto(null, cat.id) }, '+ Produto')));
      if (!prods.length) bloco.append(el('div', { class: 'linha-prod suave' }, el('span', {}), 'Nenhum produto ainda.'));
      prods.forEach((p, pi) => {
        const chave = el('input', { type: 'checkbox', class: 'chave pequena', checked: !!p.disponivel, title: 'Disponível', 'aria-label': `${p.nome} disponível` });
        chave.addEventListener('change', async () => {
          try {
            await tentar(() => api(`/api/admin/produtos/${p.id}`, { method: 'PUT', body: JSON.stringify({ ...p, disponivel: chave.checked }) }), chave.checked ? 'Produto visível' : 'Produto escondido');
            p.disponivel = chave.checked ? 1 : 0;
            linha.classList.toggle('off', !p.disponivel);
          } catch { chave.checked = !chave.checked; }
        });
        const linha = el('div', { class: 'linha-prod' + (p.disponivel ? '' : ' off') },
          fotoProduto(p),
          el('div', { class: 'nome' }, p.nome,
            p.destaque ? el('span', { class: 'etq amarela' }, '⭐ destaque') : null,
            p.permite_adicionais ? el('span', { class: 'etq' }, '+ adicionais') : null,
            el('small', {}, p.descricao || '—')),
          el('span', { class: 'preco' }, dinheiro(p.preco_centavos)),
          el('div', { class: 'ordem-botoes' },
            el('button', { class: 'mini-botao', type: 'button', title: 'Subir', disabled: pi === 0, onclick: () => moverProduto(prods, pi, -1) }, '↑'),
            el('button', { class: 'mini-botao', type: 'button', title: 'Descer', disabled: pi === prods.length - 1, onclick: () => moverProduto(prods, pi, 1) }, '↓')),
          el('div', { class: 'ordem-botoes' }, chave, el('button', { class: 'mini-botao', type: 'button', onclick: () => editarProduto(p) }, 'Editar')));
        bloco.append(linha);
      });
      area.append(bloco);
    });
  }

  async function moverCategoria(i, d) {
    const ids = categorias.map((c) => c.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await tentar(() => api('/api/admin/categorias/ordem', { method: 'POST', body: JSON.stringify({ ids }) }));
    carregarCardapio();
  }
  async function moverProduto(lista, i, d) {
    const ids = lista.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await tentar(() => api('/api/admin/produtos/ordem', { method: 'POST', body: JSON.stringify({ ids }) }));
    carregarCardapio();
  }
  $('nova-categoria').addEventListener('click', async () => {
    const nome = prompt('Nome da nova categoria (ex.: Açaí, Sorvetes, Bebidas):');
    if (!nome) return;
    await tentar(() => api('/api/admin/categorias', { method: 'POST', body: JSON.stringify({ nome }) }), 'Categoria criada');
    carregarCardapio();
  });
  async function renomearCategoria(cat) {
    const nome = prompt('Novo nome da categoria:', cat.nome);
    if (!nome || nome === cat.nome) return;
    await tentar(() => api(`/api/admin/categorias/${cat.id}`, { method: 'PUT', body: JSON.stringify({ nome }) }), 'Categoria renomeada');
    carregarCardapio();
  }
  async function excluirCategoria(cat) {
    if (!confirm(`Excluir a categoria "${cat.nome}"?`)) return;
    await tentar(() => api(`/api/admin/categorias/${cat.id}`, { method: 'DELETE' }), 'Categoria excluída');
    carregarCardapio();
  }

  // ---- editor de produto ----
  const janela = $('janela-produto');
  let editando = null;      // produto atual (ou null = novo)
  let novaFoto = undefined; // undefined = não mexeu; '' = remover; dataURL = nova foto

  function previaFoto() {
    const p = { emoji: $('p-emoji').value || '🍧', imagem: novaFoto === undefined ? editando?.imagem : '' };
    const caixa = fotoProduto(p);
    if (novaFoto) { caixa.replaceChildren(el('img', { src: novaFoto, alt: '' })); }
    $('prev-foto').replaceWith(Object.assign(caixa, { id: 'prev-foto' }));
    $('remover-foto').classList.toggle('escondido', !(novaFoto || (novaFoto === undefined && editando?.imagem)));
  }

  function editarProduto(p, categoriaId) {
    if (!categorias.length) return toast('Crie uma categoria primeiro.', true);
    editando = p;
    novaFoto = undefined;
    $('titulo-produto').textContent = p ? 'Editar produto' : 'Novo produto';
    $('p-nome').value = p?.nome || '';
    $('p-desc').value = p?.descricao || '';
    $('p-preco').value = p ? reais(p.preco_centavos) : '';
    $('p-emoji').value = p?.emoji || '🍧';
    $('p-cat').replaceChildren(...categorias.map((c) => el('option', { value: c.id, selected: c.id === (p?.categoria_id || categoriaId) }, c.nome)));
    $('p-disp').checked = p ? !!p.disponivel : true;
    $('p-adic').checked = !!p?.permite_adicionais;
    $('p-dest').checked = !!p?.destaque;
    $('excluir-produto').classList.toggle('escondido', !p);
    $('erro-produto').classList.add('escondido');
    $('arquivo-foto').value = '';
    previaFoto();
    janela.showModal();
  }
  $('novo-produto').addEventListener('click', () => editarProduto(null));
  $('p-emoji').addEventListener('input', previaFoto);
  $('arquivo-foto').addEventListener('change', async (ev) => {
    const arq = ev.target.files[0];
    if (!arq) return;
    try { novaFoto = await lerImagem(arq); previaFoto(); }
    catch (e) { toast(e.message, true); }
  });
  $('remover-foto').addEventListener('click', () => { novaFoto = ''; previaFoto(); });

  $('form-produto').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const erro = $('erro-produto');
    erro.classList.add('escondido');
    try {
      const dados = {
        nome: $('p-nome').value, descricao: $('p-desc').value, preco_centavos: paraCentavos($('p-preco').value),
        emoji: $('p-emoji').value, categoria_id: Number($('p-cat').value),
        disponivel: $('p-disp').checked, permite_adicionais: $('p-adic').checked, destaque: $('p-dest').checked,
      };
      if (!dados.preco_centavos) throw new Error('Informe o preço.');
      let id = editando?.id;
      if (id) await api(`/api/admin/produtos/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      else id = (await api('/api/admin/produtos', { method: 'POST', body: JSON.stringify(dados) })).id;
      if (novaFoto !== undefined) await api(`/api/admin/produtos/${id}/imagem`, { method: 'POST', body: JSON.stringify({ imagem: novaFoto }) });
      janela.close();
      toast('Produto salvo!');
      carregarCardapio();
    } catch (e) {
      if (e.status === 401) return mostrarLogin();
      erro.textContent = e.message; erro.classList.remove('escondido');
    }
  });
  $('excluir-produto').addEventListener('click', async () => {
    if (!editando || !confirm(`Excluir "${editando.nome}" do cardápio?`)) return;
    await tentar(() => api(`/api/admin/produtos/${editando.id}`, { method: 'DELETE' }), 'Produto excluído');
    janela.close();
    carregarCardapio();
  });
  janela.addEventListener('click', (ev) => { if (ev.target === janela || ev.target.closest('[data-fechar]')) janela.close(); });

  // ================= adicionais =================
  async function carregarAdicionais() {
    const lista = await tentar(() => api('/api/admin/adicionais'));
    $('tabela-adicionais').replaceChildren(...(lista.length ? lista.map((a) => {
      const nome = el('input', { value: a.nome, maxlength: '40', 'aria-label': 'Nome' });
      const preco = el('input', { value: reais(a.preco_centavos), inputmode: 'decimal', 'aria-label': 'Preço' });
      const disp = el('input', { type: 'checkbox', class: 'chave pequena', checked: !!a.disponivel, 'aria-label': 'Disponível' });
      const salvar = async () => {
        try {
          await tentar(() => api(`/api/admin/adicionais/${a.id}`, { method: 'PUT', body: JSON.stringify({ nome: nome.value, preco_centavos: paraCentavos(preco.value), disponivel: disp.checked }) }), 'Salvo');
        } catch (e) { if (!e.status) toast(e.message, true); }
      };
      nome.addEventListener('change', salvar);
      preco.addEventListener('change', salvar);
      disp.addEventListener('change', salvar);
      return el('tr', {}, el('td', {}, nome), el('td', {}, preco), el('td', {}, disp),
        el('td', {}, el('button', { class: 'mini-botao perigo', type: 'button', onclick: async () => {
          if (!confirm(`Excluir "${a.nome}"?`)) return;
          await tentar(() => api(`/api/admin/adicionais/${a.id}`, { method: 'DELETE' }), 'Excluído');
          carregarAdicionais();
        } }, 'Excluir')));
    }) : [el('tr', {}, el('td', { colspan: '4', class: 'suave' }, 'Nenhum adicional cadastrado.'))]));
  }
  $('form-adicional').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await tentar(() => api('/api/admin/adicionais', { method: 'POST', body: JSON.stringify({ nome: $('ad-nome').value, preco_centavos: paraCentavos($('ad-preco').value) }) }), 'Adicional criado');
      $('ad-nome').value = ''; $('ad-preco').value = '';
      carregarAdicionais();
    } catch (e) { if (!e.status) toast(e.message, true); }
  });

  // ================= loja =================
  async function carregarLoja() {
    await carregarConfig();
    $('cfg-nome').value = config.nome_loja;
    $('cfg-slogan').value = config.slogan;
    $('cfg-aviso').value = config.aviso;
    $('cfg-whats').value = config.whatsapp;
    $('cfg-aberta').checked = config.loja_aberta;
    $('cfg-balcao').checked = config.permitir_balcao;
    $('prev-logo').replaceChildren(el('img', { src: config.logo, alt: 'Logo atual' }));
    $('info-pagamento').textContent = config.modo_simulado
      ? '🧪 Modo de teste: os pagamentos são simulados. Para cobrar de verdade, coloque as chaves do Mercado Pago no arquivo .env do servidor (veja o README).'
      : '✅ Mercado Pago ativo. Pix e cartão estão cobrando de verdade.';
  }
  $('form-loja').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    config = { ...config, ...(await tentar(() => api('/api/admin/config', { method: 'PUT', body: JSON.stringify({
      nome_loja: $('cfg-nome').value, slogan: $('cfg-slogan').value, aviso: $('cfg-aviso').value, whatsapp: $('cfg-whats').value,
      loja_aberta: $('cfg-aberta').checked, permitir_balcao: $('cfg-balcao').checked,
    }) }), 'Informações salvas!')) };
    mostrarEstadoLoja();
  });
  $('arquivo-logo').addEventListener('change', async (ev) => {
    const arq = ev.target.files[0];
    if (!arq) return;
    try {
      const dados = await lerImagem(arq, 1000);
      await tentar(() => api('/api/admin/logo', { method: 'POST', body: JSON.stringify({ imagem: dados }) }), 'Logo atualizada!');
      carregarLoja();
    } catch (e) { if (!e.status) toast(e.message, true); }
    ev.target.value = '';
  });
  $('logo-padrao').addEventListener('click', async () => {
    await tentar(() => api('/api/admin/logo', { method: 'POST', body: JSON.stringify({ imagem: '' }) }), 'Logo original restaurada');
    carregarLoja();
  });

  // ================= usuários =================
  async function carregarUsuarios() {
    const lista = await tentar(() => api('/api/admin/usuarios'));
    $('tabela-usuarios').replaceChildren(...lista.map((u) => el('tr', {},
      el('td', {}, el('strong', {}, u.usuario), u.sou_eu ? el('span', { class: 'etq' }, 'você') : null),
      el('td', {}, u.papel === 'admin' ? 'Administrador' : 'Cozinha'),
      el('td', {}, el('div', { class: 'ordem-botoes' },
        el('button', { class: 'mini-botao', type: 'button', onclick: async () => {
          const senha = prompt(`Nova senha para ${u.usuario} (mínimo 8 caracteres):`);
          if (!senha) return;
          await tentar(() => api(`/api/admin/usuarios/${u.id}/senha`, { method: 'PUT', body: JSON.stringify({ senha }) }), 'Senha alterada');
          if (u.sou_eu) mostrarLogin();
        } }, 'Trocar senha'),
        u.sou_eu ? null : el('button', { class: 'mini-botao perigo', type: 'button', onclick: async () => {
          if (!confirm(`Excluir o usuário ${u.usuario}?`)) return;
          await tentar(() => api(`/api/admin/usuarios/${u.id}`, { method: 'DELETE' }), 'Usuário excluído');
          carregarUsuarios();
        } }, 'Excluir'))))));

    const atividade = await tentar(() => api('/api/admin/atividade'));
    $('tabela-atividade').replaceChildren(...(atividade.length ? atividade.map((a) => el('tr', { class: a.acao.startsWith('ALERTA') ? 'alerta' : null },
      el('td', { class: 'itens-mini' }, dataUTC(a.quando).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
      el('td', {}, a.usuario),
      el('td', {}, el('strong', {}, a.acao)),
      el('td', { class: 'itens-mini' }, a.detalhe)))
      : [el('tr', {}, el('td', { colspan: '4', class: 'suave' }, 'Nada registrado ainda.'))]));
  }
  $('form-usuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await tentar(() => api('/api/admin/usuarios', { method: 'POST', body: JSON.stringify({ usuario: $('us-nome').value, senha: $('us-senha').value, papel: $('us-papel').value }) }), 'Usuário criado');
    $('us-nome').value = ''; $('us-senha').value = '';
    carregarUsuarios();
  });

  // Erros já mostrados na tela não precisam aparecer de novo no console.
  window.addEventListener('unhandledrejection', (ev) => { if (ev.reason?.mostrado) ev.preventDefault(); });

  // ================= início =================
  api('/api/me').then(entrar).catch(mostrarLogin);
})();
