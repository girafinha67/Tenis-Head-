'use strict';

// Página /p/<slug>: tags que o WhatsApp lê para mostrar a foto do produto na conversa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderSharePage, pickImage } = require('../netlify/functions/lib/share-page');

const ORIGIN = 'https://loja.app';
const P = { slug: 'air-force-1', name: 'Air Force 1', brand: 'Nike', price: 599, promo_price: 499.9,
  images: ['https://zok.supabase.co/storage/v1/object/public/rshoes-images/rshoes/a.jpg', 'https://zok.supabase.co/storage/v1/object/public/rshoes-images/rshoes/b.jpg'] };

test('tem og:image com a foto escolhida (?i=), nome e preço', () => {
  const html = renderSharePage({ product: P, origin: ORIGIN, index: 1 });
  assert.match(html, /<meta property="og:image" content="https:\/\/zok\.supabase\.co\/[^"]*\/b\.jpg">/);
  assert.match(html, /<meta property="og:title" content="Air Force 1 · Nike">/);
  assert.match(html, /og:description" content="R\$\s?499,90 · Tênis Head"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
});

test('índice ausente, inválido ou fora da lista cai na primeira foto', () => {
  for (const i of [undefined, NaN, -1, 9]) assert.ok(pickImage(P, i, ORIGIN).endsWith('/a.jpg'));
});

test('foto relativa vira endereço completo e esquemas perigosos são descartados', () => {
  assert.equal(pickImage({ images: ['assets/hero/x.jpg'] }, 0, ORIGIN), 'https://loja.app/assets/hero/x.jpg');
  assert.equal(pickImage({ images: ['javascript:alert(1)'] }, 0, ORIGIN), '');
  assert.equal(pickImage({ images: [] }, 0, ORIGIN), '');
});

test('visitante é levado para a página do produto', () => {
  const html = renderSharePage({ product: P, origin: ORIGIN, index: 0 });
  assert.ok(html.includes('location.replace("https://loja.app/produto.html?slug=air-force-1")'));
  assert.ok(html.includes('<a href="https://loja.app/produto.html?slug=air-force-1">'));
});

test('nome malicioso não injeta HTML nem script', () => {
  const html = renderSharePage({ product: { ...P, name: '"><script>alert(1)</script>', slug: 'x"</script><b>' }, origin: ORIGIN, index: 0 });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('</script><b>'));
});

test('sem foto cadastrada a página continua válida (sem og:image)', () => {
  const html = renderSharePage({ product: { ...P, images: [] }, origin: ORIGIN, index: 0 });
  assert.ok(!html.includes('og:image'));
  assert.match(html, /og:title/);
});

test('redirecionamento /p/:slug existe no netlify.toml', () => {
  const toml = fs.readFileSync(path.join(__dirname, '../netlify.toml'), 'utf8');
  assert.match(toml, /from = "\/p\/:slug"\s+to = "\/\.netlify\/functions\/api\/share\/:slug"/);
});
