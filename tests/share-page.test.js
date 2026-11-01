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
  assert.match(html, /<meta property="og:image" content="https:\/\/loja\.app\/\.netlify\/images\?url=https%3A%2F%2Fzok\.supabase\.co%2F[^"]*%2Fb\.jpg&amp;w=700&amp;fm=jpg&amp;q=75">/);
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

test('a function atende /p/<slug> (o Netlify repassa o caminho original, não o reescrito)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/routes/products.routes.js'), 'utf8');
  assert.match(src, /\['\/share\/:slug', '\/p\/:slug'\]/);
});

test('og:url e canonical apontam para a própria página /p/ (senão o WhatsApp lê a página sem foto)', () => {
  const html = renderSharePage({ product: P, origin: ORIGIN, index: 1 });
  assert.ok(html.includes('<meta property="og:url" content="https://loja.app/p/air-force-1?i=1">'));
  assert.ok(html.includes('<link rel="canonical" href="https://loja.app/p/air-force-1?i=1">'));
});

test('foto do site vai pelo redimensionador com caminho relativo; host desconhecido fica como está', () => {
  const { cardImage } = require('../netlify/functions/lib/share-page');
  assert.equal(cardImage('https://loja.app/assets/x.jpg', ORIGIN), 'https://loja.app/.netlify/images?url=%2Fassets%2Fx.jpg&w=700&fm=jpg&q=75');
  assert.equal(cardImage('https://outro.com/x.jpg', ORIGIN), 'https://outro.com/x.jpg');
});

test('netlify.toml libera o redimensionador para fotos do Supabase', () => {
  const toml = fs.readFileSync(path.join(__dirname, '../netlify.toml'), 'utf8');
  assert.match(toml, /\[images\]\s+remote_images = \[/);
  assert.match(toml, /supabase/);
});

test('cartão: pula foto quebrada e usa a próxima que carrega', async () => {
  const { chooseShareImage } = require('../netlify/functions/lib/share-page');
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    const ok = url.includes('b.jpg');
    return { ok, status: ok ? 200 : 404, headers: { get: () => (ok ? 'image/jpeg' : 'text/html') }, arrayBuffer: async () => new ArrayBuffer(ok ? 50000 : 10) };
  };
  const img = await chooseShareImage(P, 0, ORIGIN, fake, { useEndpoint: false });
  assert.ok(img.includes('b.jpg'));
  assert.equal(calls.length, 2);
});

test('cartão: se todas as fotos estão quebradas, não aponta para imagem inexistente', async () => {
  const { chooseShareImage } = require('../netlify/functions/lib/share-page');
  const fake = async () => ({ ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(await chooseShareImage(P, 0, ORIGIN, fake, { useEndpoint: false }), '');
  assert.ok(!renderSharePage({ product: P, origin: ORIGIN, index: 0, image: '' }).includes('og:image'));
});

test('cartão: erro de rede/timeout mantém a foto (não derruba o cartão por oscilação)', async () => {
  const { chooseShareImage } = require('../netlify/functions/lib/share-page');
  const fake = async () => { throw new Error('timeout'); };
  assert.ok((await chooseShareImage(P, 1, ORIGIN, fake, { useEndpoint: false })).includes('b.jpg'));
});

test('cartão: usa o endereço /api/share-img (JPEG leve) quando ele responde', async () => {
  const { chooseShareImage } = require('../netlify/functions/lib/share-page');
  const fake = async () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(90000) });
  assert.equal(await chooseShareImage(P, 1, ORIGIN, fake), 'https://loja.app/api/share-img/air-force-1?i=1');
});

test('cartão: converte WebP/PNG grande em JPEG leve (o que o WhatsApp aceita)', async () => {
  const { toShareJpeg, SHARE_JPEG_MAX, isAllowedImageHost } = require('../netlify/functions/lib/share-page');
  let sharp;
  try { sharp = require('sharp'); } catch { return; } // sem sharp instalado no ambiente de teste
  const w = 1600, h = 1600, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + (i >> 5)) & 255; // ruído: difícil de comprimir
  const webp = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 95 }).toBuffer();
  assert.ok(webp.length > 300 * 1024);
  const jpg = await toShareJpeg(webp);
  assert.ok(jpg.length <= SHARE_JPEG_MAX);
  assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(isAllowedImageHost('https://x.supabase.co/a.webp', ORIGIN));
  assert.ok(!isAllowedImageHost('https://evil.example/a.webp', ORIGIN));
  assert.ok(!isAllowedImageHost('http://x.supabase.co/a.webp', ORIGIN));
});
