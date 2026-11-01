'use strict';

// Tamanhos disponíveis × esgotados: validação, grade única, linha vermelha, botão dinâmico e mensagem de encomenda.
// Sem rede e sem banco (DOM simulado, como em whatsapp.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const S = require('../public/js/tn-sizes.js');
const W = require('../public/js/whatsapp-link.js');
const B = require('../netlify/functions/lib/sizes.js');
const decode = (url) => decodeURIComponent(url.split('?text=')[1]);

// ---------- 1 e 2. salvar e validar (backend) ----------
test('normaliza listas: texto ou array, sem vazios, sem repetidos, ordem digitada preservada', () => {
  assert.deepEqual(B.normalizeSizeList('31, 32 ,, 33,32'), ['31', '32', '33']);
  assert.deepEqual(B.normalizeSizeList([' 34 ', 35, '', null, '34']), ['34', '35']);
  assert.deepEqual(B.normalizeSizeList(undefined), []);
  assert.deepEqual(B.normalizeSizeList('abc\u0000 \n'), ['abc']);
});

test('o mesmo tamanho não pode estar em disponíveis e esgotados', () => {
  assert.deepEqual(B.findConflicts(['31', '32', '34'], ['34', '35']), ['34']);
  assert.match(B.conflictMessage(['31', '34'], ['34']), /tamanho 34 não pode/);
  assert.match(B.conflictMessage(['31', '34', '35'], ['34', '35']), /tamanhos 34, 35 não podem/);
  assert.equal(B.conflictMessage(['31', '32', '33'], ['34', '35', '36']), null);
  assert.equal(B.conflictMessage(['M'], ['m']), 'O tamanho m não pode estar em "Tamanhos disponíveis" e em "Tamanhos esgotados" ao mesmo tempo.');
  assert.equal(B.conflictMessage(undefined, undefined), null);
});

test('produto antigo (sem coluna/valor inválido) lê esgotados como lista vazia', () => {
  assert.deepEqual(B.parseStoredList(undefined), []);
  assert.deepEqual(B.parseStoredList(null), []);
  assert.deepEqual(B.parseStoredList('[]'), []);
  assert.deepEqual(B.parseStoredList('isso não é json'), []);
  assert.deepEqual(B.parseStoredList('["34","35"]'), ['34', '35']);
});

// Rotas de verdade (Express + banco falso em memória) — roda só se as dependências estiverem instaladas (npm install).
let express = null;
try { express = require('express'); } catch { /* sem node_modules: pula os testes de rota */ }

function fakeDb() {
  const rows = [];
  let id = 0;
  return {
    rows,
    async get(sql, params) {
      if (/FROM categories/.test(sql)) return { id: 1 };
      if (/FROM products WHERE id = \?/.test(sql)) return rows.find((r) => r.id === params[0]) || null;
      if (/FROM products WHERE slug = \?/.test(sql)) return rows.find((r) => r.slug === params[0]) || null;
      if (/created_at > NOW\(\)/.test(sql)) return null;
      return null;
    },
    async all() { return rows; },
    async run(sql, params) {
      if (/^\s*INSERT INTO products/.test(sql)) {
        const cols = sql.match(/\(([^)]*)\)\s*VALUES/)[1].split(',').map((c) => c.trim()).filter((c) => c !== 'updated_at');
        const row = { id: ++id };
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.push(row);
        return { lastInsertRowid: row.id };
      }
      if (/^\s*UPDATE products SET/.test(sql)) {
        const set = sql.match(/SET([\s\S]*?)WHERE/)[1].split(',').map((x) => x.trim().split(' = ')[0]).filter((c) => c && c !== 'updated_at');
        const row = rows.find((r) => r.id === params[params.length - 1]);
        set.forEach((c, i) => { row[c] = params[i]; });
        return {};
      }
      return {};
    },
  };
}

async function withApi(fn) {
  const Module = require('node:module');
  const db = fakeDb();
  const dbPath = require.resolve('../netlify/functions/lib/db');
  const authPath = require.resolve('../netlify/functions/lib/auth');
  const uploadPath = require.resolve('../netlify/functions/lib/upload');
  const saved = {};
  const stub = (p, exp) => { saved[p] = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
  stub(dbPath, db);
  stub(authPath, { log: async () => {} });
  stub(uploadPath, { deleteImage: async () => {} });
  delete require.cache[require.resolve('../netlify/functions/routes/products.routes')];
  const router = require('../netlify/functions/routes/products.routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { id: 1 }; next(); });
  app.use('/api', router);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ call, db }); } finally {
    server.close();
    for (const [p, v] of Object.entries(saved)) { if (v) require.cache[p] = v; else delete require.cache[p]; }
    delete require.cache[require.resolve('../netlify/functions/routes/products.routes')];
    void Module;
  }
}

test('API: salva disponíveis e esgotados e devolve os dois no produto', { skip: !express }, async () => {
  await withApi(async ({ call }) => {
    const created = await call('POST', '/admin/products', { name: 'Air Force 1', price: 399, sizes: ['31', '32', '33'], sold_out_sizes: ['34', '35', '36'] });
    assert.equal(created.status, 201);
    const got = await call('GET', '/products/' + created.body.slug);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.product.sizes, ['31', '32', '33']);
    assert.deepEqual(got.body.product.sold_out_sizes, ['34', '35', '36']);
  });
});

test('API: o mesmo tamanho nas duas listas é recusado (criar e editar)', { skip: !express }, async () => {
  await withApi(async ({ call }) => {
    const bad = await call('POST', '/admin/products', { name: 'X', price: 10, sizes: ['33', '34'], sold_out_sizes: ['34'] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /tamanho 34/);

    const ok = await call('POST', '/admin/products', { name: 'Y', price: 10, sizes: ['33'], sold_out_sizes: ['34'] });
    assert.equal(ok.status, 201);
    // editar só UMA das listas também não pode gerar duplicado com o que já estava salvo
    const edit = await call('PUT', '/admin/products/' + ok.body.id, { sizes: ['33', '34'] });
    assert.equal(edit.status, 400);
    const edit2 = await call('PUT', '/admin/products/' + ok.body.id, { sold_out_sizes: ['33'] });
    assert.equal(edit2.status, 400);
    // mover o 34 de esgotado para disponível (as duas listas juntas) é permitido
    const move = await call('PUT', '/admin/products/' + ok.body.id, { sizes: ['33', '34'], sold_out_sizes: [] });
    assert.equal(move.status, 200);
    const got = await call('GET', '/products/y');
    assert.deepEqual(got.body.product.sizes, ['33', '34']);
    assert.deepEqual(got.body.product.sold_out_sizes, []);
  });
});

test('API: produto antigo (sem sold_out_sizes) continua abrindo e pode ser editado sem mexer nos tamanhos', { skip: !express }, async () => {
  await withApi(async ({ call, db }) => {
    db.rows.push({ id: 99, name: 'Antigo', slug: 'antigo', brand: '', price: 100, sizes: '["38","39"]', colors: '[]', images: '[]', tags: '[]', category_tags: '[]', stock: 3, featured: 0, active: 1 });
    const got = await call('GET', '/products/antigo');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.product.sizes, ['38', '39']);
    assert.deepEqual(got.body.product.sold_out_sizes, []);
    const edit = await call('PUT', '/admin/products/99', { price: 120 });
    assert.equal(edit.status, 200);
    assert.deepEqual(JSON.parse(db.rows[0].sizes), ['38', '39']);
    assert.deepEqual(JSON.parse(db.rows[0].sold_out_sizes), []);
  });
});

test('API: listas que não são array são recusadas', { skip: !express }, async () => {
  await withApi(async ({ call }) => {
    const r = await call('POST', '/admin/products', { name: 'Z', price: 10, sold_out_sizes: '34' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /esgotados deve ser uma lista/);
  });
});

// ---------- 3. grade única, em ordem ----------
test('grade: disponíveis e esgotados juntos, em ordem numérica', () => {
  const o = S.buildOptions({ sizes: ['33', '31', '32'], sold_out_sizes: ['36', '34', '35'] });
  assert.deepEqual(o.map((x) => x.size), ['31', '32', '33', '34', '35', '36']);
  assert.deepEqual(o.map((x) => x.soldOut), [false, false, false, true, true, true]);
});

test('grade: esgotado entre disponíveis fica no lugar certo; meio número e texto', () => {
  assert.deepEqual(S.buildOptions({ sizes: ['38', '40', '42'], sold_out_sizes: ['39', '41'] }).map((x) => x.size), ['38', '39', '40', '41', '42']);
  assert.deepEqual(S.buildOptions({ sizes: ['38,5', '38'], sold_out_sizes: ['39'] }).map((x) => x.size), ['38', '38,5', '39']);
  assert.deepEqual(S.buildOptions({ sizes: ['M', 'P'], sold_out_sizes: ['G'] }).map((x) => x.size), ['M', 'P', 'G']);
});

test('grade: produto antigo (só sizes) e produto sem tamanhos; dado inconsistente vale como disponível', () => {
  assert.deepEqual(S.buildOptions({ sizes: ['38', '39'] }).map((x) => x.soldOut), [false, false]);
  assert.deepEqual(S.buildOptions({}), []);
  assert.deepEqual(S.buildOptions({ sizes: ['34'], sold_out_sizes: ['34'] }), [{ size: '34', soldOut: false }]);
});

// ---------- mensagem de encomenda ----------
test('mensagem de encomenda usa produto e tamanho reais; disponível mantém a pergunta de sempre', () => {
  assert.equal(
    W.buildMessage({ name: 'Air Force 1', size: '35', soldOut: true }),
    'Olá! Tenho interesse no Air Force 1, tamanho 35. Vi no site que esse tamanho está esgotado e gostaria de saber sobre a possibilidade de fazer uma encomenda.'
  );
  assert.equal(W.buildMessage({ name: 'Air Force 1', size: '32' }), 'O Air Force 1 da numeração 32 ainda está disponível em estoque?');
  const msg = W.buildMessage({ name: 'Dunk Low', size: '34', soldOut: true, link: 'https://loja.app/p/dunk?i=0' });
  assert.equal(msg.split('\n').pop(), 'https://loja.app/p/dunk?i=0');
});

// ---------- página do produto de ponta a ponta (DOM simulado) ----------
function runProductPage({ product, whatsapp = '(98) 99999-9999', origin = 'https://loja.app' }) {
  const html = fs.readFileSync(path.join(ROOT, 'public/produto.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((c) => c.includes('TNWhatsApp'));
  const els = {};
  const cls = (set) => ({ add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); }, contains: (c) => set.has(c) });
  const mk = (id) => {
    const handlers = {}; const attrs = {}; const set = new Set();
    return { id, style: {}, dataset: {}, handlers, attrs, innerHTML: '', textContent: '', classList: cls(set), classes: set,
      addEventListener: (t, fn) => { handlers[t] = fn; }, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
      querySelector: () => mk(id + '>q'), querySelectorAll: () => [], scrollIntoView() {}, closest: () => null };
  };
  const byId = (id) => (els[id] = els[id] || mk(id));
  // botões da grade a partir do HTML que a página gerou
  const sizeButtons = () => [...byId('sizeOptions').innerHTML.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => {
    const set = new Set((/class="([^"]*)"/.exec(m[1])[1]).split(' '));
    const attrs = { 'aria-pressed': /aria-pressed="([^"]*)"/.exec(m[1])[1] };
    return { dataset: { size: /data-size="([^"]*)"/.exec(m[1])[1], soldout: /data-soldout="1"/.test(m[1]) ? '1' : undefined }, text: m[2], classes: set, attrs, classList: cls(set), setAttribute: (k, v) => { attrs[k] = v; } };
  });
  let buttons = null;
  const toasts = [];
  const ctx = {
    console, URLSearchParams, URL, Promise, encodeURIComponent, decodeURIComponent, Number, String, Math,
    location: { search: '?slug=teste', href: origin + '/produto.html?slug=teste', origin },
    document: { getElementById: byId, querySelector: () => mk('q'), querySelectorAll: () => [], title: '' },
    RSShop: { money: (v) => 'R$ ' + v, toast: (m) => toasts.push(m), isFavorite: () => false, toggleFavorite() {}, productCardHtml: () => '', wireProductGrid() {} },
    TNWhatsApp: W, TNSizes: S,
    TNSiteReady: Promise.resolve({ contact: { whatsapp } }),
    fetch: (url) => Promise.resolve({ ok: true, json: async () => (String(url).includes('/api/products/') ? { product } : { products: [] }) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(inline, ctx);
  const wrap = byId('sizeOptions');
  // querySelectorAll da grade devolve os botões reais para o código poder limpar a seleção anterior
  const realQSA = () => buttons;
  return {
    byId, toasts, settle: async () => { await new Promise((r) => setTimeout(r, 20)); buttons = sizeButtons(); wrap.querySelectorAll = realQSA; return buttons; },
    click: (size) => { const b = buttons.find((x) => x.dataset.size === size); wrap.handlers.click({ target: { closest: () => b } }); return b; },
    label: () => byId('waLabel').textContent, href: () => byId('waBtn').attrs.href,
  };
}
const AF1 = { id: 1, slug: 'teste', name: 'Air Force 1', price: 399, stock: 5, sizes: ['31', '32', '33'], sold_out_sizes: ['34', '35', '36'], colors: [], images: ['https://cdn.x/f1.jpg'] };

test('página: tamanhos juntos na mesma grade, esgotados com marca (linha vermelha) e aviso de encomenda', async () => {
  const p = runProductPage({ product: AF1 });
  const btns = await p.settle();
  assert.deepEqual(btns.map((b) => b.text), ['31', '32', '33', '34', '35', '36']);
  assert.deepEqual(btns.map((b) => b.classes.has('soldout')), [false, false, false, true, true, true]);
  assert.equal(btns.filter((b) => b.dataset.soldout).length, 3);
  assert.match(p.byId('sizeHint').textContent, /esgotados também podem ser solicitados por encomenda pelo WhatsApp/);
  assert.notEqual(p.byId('sizeHint').style.display, 'none');
  const html = fs.readFileSync(path.join(ROOT, 'public/produto.html'), 'utf8');
  assert.match(html, /\.opt-btn\.soldout::after\{[^}]*var\(--red\)/, 'linha vermelha no CSS');
});

test('página: botão começa em "Chamar pelo WhatsApp"', async () => {
  const p = runProductPage({ product: AF1 });
  await p.settle();
  assert.equal(p.label(), 'Chamar pelo WhatsApp');
});

test('página: tamanho esgotado é selecionável, troca o botão e a mensagem leva produto + tamanho', async () => {
  const p = runProductPage({ product: AF1 });
  await p.settle();
  const b = p.click('35');
  assert.equal(b.classes.has('active'), true, 'esgotado fica marcado como selecionado');
  assert.equal(b.attrs['aria-pressed'], 'true');
  assert.equal(p.label(), 'Encomendar pelo WhatsApp');
  assert.match(p.byId('sizeHint').textContent, /Tamanho 35 esgotado/);
  const href = p.href();
  assert.match(href, /^https:\/\/wa\.me\/5598999999999\?text=/);
  assert.equal(decode(href), 'Olá! Tenho interesse no Air Force 1, tamanho 35. Vi no site que esse tamanho está esgotado e gostaria de saber sobre a possibilidade de fazer uma encomenda.\n\nhttps://loja.app/p/teste?i=0&v=2');
  let prevented = false;
  p.byId('waBtn').handlers.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'esgotado não é bloqueado: abre o WhatsApp da loja');
});

test('página: voltar a um tamanho disponível devolve "Chamar pelo WhatsApp" e a pergunta normal', async () => {
  const p = runProductPage({ product: AF1 });
  await p.settle();
  p.click('35');
  assert.equal(p.label(), 'Encomendar pelo WhatsApp');
  const b32 = p.click('32');
  assert.equal(p.label(), 'Chamar pelo WhatsApp');
  assert.equal(b32.classes.has('active'), true);
  assert.equal(decode(p.href()).split('\n')[0], 'O Air Force 1 da numeração 32 ainda está disponível em estoque?');
  assert.match(p.byId('sizeHint').textContent, /Tamanhos esgotados também podem ser solicitados/);
});

test('página: remover a seleção do esgotado volta o botão ao normal (e a numeração volta a ser exigida)', async () => {
  const p = runProductPage({ product: AF1 });
  const btns = await p.settle();
  p.click('36');
  assert.equal(p.label(), 'Encomendar pelo WhatsApp');
  const again = p.click('36');
  assert.equal(again.classes.has('active'), false);
  assert.equal(p.label(), 'Chamar pelo WhatsApp');
  let prevented = false;
  p.byId('waBtn').handlers.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(p.toasts.some((t) => /numeração/i.test(t)));
  assert.equal(btns.filter((b) => b.classes.has('active')).length, 0);
});

test('página: só um tamanho fica selecionado por vez', async () => {
  const p = runProductPage({ product: AF1 });
  const btns = await p.settle();
  p.click('31'); p.click('34'); p.click('33');
  assert.deepEqual(btns.filter((b) => b.classes.has('active')).map((b) => b.dataset.size), ['33']);
});

test('página: produto antigo (só tamanhos disponíveis) funciona como antes, sem aviso de encomenda', async () => {
  const p = runProductPage({ product: { ...AF1, sizes: ['38', '39', '40'], sold_out_sizes: undefined } });
  const btns = await p.settle();
  assert.deepEqual(btns.map((b) => b.text), ['38', '39', '40']);
  assert.equal(btns.some((b) => b.classes.has('soldout')), false);
  assert.equal(p.byId('sizeHint').textContent, '', 'sem esgotados não há aviso (o <p> já nasce oculto no HTML)');
  p.click('39');
  assert.equal(p.label(), 'Chamar pelo WhatsApp');
  assert.equal(decode(p.href()).split('\n')[0], 'O Air Force 1 da numeração 39 ainda está disponível em estoque?');
});

test('página: produto sem nenhum tamanho cadastrado não mostra a grade', async () => {
  const p = runProductPage({ product: { ...AF1, sizes: [], sold_out_sizes: [] } });
  await p.settle();
  assert.notEqual(p.byId('sizeSection').style.display, '');
  assert.equal(p.label(), 'Chamar pelo WhatsApp');
});

test('página: nome do produto na encomenda é o real (nada fixo no código)', async () => {
  const p = runProductPage({ product: { ...AF1, name: 'Puma Speedcat OG', sizes: ['38'], sold_out_sizes: ['39'] } });
  await p.settle();
  p.click('39');
  assert.ok(decode(p.href()).startsWith('Olá! Tenho interesse no Puma Speedcat OG, tamanho 39.'));
});

// ---------- admin e home ----------
test('admin: dois campos separados, validação de duplicado e nada de tamanho fixo', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/admin/produtos.html'), 'utf8');
  assert.match(html, /id="p-sizes"[\s\S]*id="p-sizes-out"/);
  assert.match(html, /Tamanhos disponíveis/);
  assert.match(html, /Tamanhos esgotados/);
  const js = fs.readFileSync(path.join(ROOT, 'public/js/admin-produtos.js'), 'utf8');
  assert.match(js, /sold_out_sizes: uniqueList\(/);
  assert.match(js, /product\.sold_out_sizes/);
  assert.match(js, /sizesConflicts\(\)/);
});

test('home: hero é um único vídeo em loop e a seção de confiança foi removida', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const hero = html.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<video[^>]*autoplay[^>]*muted[^>]*loop[^>]*playsinline/);
  assert.equal((hero.match(/<video/g) || []).length, 1);
  assert.ok(!/heroCarousel\.innerHTML|hero-slide/.test(html));
  assert.ok(!/class="trust"/.test(html));
});

test('vídeo flutuante: mini roda mudo em loop e ao ampliar recomeça do início', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/js/video-widget.js'), 'utf8');
  assert.match(js, /<video muted loop autoplay playsinline/);
  assert.match(js, /video\.currentTime = 0/);
  assert.match(js, /miniVideo\.pause\(\)/);
});

test('migração e schema: coluna sold_out_sizes aditiva e idempotente', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'migrations/2026-10-28_tamanhos_esgotados.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS sold_out_sizes TEXT NOT NULL DEFAULT '\[\]'/);
  assert.ok(!/DROP|DELETE/i.test(sql));
  const db = fs.readFileSync(path.join(ROOT, 'netlify/functions/lib/db.js'), 'utf8');
  assert.match(db, /ADD COLUMN IF NOT EXISTS sold_out_sizes/);
});
