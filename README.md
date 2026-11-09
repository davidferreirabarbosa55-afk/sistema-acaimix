# Açaí Mix 💜 · Sistema de pedidos

Cardápio online com adicionais, pagamento por Pix e cartão via **Mercado Pago**, painel da **cozinha** em tempo real e painel do **administrador** para editar tudo.

Só precisa do **Node.js 22.5 ou mais novo**. Não há bibliotecas para instalar (o banco SQLite já vem embutido).

| Página | Endereço | Para quem |
|---|---|---|
| Cardápio e pedido | `/` | Clientes |
| Acompanhar pedido | `/pedido` | Clientes (abre sozinha após o pedido) |
| Cozinha | `/cozinha` | Equipe (login de cozinha ou admin) |
| Administrador | `/admin` | Dono/gerente (login de admin) |

## Rodar no computador

1. Instale o Node.js 22 LTS: https://nodejs.org
2. Na pasta do projeto, copie `.env.example` para `.env` e preencha **`ADMIN_SENHA`** e **`COZINHA_SENHA`** (8+ caracteres cada).
3. Rode `npm start`
4. Abra:
   - http://localhost:3000 (cardápio)
   - http://localhost:3000/admin (usuário `admin` + sua senha)
   - http://localhost:3000/cozinha (usuário `cozinha` + sua senha)

> **Já tinha rodado a versão anterior?** Apague a pasta `data` antes de rodar, para o sistema criar o cardápio da Açaí Mix do zero. (Ou mantenha a pasta e edite o cardápio pelo /admin.)

Sem as chaves do Mercado Pago, o sistema roda em **modo de teste**, com um botão "Simular pagamento aprovado".

## O que o administrador pode fazer

- **Resumo**: faturamento e pedidos do dia, ticket médio, gráfico dos últimos 7 dias, mais vendidos. Botão para **abrir/fechar a loja**.
- **Pedidos**: histórico por dia, com itens, adicionais, forma de pagamento e status.
- **Cardápio**: criar, editar, reordenar e excluir categorias e produtos; **foto** de cada produto (ou emoji); preço; marcar "aceita adicionais" e "mais pedido ⭐"; esconder o que acabou.
- **Adicionais**: granola, frutas, coberturas etc. com preço (0 = grátis). Ligar/desligar na hora.
- **Loja**: nome, frase, aviso em destaque (promoções), WhatsApp, trocar a logo, aceitar ou não pagamento no balcão.
- **Usuários**: criar logins para a equipe (cozinha ou admin), trocar senhas, remover acesso.

A **cozinha** também pode desligar produtos e adicionais que acabaram (botão "Acabou algo?").

**Backup**: `npm run backup` cria uma cópia segura do banco (pode rodar com o sistema ligado).

**Esqueceu a senha do admin?** No servidor, rode:
`npm run criar-usuario -- admin NovaSenha123`

## Ligar o Mercado Pago

1. Crie uma aplicação em https://www.mercadopago.com.br/developers/panel (produto: *Pagamentos online*).
2. Em **Credenciais**, copie o **Access Token de teste** para `MP_ACCESS_TOKEN` no `.env`.
3. Em **Webhooks**, cadastre `https://SEU-SITE/api/webhooks/mercadopago`, marque **Pagamentos** e copie a **assinatura secreta** para `MP_WEBHOOK_SECRET`.
4. Coloque o endereço público do site em `URL_PUBLICA`.
5. Teste com as contas e cartões de teste do Mercado Pago. Depois troque pelas credenciais de **produção**.
6. Para o Pix funcionar em produção, cadastre uma **chave Pix** na conta do Mercado Pago.

## Segurança

- Preço (inclusive dos adicionais) **sempre calculado no servidor**: ninguém altera valores pelo navegador.
- Dados de cartão **nunca passam pelo seu servidor** (Checkout Pro do Mercado Pago).
- Webhook com **assinatura conferida**; pagamento **confirmado na API** e **valor comparado** com o pedido antes de ir para a cozinha.
- Senhas com **scrypt**; sessão em cookie `HttpOnly` + `SameSite=Strict`; **dois níveis de acesso** (cozinha não entra no admin).
- Proteção contra **CSRF** (SameSite + Origin + Sec-Fetch-Site), **XSS** (CSP estrita, sem `innerHTML` com dados do usuário) e **força bruta** (10 tentativas de login a cada 15 minutos por IP).
- Limites de pedidos pensados para o **Wi-Fi da loja** (muitos clientes no mesmo IP).
- **Zero dependências externas**: nada de pacotes de terceiros que possam ter falhas ou ser comprometidos.
- Fotos enviadas: só JPG/PNG/WEBP, **conferidas pelo conteúdo do arquivo**, com nome aleatório.

## Testes automáticos

Antes de publicar uma mudança, rode:

```bash
npm test
```

São 26 testes que sobem o sistema com um banco temporário e conferem: preços e adicionais, pedidos, permissões da cozinha e do admin, proteção contra CSRF, uploads disfarçados, cabeçalhos de segurança, e a integração com o Mercado Pago (com uma API falsa, sem rede e sem dinheiro).

## Privacidade (LGPD) e registro de atividades

- **Dados do cliente**: só nome (obrigatório), WhatsApp e e-mail (opcionais). A cozinha vê só o nome.
- Depois de `RETENCAO_DIAS` (padrão 180), o sistema apaga nome, telefone e e-mail dos pedidos antigos. Os números de vendas continuam nos relatórios.
- **Atividade recente** (aba Usuários): logins, logins recusados, mudanças de preço, produtos tirados do cardápio, cancelamentos e alertas de pagamento. Guardado por 1 ano.
- **Alertas no Resumo**: se um cliente pagar um pedido que já tinha sido cancelado, ou pagar um valor diferente, aparece um aviso para você fazer o reembolso no Mercado Pago.
- Pedidos não pagos são cancelados sozinhos depois de 2 horas (o Pix e o link do cartão vencem em 30 minutos).

## Colocar no ar

**Fly.io**: já está tudo pronto. Siga o passo a passo em [`DEPLOY-FLY.md`](DEPLOY-FLY.md).

Outras hospedagens:

Qualquer hospedagem com Node 22 (Render, Railway, Fly.io, VPS com Nginx):

- Use **HTTPS**.
- `.env` de produção: `NODE_ENV=production`, `URL_PUBLICA=https://...`, `CONFIAR_PROXY=true` se estiver atrás de proxy.
- A pasta `data/` guarda o banco **e as fotos**: ela precisa ser **persistente** e ter **backup**.
- Rode **um único processo** do servidor (os limites de tentativas ficam na memória). Para uma loja, é o suficiente.
- Imprima um QR code com o endereço do site e cole nas mesas.

## Estrutura

```
src/server.js       rotas da API (público, cozinha, admin), segurança, tempo real
src/db.js           tabelas, migrações e cardápio inicial
src/pagamentos.js   Mercado Pago: Pix, cartão, webhook
src/auth.js         login e sessões
public/             cardápio, pedido, cozinha e admin (HTML/CSS/JS)
tests/              testes automáticos (npm test)
Dockerfile, fly.toml  publicação no Fly.io (veja DEPLOY-FLY.md)
data/               banco de dados e fotos (criado ao rodar)
```
