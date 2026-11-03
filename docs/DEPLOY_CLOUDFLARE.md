# Deploy na Cloudflare (Workers + OpenNext)

O CRM roda como **um Cloudflare Worker** gerado pelo adaptador oficial [OpenNext](https://opennext.js.org/cloudflare) a partir do build do Next.js. O banco continua sendo o **PostgreSQL do Supabase**, acessado pelo **Hyperdrive** (pool de conexões da Cloudflare).

```
Navegador ──► Worker "crmedasi" (Next.js via OpenNext)
                 │  binding HYPERDRIVE
                 ▼
              Hyperdrive (pool, cache DESLIGADO) ──► Supabase (Session pooler, 5432)
```

## 1. Pré-requisitos

| Item | Por quê |
|---|---|
| Conta Cloudflare com **Workers Paid** (US$ 5/mês) | O login usa `scrypt` (N=32768), que gasta dezenas de milissegundos de CPU por tentativa; o plano gratuito limita a 10 ms de CPU por requisição. O pacote (1,8 MB gzip) caberia no gratuito, a CPU do login não. |
| Migrations 001–009 executadas no Supabase | O deploy não altera o schema (regra do projeto). **Execute a 009 antes de publicar o código que a usa**: sem ela, o login e outras operações falham (lista abaixo). No Supabase de produção da EDASI, 001–009 já foram executadas manualmente. |
| Build em **Linux** (Workers Builds, GitHub Actions ou WSL) ou em cópia limpa | O OpenNext cria *symlinks* no build; no Windows sem Modo de Desenvolvedor o build falha com `EPERM`. |
| **Nenhum `.env` na pasta do build** | O OpenNext embute o conteúdo dele no Worker. Veja a seção 4. |

### O que depende da migration 009

O código usa a tabela `rate_limit_buckets`. Sem ela, estas operações terminam em erro, porque a consulta à tabela falha (`42P01`):

| Quem | Operação |
|---|---|
| Todos os perfis | **Login** e troca da própria senha (tela Perfil) |
| SELLER | Cadastrar lead e alterar o telefone de um lead |
| ADMIN | Redefinir senha, alterar e-mail, criar ADMIN e ativar ou desativar ADMIN |

Continuam funcionando sem a tabela: sessões já abertas, cadastro de lead por SUPERVISOR e ADMIN, edição de lead pelo SELLER sem mudar o telefone, alteração só do nome do usuário, e criação e ativação de usuários que não são ADMIN.

A 009 só cria a tabela nova, sem alterar objetos existentes, então a versão já publicada continua funcionando depois dela. A ordem é sempre: **executar a 009, conferir, e só então publicar**. No Supabase de produção da EDASI ela já foi executada manualmente e conferida: não a execute de novo (uma segunda execução é recusada, sem efeito).

## 2. Variáveis e secrets

### No Worker (Cloudflare › Workers › crmedasi › Settings)

| Nome | Tipo | Valor | Onde fica |
|---|---|---|---|
| `HYPERDRIVE` | **Binding** Hyperdrive | id da configuração criada no passo 3 | `wrangler.jsonc` (o id não é segredo; a senha fica no Hyperdrive) |
| `SESSION_TTL_HOURS` | Variável (texto) | `12` | `wrangler.jsonc` › `vars` |
| `DATABASE_URL` | **Secret** — *somente se NÃO usar Hyperdrive* | connection string do Supabase com `?sslmode=require` | `npx wrangler secret put DATABASE_URL` |

Com Hyperdrive (recomendado) **não há nenhum secret no Worker**: a senha do banco fica guardada na configuração do Hyperdrive. Sem Hyperdrive, cada consulta abriria uma conexão TLS nova até o Supabase (lento).

Não configure no Worker: `SEED_PASSWORD` (só banco local) nem `NODE_ENV` (o build já é de produção; o cookie de sessão sai `Secure; HttpOnly; SameSite=lax`).

### No build (Workers Builds › Settings › Build › Variables)

Nenhuma variável é obrigatória: o build não acessa o banco. Opcional: `NODE_VERSION=22`.

## 3. Hyperdrive (uma vez)

1. No Supabase: **Connect › Session pooler** (porta **5432**, IPv4). Copie a connection string com a senha do banco.
2. Crie a configuração **com cache desligado**:

   ```bash
   npx wrangler hyperdrive create crm-edasi-db --connection-string="postgresql://postgres.<ref>:<SENHA>@aws-0-<região>.pooler.supabase.com:5432/postgres" --caching-disabled
   ```

   > **Cache desligado é obrigatório.** O Hyperdrive guarda resultados de `SELECT` por até 60 s; com cache, uma sessão revogada, um usuário desativado ou uma troca de equipe poderiam continuar valendo por esse tempo, e telas mostrariam dados antigos.

3. Copie o `id` retornado para `wrangler.jsonc` › `hyperdrive[0].id` (substituindo `COLE_AQUI_O_ID_DO_HYPERDRIVE`) e faça commit.

## 4. Deploy

> **Nunca rode o build na pasta onde está o seu `.env`.** O `opennextjs-cloudflare build` lê `.env`, `.env.local` e variantes e grava os valores em `.open-next/cloudflare/next-env.mjs`, que vai para o bundle do Worker em texto puro, inclusive a senha do banco. O `next build` também copia o `.env` para `.next/standalone`.
>
> `scripts/cf-guard.mjs` bloqueia isso em dois pontos:
> - **`preflight`** (em `npm run cf:build`): recusa a pasta se houver `.env` com variáveis privadas.
> - **`verify`** (ao fim do `cf:build` e em todo `wrangler deploy`, pelo `build.command` do `wrangler.jsonc`): recusa o artefato se encontrar variáveis em `next-env.mjs`, arquivos `.env`, connection strings ou os valores do `.env` local. Mostra só nomes, nunca valores.
>
> Use sempre `npm run cf:build` e `npm run cf:deploy`. Chamar `opennextjs-cloudflare build` direto pula o `preflight`, e `--no-build` no wrangler pula o `verify`: não faça isso.

### Opção A — Workers Builds (Git, recomendado)

Cloudflare › Workers & Pages › Create › Import a repository, e configure:

| Campo | Valor |
|---|---|
| Build command | `npm run cf:build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

A cada push na branch configurada, a Cloudflare compila em Linux e publica.

> **Hyperdrive no deploy.** `wrangler deploy` detecta o projeto OpenNext e chama `opennextjs-cloudflare deploy`, que monta um proxy local dos bindings antes de publicar. Sem um endereço local para o Hyperdrive, falha com `When developing locally, you should use a local Postgres connection string to emulate Hyperdrive`. Por isso o `wrangler.jsonc` tem um `localConnectionString` **fictício** (sem senha, nunca usado em produção nem conectado no deploy). Não remova.

### Opção B — Linha de comando, sempre em cópia limpa

Uma cópia feita com `git archive` não leva o `.env` (Linux/macOS/WSL):

```bash
mkdir ../crmedasi-build && git archive HEAD | tar -x -C ../crmedasi-build
cd ../crmedasi-build
npm ci                 # aplica também o patch em patches/ (postinstall)
npx wrangler login
npm run cf:deploy      # guarda + build + guarda + deploy
```

### Conferir um Worker já publicado, sem expor segredos

Na pasta do projeto, rode o trecho abaixo. Ele baixa o script da versão ativa e informa só `true` ou `false`; o token e os valores nunca são impressos, e a cópia baixada fica só na memória.

```bash
node --input-type=module <<'EOF'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const run = (...args) => execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], { encoding: "utf8" });
const token = JSON.parse(run("auth", "token", "--json").replace(/^[^{]*/, "")).token;
const api = (p) => fetch("https://api.cloudflare.com/client/v4" + p, { headers: { Authorization: "Bearer " + token } });
const account = (await (await api("/accounts?per_page=1")).json()).result[0].id;
const text = Buffer.from(await (await api("/accounts/" + account + "/workers/scripts/crmedasi")).arrayBuffer()).toString("latin1");
const url = new URL(readFileSync(".env", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim());
console.log({
  urlDoEnv: text.includes(url.href),
  senhaDoEnv: text.includes(decodeURIComponent(url.password)),
  hostDoEnv: text.includes(url.hostname),
  poolerSupabase: /pooler\.supabase/.test(text),
  variavelSeed: /SEED_PASSWORD/.test(text),
});
EOF
```

Tudo precisa dar `false`. Se algum der `true`, **troque a senha do banco no Supabase imediatamente**, atualize o Hyperdrive e publique um build limpo.

### Primeiro administrador

Continua sendo criado pelo terminal, apontando o `.env` local para o Supabase: `npm run admin:create` (ver README).

## 5. Preview local (opcional)

Roda o Worker no runtime da Cloudflare (`workerd`) contra um **Postgres local** (nunca o Supabase):

```bash
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://postgres:senha@127.0.0.1:5432/crm_local"
npm run cf:preview
```

## 6. O que foi adaptado no código

| Arquivo | Mudança |
|---|---|
| `wrangler.jsonc`, `open-next.config.ts` | Configuração do Worker (nodejs_compat, assets, Hyperdrive); sem cache incremental (todas as telas são dinâmicas) |
| `src/server/db/client.ts` | No Workers, **uma conexão por requisição** (sockets não podem ser reaproveitados entre requisições), vinda do binding `HYPERDRIVE`; em `next dev`/`next start`/scripts, igual a antes |
| `src/server/db/connect.ts` | Pool por requisição (`maxUses: 1`) e tratamento de erro de conexão ociosa (sem ele, um erro do pool vira exceção não tratada — também no Node) |
| `next.config.ts` + `src/server/db/pglite-unavailable.ts` | No build da Cloudflare o PGlite (WASM) sai do pacote e o `pg-cloudflare` (sockets do Workers) entra |
| `patches/@opennextjs+cloudflare+1.20.11.patch` | Correção do bug [opennextjs-cloudflare#1355](https://github.com/opennextjs/opennextjs-cloudflare/issues/1355) (Next 16.4 + `preview-props.json` → erro 500 em toda rota). É o mesmo ajuste do PR #1356. **Remover** (junto do `postinstall`/`patch-package`) quando sair a versão do adaptador com a correção |

## 7. Validação feita (local, runtime `workerd`, Postgres 17 local via Hyperdrive local)

- Login com senha errada recusado; com senha certa: 303 + cookie `Secure; HttpOnly; SameSite=lax` (o `scrypt` funciona no Workers).
- `/`, `/leads`, `/kanban`, `/usuarios`, `/equipes`, `/cursos`, `/auditoria` → 200 com o usuário logado; sem cookie → redirect para `/login`.
- Auditoria (`auth.login`, `auth.login_failed`) e sessões gravadas no banco; nenhum erro no log do Worker.
- `wrangler deploy --dry-run`: 8,4 MB / **1,77 MB gzip**.

**Não validado aqui:** o deploy real, o Hyperdrive real com o Supabase e o tempo de CPU do login na Cloudflare (o plano Paid cobre com folga).

## 8. Pontos de atenção em produção

- **Limite de tentativas de login**, em três camadas:
  - **Binding `LOGIN_RATE_LIMITER`** (`wrangler.jsonc`): 20 tentativas por minuto por IP (IPv6 por /64), na borda, antes do banco e do scrypt. Funciona em `*.workers.dev`; o contador é por localização e aproximado.
  - **Tabela `rate_limit_buckets`** (migration 009, `src/server/auth/rate-limit.ts`): compartilhada entre instâncias. Por janela de 15 minutos: 10 falhas por e-mail + IP, 30 por conta e 100 por IP. O bloqueio **vence sozinho** e o reset de senha pelo ADMIN libera a conta; nada trava uma conta de forma permanente.
  - **WAF:** regras de Rate Limiting são por zona, e `*.workers.dev` não tem zona. **Só valem depois de ligar um domínio próprio** (abaixo).
- **IP confiável:** vem de `CF-Connecting-IP`, preenchido pela Cloudflare (`src/server/auth/client-ip.ts`). Sem esse cabeçalho o IP fica desconhecido: `X-Forwarded-For` (cujo primeiro valor é enviado pelo cliente) e `X-Real-IP` só são lidos com `NODE_ENV` `development` (`next dev`) ou `test`. Em qualquer build de produção (o Worker, `cf:preview`, `next start`) eles são ignorados.
- **Regra de WAF, ao usar domínio próprio:** Cloudflare › seu domínio › Security › WAF › Rate limiting rules › Create rule:
  - *Expression:* `(http.request.method eq "POST" and http.request.uri.path eq "/login")`
  - *Characteristics:* IP
  - *Requests / Period:* 20 por 1 minuto
  - *Action:* Block, por 10 minutos (o plano gratuito pode limitar período e duração; use os valores disponíveis)
- **Domínio próprio:** Workers › Settings › Domains & Routes. O cookie de sessão é por host.
- **Observabilidade:** `observability.enabled` está ligado no `wrangler.jsonc` (Workers Logs).
