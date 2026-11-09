// Painel da cozinha: consulta os pedidos a cada 4 segundos e apita quando chega um novo.
(() => {
  const $ = (id) => document.getElementById(id);
  const pedidos = new Map();
  const COLUNAS = ['recebido', 'em_preparo', 'pronto'];
  const ACOES = {
    recebido: [{ rotulo: 'Cancelar', para: 'cancelado', confirmar: true }, { rotulo: 'Começar preparo', para: 'em_preparo', principal: true }],
    em_preparo: [{ rotulo: '↩', para: 'recebido', titulo: 'Voltar para Novos' }, { rotulo: 'Pronto!', para: 'pronto', principal: true }],
    pronto: [{ rotulo: '↩', para: 'em_preparo', titulo: 'Voltar para Preparando' }, { rotulo: 'Entregue', para: 'entregue', principal: true }],
  };
  let timerFila = null;
  let primeiraCarga = true;
  const INTERVALO = 4000;
  let somLigado = true;
  let audio;

  const dataUTC = (s) => new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');

  function bip() {
    if (!somLigado) return;
    try {
      audio = audio || new AudioContext();
      [0, 0.22, 0.44].forEach((t, i) => {
        const o = audio.createOscillator(); const g = audio.createGain();
        o.frequency.value = [660, 880, 990][i]; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.25, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.2);
        o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.2);
      });
    } catch { /* navegador sem áudio */ }
  }

  api('/api/config').then((c) => { if (c.logo) document.querySelectorAll('img').forEach((i) => { i.src = c.logo; }); }).catch(() => {});

  // ---------- login ----------
  async function verificarLogin() {
    try { const u = await api('/api/me'); mostrarPainel(u); }
    catch { mostrarLogin(); }
  }
  function mostrarLogin() {
    $('tela-login').classList.remove('escondido');
    $('tela-painel').classList.add('escondido');
    clearTimeout(timerFila); timerFila = null;
  }
  $('form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const erro = $('erro-login');
    erro.classList.add('escondido');
    try {
      const u = await api('/api/login', { method: 'POST', body: JSON.stringify({ usuario: $('usuario').value.trim(), senha: $('senha').value }) });
      $('senha').value = '';
      mostrarPainel(u);
    } catch (e) { erro.textContent = e.message; erro.classList.remove('escondido'); }
  });
  $('sair').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    mostrarLogin();
  });

  // ---------- painel ----------
  async function mostrarPainel(u) {
    $('tela-login').classList.add('escondido');
    $('tela-painel').classList.remove('escondido');
    $('link-admin').classList.toggle('escondido', u.papel !== 'admin');
    primeiraCarga = true;
    atualizarFila();
  }

  // Busca a fila; os pedidos que ainda não estavam na tela piscam e o som toca.
  async function atualizarFila() {
    clearTimeout(timerFila);
    try {
      const lista = await api('/api/cozinha/pedidos');
      const novos = primeiraCarga ? [] : lista.filter((p) => !pedidos.has(p.id) && p.status === 'recebido').map((p) => p.id);
      pedidos.clear();
      for (const p of lista) pedidos.set(p.id, p);
      desenhar(new Set(novos));
      if (novos.length) bip();
      primeiraCarga = false;
      $('indicador').classList.add('on');
      $('conexao').textContent = 'ao vivo';
    } catch (e) {
      if (e.status === 401) return mostrarLogin();
      $('indicador').classList.remove('on');
      $('conexao').textContent = 'sem conexão, tentando de novo…';
    }
    timerFila = setTimeout(atualizarFila, INTERVALO);
  }

  const minutosDesde = (s) => Math.max(0, Math.floor((Date.now() - dataUTC(s)) / 60000));

  function ticket(p, destacar) {
    const min = minutosDesde(p.criado_em);
    return el('article', { class: `ticket ${p.status}${destacar ? ' novo' : ''}` },
      el('div', { class: 'cab' },
        el('span', { class: 'num' }, p.codigo),
        el('span', { class: 'tempo' + (min >= 15 && p.status !== 'pronto' ? ' atrasado' : '') }, min ? `⏱ ${min} min` : 'agora')),
      el('div', { class: 'info' },
        el('span', {}, p.cliente_nome),
        el('span', { class: 'etiqueta' }, p.tipo === 'mesa' ? `Mesa ${p.mesa}` : 'Retirada'),
        p.forma_pagamento === 'balcao' ? el('span', { class: 'etiqueta balcao' }, 'cobrar no balcão') : el('span', { class: 'etiqueta pago' }, 'pago ✓')),
      el('ul', {}, p.itens.map((i) => el('li', {},
        el('b', {}, `${i.quantidade}×`), i.nome,
        i.adicionais ? el('span', { class: 'adic' }, '+ ' + i.adicionais) : null,
        i.observacao ? el('span', { class: 'obs-item' }, '⚠ ' + i.observacao) : null))),
      p.observacao ? el('div', { class: 'obs' }, '📝 ' + p.observacao) : null,
      el('div', { class: 'botoes' }, (ACOES[p.status] || []).map((a) =>
        el('button', { type: 'button', class: a.principal ? 'principal' : '', title: a.titulo || null, onclick: () => mover(p, a) }, a.rotulo))));
  }

  function desenhar(novos = new Set()) {
    for (const col of COLUNAS) {
      const lista = [...pedidos.values()].filter((p) => p.status === col).sort((a, b) => a.id - b.id);
      const alvo = $(`col-${col}`);
      alvo.replaceChildren(...lista.map((p) => ticket(p, novos.has(p.id))));
      if (!lista.length) alvo.append(el('div', { class: 'vazia' }, col === 'recebido' ? 'Aguardando pedidos…' : '—'));
      $(`n-${col}`).textContent = lista.length;
    }
  }

  async function mover(p, acao) {
    if (acao.confirmar && !confirm(`Cancelar o pedido ${p.codigo}?`)) return;
    try {
      const atualizado = await api(`/api/cozinha/pedidos/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status: acao.para }) });
      if (COLUNAS.includes(atualizado.status)) pedidos.set(atualizado.id, atualizado); else pedidos.delete(atualizado.id);
      desenhar();
    } catch (e) { if (e.status === 401) mostrarLogin(); else alert(e.message); }
  }

  $('som').addEventListener('click', (ev) => {
    somLigado = !somLigado;
    ev.currentTarget.textContent = somLigado ? '🔔 Som ligado' : '🔕 Som desligado';
    if (somLigado) bip();
  });

  // ---------- disponibilidade ----------
  const janela = $('janela-disp');
  function linha(tipo, item) {
    const chave = el('input', { type: 'checkbox', class: 'chave', checked: !!item.disponivel, 'aria-label': item.nome });
    chave.addEventListener('change', () => api(`/api/cozinha/${tipo}/${item.id}`, { method: 'PATCH', body: JSON.stringify({ disponivel: chave.checked }) })
      .catch((e) => { alert(e.message); chave.checked = !chave.checked; }));
    return el('label', { class: 'linha-disp' }, el('span', {}, `${item.emoji ? item.emoji + ' ' : ''}${item.nome}`), chave);
  }
  $('abrir-disp').addEventListener('click', async () => {
    try {
      const d = await api('/api/cozinha/produtos');
      $('disp-produtos').replaceChildren(...d.produtos.map((p) => linha('produtos', p)));
      $('disp-adicionais').replaceChildren(...d.adicionais.map((a) => linha('adicionais', a)));
      janela.showModal();
    } catch (e) { alert(e.message); }
  });
  janela.addEventListener('click', (ev) => { if (ev.target === janela || ev.target.closest('[data-fechar]')) janela.close(); });

  setInterval(() => desenhar(), 30000); // atualiza o tempo de espera
  verificarLogin();
})();
