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

## 6. Vendas pelo WhatsApp (o site não cobra nada)

O site é uma vitrine: **não há carrinho, checkout, Pix, cartão, cupom nem pedido pelo site**. A venda é fechada na conversa.

Na página do produto o cliente escolhe a **numeração** e toca em **CHAMAR NO WHATSAPP**. Abre o chat com a loja já com:

```text
O <modelo do tênis> da numeração <numeração> ainda está disponível em estoque?

<endereço da foto que está sendo exibida no site>
```

- A numeração é obrigatória (se o produto tem tamanhos cadastrados); sem ela o botão avisa o cliente e não abre o chat.
- A foto é a que estava aparecendo na galeria no momento do clique. O link `wa.me` não permite anexar arquivo,
  então a foto vai como endereço completo (https://...) e o WhatsApp mostra a prévia da imagem na conversa.
- O número da loja vem do painel: **Configurações → WhatsApp (com DDD)**. Sem número preenchido o botão avisa em vez de abrir um link quebrado.
- Cada clique é contado em Analytics ("Cliques WhatsApp").
- Código: `public/js/whatsapp-link.js` (mensagem/link) e o final de `public/produto.html`.

As tabelas antigas de pedidos/cupons continuam no banco (nada foi apagado), mas nenhuma rota do site usa mais essas tabelas.

### Testes

`npm test` roda 20 testes (sem rede e sem banco): mensagem e link do WhatsApp, página do produto com DOM simulado
e verificação de que não sobrou nada de pagamento no site.

## Configurações da loja

Painel → **Configurações** (`/admin/configuracoes.html`): aviso global no topo do site (texto, link, cores),
**WhatsApp** (usado no botão "Chamar no WhatsApp")/Instagram/e-mail/horário no rodapé, nome da loja, descrição do rodapé
e título/descrição da home para o Google. Aplicado no site a cada visita (`/api/settings/site`).

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
