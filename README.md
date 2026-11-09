# Açaí Mix 💜 · Sistema de pedidos

Cardápio online com adicionais, pagamento por Pix e cartão via **Mercado Pago**, painel da **cozinha** e painel do **administrador** para editar tudo.

- **Banco de dados e fotos:** Supabase (Postgres + Storage)
- **Site e API:** Vercel
- **Sem bibliotecas para instalar:** só Node.js 22

**Para colocar no ar, siga o [`DEPLOY.md`](DEPLOY.md).**

| Página | Endereço | Para quem |
|---|---|---|
| Cardápio e pedido | `/` | Clientes |
| Acompanhar pedido | `/pedido` | Clientes (abre sozinha após o pedido) |
| Cozinha | `/cozinha` | Equipe (login de cozinha ou admin) |
| Administrador | `/admin` | Dono/gerente (login de admin) |

## O que o administrador pode fazer

- **Resumo**: faturamento e pedidos do dia, ticket médio, gráfico dos últimos 7 dias, mais vendidos e alertas de pagamento. Botão para **abrir e fechar a loja**.
- **Pedidos**: histórico por dia, com itens, adicionais, forma de pagamento e status.
- **Cardápio**: criar, editar, reordenar e excluir categorias e produtos; **foto** de cada produto (ou emoji); preço; marcar "aceita adicionais" e "mais pedido ⭐"; esconder o que acabou.
- **Adicionais**: granola, frutas, coberturas etc., com preço (0 = grátis). Liga e desliga na hora.
- **Loja**: nome, frase, aviso em destaque (promoções), WhatsApp, logo, aceitar ou não pagamento no balcão.
- **Usuários**: logins da equipe (cozinha ou admin), troca de senhas e **atividade recente** (quem mudou preço, quem cancelou pedido, logins recusados).

A **cozinha** vê os pedidos novos em até 4 segundos, com som, e pode desligar produtos e adicionais que acabaram ("Acabou algo?").

## Rodar no computador

1. Crie o projeto no Supabase e rode o `supabase/schema.sql` (passo 1 do [`DEPLOY.md`](DEPLOY.md)).
2. Copie `.env.example` para `.env` e preencha `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_SENHA` e `COZINHA_SENHA`.
3. Rode `npm run dev` e abra http://localhost:3000

Sem as chaves do Mercado Pago, o sistema roda em **modo de teste**, com um botão "Simular pagamento aprovado".

| Comando | Para quê |
|---|---|
| `npm run dev` | roda o sistema no computador |
| `npm test` | 31 testes automáticos (precisa de um Postgres; veja abaixo) |
| `npm run backup` | baixa uma cópia dos dados (JSON) para a pasta `backups/` |
| `npm run criar-usuario -- admin NovaSenha123` | cria ou troca a senha de um usuário |

## Segurança

- **Preços calculados dentro do banco**: o navegador manda só o produto e a quantidade, nunca o valor.
- **Tabelas num schema privado**, com RLS ligado, que a API pública do Supabase não enxerga. Só a **chave secreta** executa as funções do sistema; a chave pública não acessa nada.
- Dados de cartão **nunca passam pelo seu servidor** (Checkout Pro do Mercado Pago).
- Webhook com **assinatura conferida**; o pagamento é **confirmado na API** e o **valor é comparado** com o pedido antes de ir para a cozinha.
- Senhas com **scrypt**; sessão em cookie `HttpOnly` + `SameSite=Strict` + `Secure`; **dois níveis de acesso** (a cozinha não entra no admin).
- Proteção contra **CSRF** (SameSite + Origin + Sec-Fetch-Site), **XSS** (CSP estrita, sem `innerHTML` com dados do usuário) e **força bruta** (10 tentativas de login a cada 15 minutos por IP, contadas no banco).
- Fotos: só JPG, PNG ou WEBP, **conferidas pelo conteúdo do arquivo**, com nome aleatório.
- **Zero dependências** de terceiros.

## Privacidade (LGPD)

- Dados do cliente: só o nome é obrigatório; WhatsApp e e-mail são opcionais. A cozinha vê só o nome.
- Depois de `RETENCAO_DIAS` (padrão 180), a limpeza diária apaga nome, telefone e e-mail dos pedidos antigos. Os números de vendas continuam nos relatórios.
- Pedidos não pagos são cancelados depois de 2 horas (o Pix e o link do cartão vencem em 30 minutos).

## Testes automáticos

Os testes rodam o `schema.sql` num Postgres **de verdade** e imitam a API do Supabase, conferindo inclusive as permissões do banco. No GitHub, eles rodam sozinhos a cada envio (aba **Actions**). Para rodar no seu computador, você precisa de um Postgres e do `psql`:

```bash
PG_TESTE="postgresql://postgres:senha@localhost:5432/postgres" npm test
```

## Estrutura

```
supabase/schema.sql   banco: tabelas, regras, funções, permissões, cardápio inicial
api/index.js          função da Vercel (recebe /api/*)
vercel.json           rotas, cabeçalhos de segurança, região São Paulo, cron diário
src/app.js            rotas da API (público, cozinha, admin)
src/supabase.js       acesso ao banco e às fotos
src/pagamentos.js     Mercado Pago: Pix, cartão, webhook
src/auth.js           senhas e sessões
src/local.js          servidor para rodar no computador
public/               cardápio, pedido, cozinha e admin (HTML/CSS/JS)
tests/                testes automáticos
```
