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

https://SEU-SITE.netlify.app/p/<produto>?i=<foto>
```

- A numeração é obrigatória (se o produto tem tamanhos cadastrados); sem ela o botão avisa o cliente e não abre o chat.
- **A foto aparece na conversa como cartão** (imagem grande + nome e preço do produto). O link `wa.me` não permite anexar
  arquivo, então o WhatsApp monta o cartão a partir do endereço `/p/<produto>`, uma página com as tags Open Graph
  (`netlify/functions/lib/share-page.js`, rota `/p/:slug` no `netlify.toml`). Quem abre o endereço vai direto para o produto.
- A foto do cartão é a que estava aparecendo na galeria no clique (`?i=` = posição da foto).
- Para o cartão sair com a foto grande, deixe as fotos dos produtos com até ~300 KB; acima disso o WhatsApp pode mostrar
  só uma miniatura ou nenhuma imagem. O upload do painel não comprime a imagem.
- O número da loja vem do painel: **Configurações → WhatsApp (com DDD)**. Sem número preenchido o botão avisa em vez de abrir um link quebrado.
- Cada clique é contado em Analytics ("Cliques WhatsApp").
- Código: `public/js/whatsapp-link.js` (mensagem/link), o final de `public/produto.html` e `lib/share-page.js` (cartão com a foto).

As tabelas antigas de pedidos/cupons continuam no banco (nada foi apagado), mas nenhuma rota do site usa mais essas tabelas.

### Testes

`npm test` roda 27 testes (sem rede e sem banco): mensagem e link do WhatsApp, página do produto com DOM simulado,
página `/p/<produto>` com a foto (Open Graph) e verificação de que não sobrou nada de pagamento no site.

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
(slugs `low`, `high`, `slip-on`, `skate`, `edicao-limitada`, `vans`, `puma`), enquanto os
filtros do catálogo e os cards da home usam os slugs da tabela `categories`
(`nike`, `adidas`, `new-balance`, `infantis`, `linha-premium`, `vans`, `puma`).
`CATEGORY_SLUG_TO_TAG` em `netlify/functions/lib/category-tags.js` liga os dois, e
`GET /api/products?category=...` procura por `category_id` **ou** pela tag. Se
você criar uma categoria nova, adicione o par nesse mapa e em `category-tags.js`
(front e back).

---

## Deploy na Vercel

O projeto roda na Vercel **sem mudar nada de design ou funcionalidade**: o site estático continua na pasta `public/` e a API é o mesmo app Express (`netlify/functions/api.js`), servido pela função `api/index.js`. O `netlify.toml` continua no projeto, então o deploy no Netlify também segue funcionando.

1. Suba o projeto para o GitHub e, na Vercel, use **Add New > Project** e importe o repositório. Não precisa mudar Framework Preset, Build Command ou Output Directory: o `vercel.json` já define tudo.
2. Em **Settings > Environment Variables**, cadastre as mesmas variáveis do Netlify (para Production, Preview e Development):
   `SUPABASE_DB_POOLER_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`
   (opcionais: `DB_SCHEMA`, `IPGEO_PROVIDER`, `IPGEO_API_KEY`, `ANALYTICS_RETENTION_DAYS`).
3. Faça o deploy. Depois de mudar variáveis, é preciso um novo deploy.

Diferenças importantes em relação ao Netlify:

- **Tamanho do envio:** a Vercel aceita no máximo ~4,5 MB por requisição. O painel já reduz as fotos (máx. 1600px) antes de enviar, então fotos de celular passam normalmente.
- **Prévia do WhatsApp (`/p/<slug>`):** a foto do cartão é redimensionada pelo `/_vercel/image` (configurado em `vercel.json > images`, liberado para `*.supabase.co`).
- **Rotas:** `/api/*` e `/p/:slug` são reescritas para `api/index.js`; `/admin` redireciona para `/admin/`; URLs sem `.html` (ex.: `/catalogo`) funcionam por `cleanUrls`.
- **Vercel Web Analytics:** as páginas públicas (`index`, `catalogo`, `produto`, `favoritos`) carregam `public/js/vercel-analytics.js`, que injeta `/_vercel/insights/script.js`. Para ver os dados, ative em **Projeto > Analytics > Enable** na Vercel e faça um novo deploy. O `/admin` fica de fora de propósito, e a CSP não precisa de mudança (mesma origem). Esse painel é separado do Analytics interno do site (`admin/analytics`).
- **Fotos pelo cache da Vercel (economia de banda do Supabase):** `public/js/img-opt.js` manda as fotos do Supabase Storage por `/_vercel/image` (WebP/AVIF, redimensionadas, em cache por 30 dias, `vercel.json > images`). O Supabase só é consultado na primeira vez de cada foto. Fora da Vercel (localhost, `netlify.app`) a foto original é usada, e se a versão otimizada falhar a página volta sozinha para a original. Ao criar telas novas com foto de produto, use `thImg(url, largura)` (larguras: 256, 640, 700, 1080 ou 1920).
- **Upload de fotos no painel:** `admin-produtos.js` reduz cada foto (acima de 150 KB) para no máximo 1200px e WebP 82% antes de enviar ao Supabase, para gastar menos banda e espaço.

---

## Migrar para outra conta do Supabase (ou outro banco)

O script `scripts/migrar-supabase.js` copia produtos, categorias, configurações, depoimentos, cupons e pedidos, baixa cada foto do Supabase antigo, envia para o novo e troca os links no banco novo. O login do painel (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) não é copiado: ele é criado de novo a partir das variáveis.

1. Crie o projeto novo (outra conta do Supabase, ou um Postgres como o Neon + um projeto Supabase só para as fotos). No Supabase novo, pegue a `service_role` key e a Project URL (Project Settings > API) e a connection string do **Session pooler**, porta 5432 (Project Settings > Database).
2. No computador, com Node 22 instalado, rode `npm install` na pasta do projeto e crie o arquivo `.env.migracao` (não suba para o GitHub; ele já é ignorado):

```
OLD_DB_URL=postgresql://...  (Session pooler do Supabase antigo)
OLD_SUPABASE_URL=https://xxxx.supabase.co
NEW_DB_URL=postgresql://...  (Session pooler do banco novo)
NEW_SUPABASE_URL=https://yyyy.supabase.co
NEW_SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_EMAIL=seu@email.com
ADMIN_PASSWORD=sua-senha
```

3. Teste sem alterar nada: `node scripts/migrar-supabase.js --simular` (mostra quantas linhas e fotos seriam copiadas).
4. Migre: `node scripts/migrar-supabase.js`. Se o banco novo já tiver produtos (ou o site já tiver rodado nele), use `--substituir`, que apaga as tabelas da loja no destino antes de copiar. Use `--analytics` para levar também o histórico do Analytics.
5. Na Vercel, troque `SUPABASE_DB_POOLER_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` pelos do projeto novo e faça um novo deploy. Confira o site e o painel.

Fotos que não puderem ser baixadas ficam com o link antigo e aparecem numa lista no final; reenvie essas pelo painel. O script não apaga nada na conta antiga.

