# Publicar a Açaí Mix no Fly.io

Tempo: uns 15 minutos. Custo aproximado: **US$ 2 a 3 por mês** (1 máquina pequena + 1 GB de disco). O Fly.io pede cartão de crédito no cadastro.

O projeto já vem pronto para o Fly: `Dockerfile`, `fly.toml` (região **São Paulo**, `gru`), disco persistente para o banco e as fotos, HTTPS e verificação de saúde.

---

## 1. Instalar o `fly` e criar a conta

**Windows (PowerShell):**
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```
(Se `pwsh` não existir, troque por `powershell`.)

**Mac:** `brew install flyctl`  ·  **Linux:** `curl -L https://fly.io/install.sh | sh`

Feche e abra o terminal, depois:
```bash
fly auth signup      # ou: fly auth login, se já tiver conta
```

## 2. Criar o app

Abra o terminal **dentro da pasta do projeto** e escolha um nome (vira o endereço `NOME.fly.dev`):

```bash
fly apps create acai-mix-petrolina
```

Se o nome já existir, tente outro. Depois, abra o `fly.toml` e troque a linha `app = "acai-mix"` pelo nome que você criou.

## 3. Criar o disco (banco de dados + fotos)

```bash
fly volumes create acaimix_dados --region gru --size 1
```

Se perguntar sobre ter só um disco ("single volume"), responda **y**. Para uma loja, uma máquina basta.

## 4. Guardar as senhas (nunca vão no código)

Troque pelos seus valores (mínimo 8 caracteres cada senha):

```bash
fly secrets set ADMIN_SENHA="SuaSenhaForte123" COZINHA_SENHA="SenhaDaCozinha123" URL_PUBLICA="https://acai-mix-petrolina.fly.dev"
```

> As senhas só são usadas na **primeira vez** que o sistema liga. Depois, troque e crie senhas pelo painel `/admin › Usuários`.

## 5. Publicar

```bash
fly deploy --ha=false
```

`--ha=false` garante **uma** máquina só (o banco SQLite fica num disco único). Quando terminar:

```bash
fly open             # abre o cardápio no navegador
```

- Cardápio: `https://SEU-APP.fly.dev`
- Admin: `https://SEU-APP.fly.dev/admin` (usuário `admin`)
- Cozinha: `https://SEU-APP.fly.dev/cozinha` (usuário `cozinha`)

Pronto! Por enquanto o pagamento está em **modo de teste** (botão "Simular pagamento").

---

## 6. Ligar o Mercado Pago

1. No painel do Mercado Pago (Suas integrações › sua aplicação › **Webhooks**), cadastre:
   `https://SEU-APP.fly.dev/api/webhooks/mercadopago` com o evento **Pagamentos**.
2. Copie o **Access Token** (comece pelo de **teste**) e a **assinatura secreta** do webhook:

```bash
fly secrets set MP_ACCESS_TOKEN="TEST-..." MP_WEBHOOK_SECRET="..."
```

O Fly reinicia o app sozinho. Faça um pedido de teste com os cartões/contas de teste do Mercado Pago. Funcionou? Troque pelo token de **produção** com o mesmo comando.

---

## Dia a dia

| Para… | Comando |
|---|---|
| Publicar uma nova versão | `fly deploy` (os dados continuam lá) |
| Ver o que está acontecendo | `fly logs` |
| Ver se está no ar | `fly status` |
| Esqueci a senha do admin | `fly ssh console -C "npm run criar-usuario -- admin NovaSenha123"` |
| Usar domínio próprio | `fly certs add pedidos.acaimix.com.br` e siga as instruções de DNS |

## Backup

O Fly tira **fotos automáticas do disco todo dia** (guarda 5 dias): `fly volumes snapshots list acaimix_dados`.

Para ter uma cópia no seu computador (recomendado toda semana):

```bash
fly ssh console -C "npm run backup"
fly ssh sftp shell
# dentro do sftp:  get /data/backup-AAAA-MM-DD-HHMM.db   (use o nome que apareceu)
```

## Se algo der errado

- **"needs volumes with name acaimix_dados"**: o disco não foi criado na região `gru`. Rode o passo 3 de novo.
- **Página não abre logo após o deploy**: espere 30 segundos e veja `fly logs`.
- **Aviso "Nenhum administrador cadastrado" nos logs**: faltou o `ADMIN_SENHA` (passo 4). Depois de definir, rode `fly deploy` de novo.
- **Duas máquinas aparecendo em `fly status`**: rode `fly scale count 1`.
