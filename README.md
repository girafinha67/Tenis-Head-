# Tênis Head — site + painel administrativo

Landing page e catálogo da Tênis Head (São Luís — MA), com painel de
administração para cadastrar produtos de verdade (sem produtos fictícios
no código). Backend em Node/Express rodando como Netlify Function, com
Postgres (Supabase) como banco de dados.

## Estrutura

```
public/
  index.html          → home (busca produtos em /api/products)
  catalogo.html        → catálogo completo, com filtro por categoria
  admin/                → painel administrativo (login, produtos, categorias, analytics)
  js/, css/, assets/    → scripts e estilos do site e do admin
netlify/
  functions/api.js      → função serverless única que expõe toda a API em /api/*
  functions/lib/         → banco de dados, autenticação, upload de imagens, analytics
  functions/routes/      → rotas (produtos, categorias, auth, uploads, analytics)
netlify.toml
package.json
```

O design da home e do catálogo (preto e branco, tipografia Space Grotesk/Inter)
não foi alterado — só a origem dos produtos, que agora vem do banco em vez de
estar fixa no HTML.

## 1. Banco de dados (Supabase)

1. Crie um projeto gratuito em https://supabase.com.
2. Em **Project Settings → Database**, copie a "Connection string" no modo
   *Connection pooling* (porta 6543). Essa é a variável `SUPABASE_DB_POOLER_URL`.
3. Em **Project Settings → API**, copie a `Project URL` (→ `SUPABASE_URL`) e a
   `service_role` key (→ `SUPABASE_SERVICE_ROLE_KEY`) — usada só pelo backend
   para o upload de imagens.
4. Em **Storage**, crie um bucket público chamado `rshoes-images`.

O schema (tabelas de produtos, categorias, admins, sessões, analytics) é
criado sozinho na primeira requisição — não é preciso rodar nenhum SQL manual.

## 2. Variáveis de ambiente (Netlify → Site settings → Environment variables)

| Variável | Para quê |
|---|---|
| `SUPABASE_DB_POOLER_URL` | conexão do backend com o Postgres |
| `SUPABASE_URL` | URL do projeto Supabase (upload de imagens) |
| `SUPABASE_SERVICE_ROLE_KEY` | chave de serviço do Supabase (upload de imagens) |
| `ADMIN_EMAIL` | e-mail do administrador do painel |
| `ADMIN_PASSWORD` | senha do administrador do painel |

O admin é criado/atualizado automaticamente a partir de `ADMIN_EMAIL` /
`ADMIN_PASSWORD` — não existe usuário nem senha padrão no código.

## 3. Deploy

1. Suba esta pasta para um repositório Git (GitHub/GitLab) ou arraste o
   projeto direto no Netlify (Sites → "Add new site" → "Deploy manually").
2. Configure as variáveis de ambiente acima.
3. O `netlify.toml` já define o build (`npm install`), a pasta publicada
   (`public`) e o redirecionamento de `/api/*` para a function.

Depois do deploy:

- Site: `https://SEU-SITE.netlify.app/`
- Catálogo: `https://SEU-SITE.netlify.app/catalogo.html`
- Painel admin: `https://SEU-SITE.netlify.app/admin/` (faça login com
  `ADMIN_EMAIL` / `ADMIN_PASSWORD`)

## 4. Cadastrando produtos

No painel (`/admin/produtos.html`) você cadastra nome, preço, preço
promocional, estoque, imagens e categorias (Low, High, Slip-on, Skate,
Edição Limitada, Acessórios). Assim que um produto é salvo como ativo, ele
aparece automaticamente:

- na home, na seção "Latest Drops" (6 mais recentes);
- na home, na seção de destaque, se marcado como **featured**;
- no catálogo completo, já filtrável por categoria.

Não há nenhum produto de exemplo no código — o site começa vazio até você
cadastrar o primeiro produto pelo painel.

## 5. Rodando localmente (opcional)

```bash
npm install -g netlify-cli
npm install
netlify dev
```

O `netlify dev` sobe o site e as functions juntos em `http://localhost:8888`,
usando as mesmas variáveis de ambiente (pode criar um arquivo `.env` local).

## 6. Pagamento PIX real via Mercado Pago + WhatsApp

Documentação oficial: https://www.mercadopago.com.br/developers/pt/reference (base `https://api.mercadopago.com`).

### Fluxo

```text
Cliente escolhe produto/carrinho e preenche os dados (e-mail é obrigatório)
  ↓  POST /api/payments/pix/create  (preço e estoque recalculados no servidor)
Pedido PENDING, estoque reservado
  ↓  POST https://api.mercadopago.com/v1/payments  { payment_method_id: "pix", transaction_amount, payer, external_reference }
     — só pelo backend, Access Token no servidor, X-Idempotency-Key = id do pedido
Cobrança real: id, qr_code (copia e cola), qr_code_base64, date_of_expiration  →  gravados no pedido (orders.mp_id)

Mercado Pago → POST /.netlify/functions/mercadopago-webhook?data.id=<id>&type=payment
  ↓  valida x-signature (HMAC-SHA256 do manifest id;request-id;ts) — senão 401
  ↓  consulta GET /v1/payments/<id> (fonte de verdade), confere valor e forma de pagamento
  ↓  approved → pedido PAID + WhatsApp ao dono | rejected/cancelled → pedido FAILED e estoque devolvido
```

A tela do checkout consulta `/api/payments/orders/:id`; se o pedido ainda está pendente, o servidor reconfirma
na API do Mercado Pago (no máximo 1 consulta a cada 10 s por pedido). A função agendada `reconcile-payments`
(a cada 10 min) é a rede de segurança caso algum webhook se perca.

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Access Token de **produção** (Mercado Pago → Suas integrações → Credenciais de produção) |
| `MERCADOPAGO_WEBHOOK_SECRET` | chave secreta do webhook (Suas integrações → Webhooks); valida o `x-signature` |
| `MERCADOPAGO_NOTIFICATION_URL` | `https://SEU-SITE.netlify.app/.netlify/functions/mercadopago-webhook` (enviada em cada cobrança) |
| `MERCADOPAGO_PIX_EXPIRATION_MINUTES` | opcional; validade do PIX (padrão `30`) |
| `MERCADOPAGO_BASE_URL` | opcional; padrão `https://api.mercadopago.com` (HTTPS obrigatório) |
| `MERCADOPAGO_TIMEOUT_MS` | opcional; padrão `8000` |

### Configurar o webhook

1. Mercado Pago → Suas integrações → sua aplicação → **Webhooks** → Configurar notificações.
2. URL de produção: `https://SEU-SITE.netlify.app/.netlify/functions/mercadopago-webhook`
   (arquivo `netlify/functions/mercadopago-webhook.js`). Evento: **Pagamentos**.
3. Copie a **chave secreta** exibida para `MERCADOPAGO_WEBHOOK_SECRET` no Netlify.

### Migração do banco

Nada a fazer: `netlify/functions/lib/db.js` renomeia sozinho as colunas antigas (`promisse_*` → `mp_*`) e cria as
novas. O mesmo SQL está em `migrations/2026-10-10_mercadopago.sql`, caso prefira rodar manualmente no Supabase.
Pedidos antigos continuam intactos; cobranças PIX do provedor anterior ainda pendentes não são reconsultadas.

### Testes

`npm test` roda 61 testes automatizados com fakes (sem rede, sem banco e sem pagamento real).

## Cupons de desconto

Painel → **Cupons** (`/admin/cupons.html`). Tudo vale no site em tempo real: o checkout consulta o servidor a cada tentativa.

**Opções de cada cupom:** código (só letras e números, 3–32, sem diferenciar maiúsculas), descrição interna, tipo (% ou R$ fixo),
desconto máximo (para %), pedido mínimo, início e fim da validade (com atalhos de duração), limite total de usos,
limite por cliente (CPF/e-mail), só primeira compra, valer ou não em produtos já em promoção, escopo
(todos / produtos específicos / categorias específicas) e ativo/pausado. A lista mostra status (ativo, agendado, expirado,
esgotado, pausado), usos, desconto concedido e vendas; permite editar, duplicar, pausar, ver os pedidos que usaram e excluir
(só se nunca foi usado).

**Como funciona (servidor):** `POST /api/coupons/validate` calcula o desconto com preços do banco (limitado a 20 tentativas/10 min por IP).
Ao criar o pedido o desconto é recalculado dentro da transação, com a linha do cupom travada (limites de uso não estouram com
pedidos simultâneos), o uso é **reservado** e o valor do PIX já sai com desconto. Pedido expirado/falho devolve o uso; pagamento
confirmado torna o uso definitivo. O PIX nunca cobra menos de R$ 0,50 (o desconto é limitado a isso).

SQL: `migrations/2026-10-13_cupons.sql` (o app também aplica sozinho).

## Configurações da loja

Painel → **Configurações** (`/admin/configuracoes.html`): vendas abertas/pausadas (+ mensagem), pedido mínimo, máximo de unidades
por produto, aviso no checkout, cupons ligados/desligados, pontos por real, aviso global no topo do site (texto, link, cores),
WhatsApp/Instagram/e-mail/horário no rodapé, nome da loja, descrição do rodapé e título/descrição da home para o Google.
As regras de checkout são aplicadas no servidor; o restante é aplicado no site a cada visita (`/api/settings/site`).

## Feedbacks de clientes

- Seção "Quem comprou, aprovou" na home (entre os benefícios e o "Sobre"). O cliente envia foto ou vídeo com nome completo, produto e data da compra.
- O arquivo vai direto do navegador para o Supabase Storage (URL assinada gerada em `POST /api/feedbacks/upload-url`), no bucket público `rshoes-feedbacks`, criado automaticamente no primeiro envio. Precisa de `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
- Limites: foto até 8 MB, vídeo até 50 MB (o plano do Supabase também precisa permitir esse tamanho).
- Todo envio entra como `pending`. A moderação fica em `/admin/feedbacks.html` (aprovar, rejeitar, excluir). No site aparece só "Nome S.", o nome completo fica apenas no painel.
- A tabela `feedbacks` é criada sozinha no `db.init()`.

## Banco compartilhado com outro projeto (DB_SCHEMA)

Se o Supabase já tiver tabelas de outro site (ex.: `products` sem a coluna `brand`), defina `DB_SCHEMA=tenishead_loja` no Netlify. Todas as tabelas desta loja passam a ser criadas nesse schema, sem mexer nas do outro projeto. Requer o pooler na porta 5432 (modo sessão). Sem `DB_SCHEMA`, as tabelas ficam em `public`.


## 7. Painel admin no celular

O painel (`/admin/*`) é responsivo (`public/css/admin-mobile.css` + `public/js/admin-common.js`):

- até 860px: o menu lateral vira uma gaveta aberta pelo botão ☰ na barra do topo;
- até 640px: as tabelas viram cards (o rótulo de cada campo vem do `<th>`), os
  formulários abrem como *bottom sheet* com o botão Salvar fixo embaixo, e os
  campos usam fonte de 16px para o iOS não dar zoom ao digitar;
- acima de 860px o layout de desktop continua igual.

## 8. Categorias: como o catálogo encontra o produto

O formulário de produto grava a categoria em `products.category_tags`
(slugs `low`, `high`, `slip-on`, `skate`, `edicao-limitada`, `vans`), enquanto os
filtros do catálogo e os cards da home usam os slugs da tabela `categories`
(`nike`, `adidas`, `new-balance`, `infantis`, `linha-premium`, `vans`).
`CATEGORY_SLUG_TO_TAG` em `netlify/functions/lib/category-tags.js` liga os dois, e
`GET /api/products?category=...` procura por `category_id` **ou** pela tag. Se
você criar uma categoria nova, adicione o par nesse mapa e em `category-tags.js`
(front e back).
