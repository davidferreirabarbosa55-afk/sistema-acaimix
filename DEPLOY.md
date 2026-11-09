# Publicar a Açaí Mix: Supabase + Vercel

Tempo: uns 20 minutos. Você vai precisar de uma conta no **Supabase**, uma na **Vercel** (entre com o GitHub) e do repositório `sistema-acaimix` no GitHub.

> **Custos:** o plano grátis da Vercel (Hobby) é só para uso **pessoal e não comercial**. Uma lanchonete vendendo é uso comercial, então o plano correto é o **Pro (US$ 20/mês)**. O Supabase grátis serve para começar: ele só pausa projetos sem movimento por 7 dias, e não tem backup automático (use `npm run backup`). O Supabase Pro custa US$ 25/mês.

---

## 1. Supabase: criar o banco

1. Em https://supabase.com, clique em **New project**.
   - Nome: `acaimix`
   - Senha do banco: gere uma forte e guarde (não será usada no sistema, mas guarde)
   - **Region: South America (São Paulo)**
2. Quando o projeto ficar pronto, abra **SQL Editor › New query**.
3. Abra o arquivo [`supabase/schema.sql`](supabase/schema.sql), copie **todo** o conteúdo, cole no editor e clique em **Run**.
   Deve aparecer "Success. No rows returned". Isso cria as tabelas, o cardápio inicial, as regras e a pasta de fotos.
4. Vá em **Project Settings › API Keys** e anote:
   - **Project URL** (algo como `https://abcdxyz.supabase.co`)
   - Uma **Secret key** (começa com `sb_secret_`). Se não houver, clique em **Create new API key › Secret** e dê o nome `vercel`.

> ⚠️ A chave secreta dá acesso total ao banco. Ela só vai nas variáveis da Vercel e no seu `.env`. Nunca no código, no GitHub ou no WhatsApp.

## 2. Vercel: publicar o site

1. Em https://vercel.com, clique em **Add New › Project** e importe o repositório **sistema-acaimix**.
2. Na tela de configuração:
   - **Framework Preset:** `Other`
   - **Build Command:** deixe vazio
   - **Output Directory:** `public`
3. Abra **Environment Variables** e cadastre:

| Nome | Valor |
|---|---|
| `SUPABASE_URL` | a Project URL do passo 1 |
| `SUPABASE_SECRET_KEY` | a chave `sb_secret_...` |
| `ADMIN_SENHA` | senha do administrador (mín. 8 caracteres) |
| `COZINHA_SENHA` | senha da cozinha (mín. 8 caracteres) |
| `CRON_SECRET` | 20+ letras e números aleatórios (protege a limpeza diária) |

4. Clique em **Deploy**. Em 1 a 2 minutos o site está no ar em `https://sistema-acaimix.vercel.app` (ou parecido).

Teste:
- Cardápio: `https://SEU-SITE.vercel.app`
- Admin: `https://SEU-SITE.vercel.app/admin` (usuário `admin`)
- Cozinha: `https://SEU-SITE.vercel.app/cozinha` (usuário `cozinha`)

O pagamento começa em **modo de teste** (botão "Simular pagamento"). Faça um pedido e veja-o chegar na cozinha.

> As senhas `ADMIN_SENHA` e `COZINHA_SENHA` só são usadas no **primeiro login**, para criar os usuários. Depois, troque senhas e crie usuários pelo painel em `/admin › Usuários`.

## 3. Ligar o Mercado Pago

1. No Mercado Pago (Suas integrações › sua aplicação › **Webhooks**), cadastre a URL
   `https://SEU-SITE.vercel.app/api/webhooks/mercadopago` com o evento **Pagamentos**.
2. Na Vercel (**Settings › Environment Variables**), adicione:
   - `MP_ACCESS_TOKEN`: comece pelo token de **teste**
   - `MP_WEBHOOK_SECRET`: a assinatura secreta do webhook
3. Em **Deployments**, clique nos três pontinhos do último deploy e em **Redeploy**. As variáveis só valem depois de um novo deploy.
4. Faça um pedido com os cartões e contas de teste do Mercado Pago. Funcionou? Troque pelo token de **produção** e faça Redeploy de novo.

---

## Dia a dia

- **Publicar mudanças:** é só enviar para o GitHub (`git push`). A Vercel publica sozinha em 1 a 2 minutos.
- **Mudança no banco** (quando o `schema.sql` mudar): cole o arquivo de novo no SQL Editor e clique em Run. Ele não apaga dados.
- **Ver erros:** Vercel › seu projeto › **Logs**.
- **Domínio próprio** (ex.: `pedidos.acaimix.com.br`): Vercel › Settings › **Domains**.
- **Limpeza diária:** a Vercel roda `/api/cron/manutencao` uma vez por dia. Ela apaga dados pessoais antigos (LGPD), cancela pedidos que não foram pagos e remove sessões vencidas.

## Backup e senha esquecida (no seu computador)

Crie um arquivo `.env` (copie de `.env.example`) com `SUPABASE_URL` e `SUPABASE_SECRET_KEY`, e então:

```bash
npm run backup                                   # salva backups/acaimix-AAAA-MM-DD-HHMM.json
npm run criar-usuario -- admin NovaSenha123      # cria ou troca a senha do admin
npm run dev                                      # roda o sistema em http://localhost:3000
```

## Se algo der errado

- **"Não foi possível acessar o banco de dados"**: confira `SUPABASE_URL` e `SUPABASE_SECRET_KEY` na Vercel e faça Redeploy. Confirme que o `schema.sql` rodou sem erro.
- **Login não funciona na primeira vez**: faltou `ADMIN_SENHA` (com 8+ caracteres). Cadastre e faça Redeploy.
- **Fotos não aparecem**: rode o `schema.sql` de novo (ele cria a pasta `fotos` no Storage).
- **Cron com erro 401** (Settings › Cron Jobs › View Logs): confira o `CRON_SECRET` e faça Redeploy.
- **Supabase pausou o projeto** (plano grátis, 7 dias sem uso): entre no painel do Supabase e clique em **Resume project**. Os dados continuam lá.
