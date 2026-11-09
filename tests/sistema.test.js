// Testes do sistema em modo simulado (sem Mercado Pago), com Postgres de verdade. Rode com: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor } = require('./ajuda');

let s, admin, cozinha;
before(async () => {
  s = await subirServidor();
  admin = await s.entrar('admin', 'admin-teste-123');
  cozinha = await s.entrar('cozinha', 'cozinha-teste-123');
});
after(() => s.fechar());

const pedidoBalcao = (itens, extra = {}) => s.chamar('/api/pedidos', {
  metodo: 'POST', corpo: { cliente: { nome: 'Ana', telefone: '87999990000' }, tipo: 'retirada', forma_pagamento: 'balcao', itens, ...extra },
});
async function idProduto(nome) {
  const { json } = await s.chamar('/api/cardapio');
  return json.categorias.flatMap((c) => c.produtos).find((p) => p.nome === nome)?.id;
}
async function idAdicional(nome) {
  const { json } = await s.chamar('/api/cardapio');
  return json.adicionais.find((a) => a.nome === nome).id;
}

// ---------- cardápio e pedidos ----------
test('cardápio inicial da Açaí Mix', async () => {
  const { status, json } = await s.chamar('/api/cardapio');
  assert.equal(status, 200);
  assert.deepEqual(json.categorias.map((c) => c.nome), ['Açaí', 'Sorvetes', 'Milkshakes', 'Bebidas']);
  assert.ok(json.adicionais.length > 5);
});

test('preço com adicionais é calculado no servidor (ignora preço enviado pelo navegador)', async () => {
  const acai = await idProduto('Açaí 500ml');               // R$ 17
  const morango = await idAdicional('Morango');             // + R$ 3
  const nutella = await idAdicional('Nutella');             // + R$ 5
  const granola = await idAdicional('Granola');             // grátis
  const r = await pedidoBalcao([{ produto_id: acai, quantidade: 2, adicionais: [morango, nutella, granola, morango], preco_centavos: 1 }]);
  assert.equal(r.status, 201);
  assert.equal(r.json.pedido.total_centavos, 2 * (1700 + 300 + 500));
  assert.equal(r.json.pedido.itens[0].adicionais, 'Morango, Nutella, Granola');
});

test('validações do pedido', async () => {
  const casquinha = await idProduto('Casquinha');
  const granola = await idAdicional('Granola');
  const casos = [
    [[{ produto_id: casquinha, quantidade: 1, adicionais: [granola] }], 'não aceita adicionais'],
    [[{ produto_id: 99999, quantidade: 1 }], 'não está mais disponível'],
    [[{ produto_id: casquinha, quantidade: 0 }], 'Quantidade inválida'],
    [[{ produto_id: casquinha, quantidade: 1.5 }], 'Quantidade inválida'],
    [[], 'Sacola vazia'],
  ];
  for (const [itens, msg] of casos) {
    const r = await pedidoBalcao(itens);
    assert.equal(r.status, 400, msg);
    assert.match(r.json.erro, new RegExp(msg));
  }
  const semNome = await s.chamar('/api/pedidos', { metodo: 'POST', corpo: { cliente: { nome: 'A' }, forma_pagamento: 'balcao', itens: [{ produto_id: casquinha, quantidade: 1 }] } });
  assert.match(semNome.json.erro, /nome/);
});

test('fluxo Pix simulado: só chega na cozinha depois de pago', async () => {
  const acai = await idProduto('Açaí 300ml');
  const r = await s.chamar('/api/pedidos', { metodo: 'POST', corpo: { cliente: { nome: 'Bia' }, tipo: 'mesa', mesa: '3', forma_pagamento: 'pix', itens: [{ produto_id: acai, quantidade: 1 }] } });
  assert.equal(r.json.pedido.status, 'aguardando_pagamento');
  let fila = await s.chamar('/api/cozinha/pedidos', { cookie: cozinha });
  assert.ok(!fila.json.some((p) => p.codigo === r.json.pedido.codigo));

  const pago = await s.chamar(`/api/pedidos/${r.json.token}/simular-pagamento`, { metodo: 'POST' });
  assert.equal(pago.json.status, 'recebido');
  fila = await s.chamar('/api/cozinha/pedidos', { cookie: cozinha });
  const naCozinha = fila.json.find((p) => p.codigo === r.json.pedido.codigo);
  assert.ok(naCozinha);
  assert.equal(naCozinha.cliente_telefone, undefined, 'a cozinha não recebe o telefone do cliente');
});

test('cozinha muda status só pelas etapas permitidas', async () => {
  const r = await pedidoBalcao([{ produto_id: await idProduto('Casquinha'), quantidade: 1 }]);
  const { json: fila } = await s.chamar('/api/cozinha/pedidos', { cookie: cozinha });
  const id = fila.find((p) => p.codigo === r.json.pedido.codigo).id;
  const mudar = (status) => s.chamar(`/api/cozinha/pedidos/${id}`, { metodo: 'PATCH', cookie: cozinha, corpo: { status } });
  assert.equal((await mudar('entregue')).status, 400);
  assert.equal((await mudar('em_preparo')).status, 200);
  assert.equal((await mudar('pronto')).status, 200);
  assert.equal((await mudar('entregue')).status, 200);
  const cliente = await s.chamar(`/api/pedidos/${r.json.token}`);
  assert.equal(cliente.json.status, 'entregue');
});

// ---------- acesso ----------
test('permissões: público, cozinha e admin', async () => {
  assert.equal((await s.chamar('/api/cozinha/pedidos')).status, 401);
  assert.equal((await s.chamar('/api/admin/resumo')).status, 401);
  assert.equal((await s.chamar('/api/admin/resumo', { cookie: cozinha })).status, 403);
  assert.equal((await s.chamar('/api/admin/resumo', { cookie: admin })).status, 200);
  assert.equal((await s.chamar('/api/cozinha/pedidos', { cookie: admin })).status, 200);
  assert.equal((await s.chamar('/api/pedidos/token-que-nao-existe-1234567890')).status, 404);
});

test('login errado é recusado e registrado', async () => {
  const r = await s.chamar('/api/login', { metodo: 'POST', corpo: { usuario: 'admin', senha: 'errada' } });
  assert.equal(r.status, 401);
  const { json } = await s.chamar('/api/admin/atividade', { cookie: admin });
  assert.ok(json.some((a) => a.acao === 'login recusado' && a.usuario === 'admin'));
});

test('CSRF: requisição vinda de outro site é bloqueada', async () => {
  const outroSite = await s.chamar('/api/admin/loja-aberta', { metodo: 'PATCH', cookie: admin, corpo: { loja_aberta: false }, cabecalhos: { Origin: 'https://golpe.com' } });
  assert.equal(outroSite.status, 403);
  const secFetch = await s.chamar('/api/admin/loja-aberta', { metodo: 'PATCH', cookie: admin, corpo: { loja_aberta: false }, cabecalhos: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(secFetch.status, 403);
  assert.equal((await s.chamar('/api/config')).json.loja_aberta, true);
});

test('cookie de sessão é HttpOnly e SameSite=Strict', async () => {
  const r = await s.chamar('/api/login', { metodo: 'POST', corpo: { usuario: 'cozinha', senha: 'cozinha-teste-123' } });
  const c = r.cabecalhos.get('set-cookie');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
});

// ---------- admin ----------
test('admin: loja fechada não aceita pedidos', async () => {
  await s.chamar('/api/admin/loja-aberta', { metodo: 'PATCH', cookie: admin, corpo: { loja_aberta: false } });
  const r = await pedidoBalcao([{ produto_id: await idProduto('Casquinha'), quantidade: 1 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /fechados/);
  await s.chamar('/api/admin/loja-aberta', { metodo: 'PATCH', cookie: admin, corpo: { loja_aberta: true } });
});

test('admin: mudança de preço vale para novos pedidos e fica registrada', async () => {
  const id = await idProduto('Picolé de fruta');
  const { json: produtos } = await s.chamar('/api/admin/produtos', { cookie: admin });
  const p = produtos.find((x) => x.id === id);
  const r = await s.chamar(`/api/admin/produtos/${id}`, { metodo: 'PUT', cookie: admin, corpo: { ...p, preco_centavos: 550 } });
  assert.equal(r.status, 200);
  const pedido = await pedidoBalcao([{ produto_id: id, quantidade: 2 }]);
  assert.equal(pedido.json.pedido.total_centavos, 1100);
  const { json: atividade } = await s.chamar('/api/admin/atividade', { cookie: admin });
  assert.ok(atividade.some((a) => a.acao === 'editou produto' && /R\$ 4,00 → R\$ 5,50/.test(a.detalhe)));
});

test('admin: produto já vendido é arquivado (não some do histórico)', async () => {
  const id = await idProduto('Casquinha');
  assert.equal((await s.chamar(`/api/admin/produtos/${id}`, { metodo: 'DELETE', cookie: admin })).status, 200);
  assert.equal(await idProduto('Casquinha'), undefined);
  const { json } = await s.chamar('/api/admin/pedidos', { cookie: admin });
  assert.ok(json.some((p) => p.itens.some((i) => i.nome === 'Casquinha')));
});

test('admin: preço negativo e nome vazio são recusados', async () => {
  const { json: cats } = await s.chamar('/api/admin/categorias', { cookie: admin });
  const neg = await s.chamar('/api/admin/produtos', { metodo: 'POST', cookie: admin, corpo: { nome: 'Teste', preco_centavos: -100, categoria_id: cats[0].id } });
  assert.equal(neg.status, 400);
  const vazio = await s.chamar('/api/admin/produtos', { metodo: 'POST', cookie: admin, corpo: { nome: '', preco_centavos: 100, categoria_id: cats[0].id } });
  assert.equal(vazio.status, 400);
});

test('admin: upload aceita imagem real e recusa arquivo disfarçado', async () => {
  const id = await idProduto('Açaí 700ml');
  // JPEG mínimo válido (cabeçalho FF D8 FF)
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  const ok = await s.chamar(`/api/admin/produtos/${id}/imagem`, { metodo: 'POST', cookie: admin, corpo: { imagem: 'data:image/jpeg;base64,' + jpeg.toString('base64') } });
  assert.equal(ok.status, 200);
  assert.match(ok.json.imagem, /\/storage\/v1\/object\/public\/fotos\/produtos\/[0-9a-f]{24}\.jpg$/);
  const foto = await fetch(ok.json.imagem);
  assert.equal(foto.headers.get('content-type'), 'image/jpeg');
  // trocar a foto apaga a antiga do Storage
  const ok2 = await s.chamar(`/api/admin/produtos/${id}/imagem`, { metodo: 'POST', cookie: admin, corpo: { imagem: 'data:image/jpeg;base64,' + jpeg.toString('base64') } });
  assert.equal((await fetch(ok.json.imagem)).status, 404);
  assert.equal((await fetch(ok2.json.imagem)).status, 200);

  const falso = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  const r = await s.chamar(`/api/admin/produtos/${id}/imagem`, { metodo: 'POST', cookie: admin, corpo: { imagem: falso } });
  assert.equal(r.status, 400);
});

test('admin: usuários com senha mínima e sem excluir a si mesmo', async () => {
  assert.equal((await s.chamar('/api/admin/usuarios', { metodo: 'POST', cookie: admin, corpo: { usuario: 'maria', senha: 'curta' } })).status, 400);
  assert.equal((await s.chamar('/api/admin/usuarios', { metodo: 'POST', cookie: admin, corpo: { usuario: 'maria', senha: 'senha-longa-123' } })).status, 201);
  const { json } = await s.chamar('/api/admin/usuarios', { cookie: admin });
  const eu = json.find((u) => u.sou_eu);
  assert.equal((await s.chamar(`/api/admin/usuarios/${eu.id}`, { metodo: 'DELETE', cookie: admin })).status, 400);
});

// ---------- diagnóstico e robustez ----------
test('/api/saude confirma configuração e banco', async () => {
  const r = await s.chamar('/api/saude');
  assert.equal(r.status, 200);
  assert.equal(r.json.banco, 'ok');
  assert.deepEqual(r.json.problemas, []);
  assert.ok(!JSON.stringify(r.json).includes(process.env.SUPABASE_SECRET_KEY), 'nunca mostra a chave');
});

test('JSON quebrado responde 400 (e não derruba a função)', async () => {
  for (const caminho of ['/api/pedidos', '/api/login']) {
    const r = await fetch(s.base + caminho, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{quebrado' });
    assert.equal(r.status, 400, caminho);
  }
});

// ---------- manutenção, limites, arquivos ----------
test('cron de manutenção só roda com o segredo certo', async () => {
  assert.equal((await s.chamar('/api/cron/manutencao')).status, 401);
  assert.equal((await s.chamar('/api/cron/manutencao', { cabecalhos: { Authorization: 'Bearer errado' } })).status, 401);
  const r = await s.chamar('/api/cron/manutencao', { cabecalhos: { Authorization: 'Bearer segredo-do-cron-123' } });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.anonimizados, 'number');
});

test('LGPD: manutenção apaga dados pessoais de pedidos antigos', async () => {
  const { psql } = require('./supabase-falso');
  await psql(s.banco.conexao, ['-c', "update acaimix.pedidos set criado_em = now() - interval '200 days' where id = (select min(id) from acaimix.pedidos)"]);
  await s.chamar('/api/cron/manutencao', { cabecalhos: { Authorization: 'Bearer segredo-do-cron-123' } });
  const r = await psql(s.banco.conexao, ['-c', 'select cliente_nome, cliente_telefone from acaimix.pedidos order by id limit 1']);
  assert.equal(r.stdout.trim(), 'Cliente|');
});

test('limite de tentativas de login fica no banco (vale para todas as cópias da função)', async () => {
  let ultimo;
  for (let i = 0; i < 12; i++) ultimo = await s.chamar('/api/login', { metodo: 'POST', corpo: { usuario: 'ninguem', senha: 'x' } });
  assert.equal(ultimo.status, 429);
});

test('cabeçalhos de segurança no servidor local', async () => {
  const r = await fetch(s.base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/\*\.supabase\.co/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(s.base + '/admin')).status, 200, '/admin abre admin.html, como na Vercel');
});

test('vercel.json tem os mesmos cabeçalhos e o cron', () => {
  const v = require('../vercel.json');
  const cab = Object.fromEntries(v.headers[0].headers.map((h) => [h.key, h.value]));
  assert.match(cab['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.ok(cab['Strict-Transport-Security']);
  assert.equal(v.crons[0].path, '/api/cron/manutencao');
});

test('não deixa ler arquivos fora da pasta pública', async () => {
  for (const caminho of ['/../src/app.js', '/%2e%2e/.env', '/.env', '/../supabase/schema.sql']) {
    const r = await fetch(s.base + caminho);
    assert.equal(r.status, 404, caminho);
  }
});

test('a chave pública (anon) não consegue nada no banco', async () => {
  const { psql } = require('./supabase-falso');
  const f = await psql(s.banco.conexao, ['-c', 'set role anon', '-c', "select public.api_exportar('{}')"]);
  assert.match(f.stderr, /permission denied/);
  const t = await psql(s.banco.conexao, ['-c', 'set role anon', '-c', 'select * from acaimix.usuarios']);
  assert.match(t.stderr, /permission denied/);
});
