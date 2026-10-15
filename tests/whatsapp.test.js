'use strict';

// Botão "Chamar no WhatsApp": mensagem, número e foto. Sem rede e sem banco.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const W = require('../public/js/whatsapp-link.js');
const decode = (url) => decodeURIComponent(url.split('?text=')[1]);

test('mensagem: "O <modelo> da numeração <número> ainda está disponível em estoque?"', () => {
  assert.equal(
    W.buildMessage({ name: 'Nike Air Force 1', size: '42' }),
    'O Nike Air Force 1 da numeração 42 ainda está disponível em estoque?'
  );
});

test('a foto vai como cartão: endereço curto do produto em linha própria, não o arquivo da imagem', () => {
  const link = W.shareUrl('https://loja.app', 'adidas-samba', 1);
  assert.equal(link, 'https://loja.app/p/adidas-samba?i=1');
  const msg = W.buildMessage({ name: 'Adidas Samba', size: '40', link });
  assert.equal(msg.split('\n')[0], 'O Adidas Samba da numeração 40 ainda está disponível em estoque?');
  assert.equal(msg.split('\n').pop(), link);
  assert.ok(!/\.(jpe?g|png|webp)/i.test(msg));
});

test('link wa.me: número com DDI 55, texto codificado e acentos preservados', () => {
  const url = W.buildUrl({ number: '(98) 99999-9999', name: 'Puma Speedcat', size: '39', link: 'https://loja.app/p/puma?i=0' });
  assert.match(url, /^https:\/\/wa\.me\/5598999999999\?text=/);
  assert.equal(decode(url), 'O Puma Speedcat da numeração 39 ainda está disponível em estoque?\n\nhttps://loja.app/p/puma?i=0');
});

test('número: aceita com/sem DDI e rejeita inválido', () => {
  assert.equal(W.normalizeNumber('98999999999'), '5598999999999');
  assert.equal(W.normalizeNumber('+55 (98) 99999-9999'), '5598999999999');
  assert.equal(W.normalizeNumber(''), '');
  assert.equal(W.normalizeNumber('123'), '');
  assert.equal(W.buildUrl({ number: '', name: 'X', size: '40' }), '');
});

test('shareUrl: exige slug e origem válidos; índice inválido vira 0', () => {
  assert.equal(W.shareUrl('', 'x', 0), '');
  assert.equal(W.shareUrl('https://loja.app', '', 0), '');
  assert.equal(W.shareUrl('javascript:x', 'x', 0), '');
  assert.equal(W.shareUrl('https://loja.app/', 'tênis x', -3), 'https://loja.app/p/t%C3%AAnis%20x?i=0');
});

test('nome com quebra de linha/controle não bagunça a mensagem', () => {
  assert.equal(W.buildMessage({ name: 'Nike\nDunk\t Low', size: ' 41 ' }), 'O Nike Dunk Low da numeração 41 ainda está disponível em estoque?');
});

// ------------------------------------------------------------------------------------------
// Página do produto de ponta a ponta (DOM simulado): numeração obrigatória, foto exibida e número do painel.
function runProductPage({ product, whatsapp = '(98) 99999-9999', origin = 'https://loja.app' }) {
  const html = fs.readFileSync(path.join(__dirname, '../public/produto.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((c) => c.includes('TNWhatsApp'));
  const els = {};
  const mk = (id) => {
    const handlers = {};
    const attrs = {};
    const el = {
      id, style: {}, dataset: {}, handlers, attrs, innerHTML: '', textContent: '', disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener: (t, fn) => { handlers[t] = fn; },
      setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
      querySelector: () => mk(id + '>q'), querySelectorAll: () => [],
      scrollIntoView() {}, closest: () => null,
    };
    return el;
  };
  const byId = (id) => (els[id] = els[id] || mk(id));
  const toasts = [];
  const ctx = {
    console, URLSearchParams, URL, Promise, encodeURIComponent, decodeURIComponent, Number, String, Math,
    location: { search: '?slug=teste', href: origin + '/produto.html?slug=teste', origin },
    document: { getElementById: byId, querySelector: () => mk('q'), querySelectorAll: () => [], title: '' },
    RSShop: { money: (v) => 'R$ ' + v, toast: (m) => toasts.push(m), isFavorite: () => false, toggleFavorite() {}, productCardHtml: () => '', wireProductGrid() {} },
    TNWhatsApp: W,
    TNSiteReady: Promise.resolve({ contact: { whatsapp } }),
    fetch: (url) => Promise.resolve({ ok: true, json: async () => (String(url).includes('/api/products/') ? { product } : { products: [] }) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(inline, ctx);
  return { byId, toasts, settle: () => new Promise((r) => setTimeout(r, 20)) };
}
const PRODUCT = { id: 7, slug: 'teste', name: 'Nike Air Force Verde', price: 599, stock: 5, sizes: ['38', '39', '40'], colors: [], images: ['https://cdn.x/foto-1.jpg', 'https://cdn.x/foto-2.jpg'] };
const clickSize = (byId, size) => byId('sizeOptions').handlers.click({ target: { closest: () => ({ dataset: { size }, classList: { add() {}, remove() {} } }) } });

test('produto: sem escolher a numeração o link não abre e avisa o cliente', async () => {
  const p = runProductPage({ product: PRODUCT });
  await p.settle();
  let prevented = false;
  p.byId('waBtn').handlers.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(p.toasts.some((t) => /numeração/i.test(t)));
});

test('produto: com a numeração escolhida o link leva modelo, número e o cartão da foto exibida', async () => {
  const p = runProductPage({ product: PRODUCT });
  await p.settle();
  clickSize(p.byId, '40');
  let prevented = false;
  p.byId('waBtn').handlers.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  const href = p.byId('waBtn').attrs.href;
  assert.match(href, /^https:\/\/wa\.me\/5598999999999\?text=/);
  assert.equal(decode(href), 'O Nike Air Force Verde da numeração 40 ainda está disponível em estoque?\n\nhttps://loja.app/p/teste?i=0');
});

test('produto: a foto da mensagem acompanha a foto escolhida na galeria', async () => {
  const p = runProductPage({ product: PRODUCT });
  await p.settle();
  clickSize(p.byId, '39');
  p.byId('galleryThumbs').handlers.click({ target: { closest: () => ({ dataset: { i: '1' } }) } });
  assert.ok(decode(p.byId('waBtn').attrs.href).endsWith('https://loja.app/p/teste?i=1'));
});

test('produto sem foto: manda só a pergunta, sem link', async () => {
  const p = runProductPage({ product: { ...PRODUCT, images: [] } });
  await p.settle();
  clickSize(p.byId, '38');
  assert.equal(decode(p.byId('waBtn').attrs.href), 'O Nike Air Force Verde da numeração 38 ainda está disponível em estoque?');
});

test('produto: sem número de WhatsApp configurado no painel, não abre link quebrado', async () => {
  const p = runProductPage({ product: PRODUCT, whatsapp: '' });
  await p.settle();
  clickSize(p.byId, '40');
  let prevented = false;
  p.byId('waBtn').handlers.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(p.toasts.some((t) => /não foi configurado/i.test(t)));
});

test('produto sem tamanhos cadastrados: pergunta sem numeração', async () => {
  const p = runProductPage({ product: { ...PRODUCT, sizes: [] } });
  await p.settle();
  let prevented = false;
  p.byId('waBtn').handlers.click({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(decode(p.byId('waBtn').attrs.href).split('\n')[0], 'O Nike Air Force Verde ainda está disponível em estoque?');
});
