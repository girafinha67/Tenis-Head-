'use strict';

// Página de compartilhamento de um produto (https://SEU-SITE/p/<slug>?i=<foto>).
// O botão "Chamar no WhatsApp" manda este endereço na mensagem: o WhatsApp lê as tags Open Graph abaixo e
// mostra a FOTO do produto (cartão grande) com o nome, em vez de um link de imagem solto.
// Quem abre o endereço de verdade é levado direto para a página do produto.
// Função pura (sem banco/rede) para poder ser testada.

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Foto escolhida (?i=) com fallback para a primeira. Sempre devolve endereço completo http(s) ou ''.
function pickImage(product, index, origin) {
  const images = Array.isArray(product && product.images) ? product.images.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!images.length) return '';
  const i = Number.isInteger(index) && index >= 0 && index < images.length ? index : 0;
  try {
    const abs = new URL(images[i].trim(), origin).href;
    return /^https?:\/\//i.test(abs) ? abs : '';
  } catch {
    return '';
  }
}

// O WhatsApp só mostra o cartão se a foto for leve (cerca de 300 KB). Fotos de produto costumam passar disso,
// então a foto vai pelo redimensionador do próprio Netlify (/.netlify/images) quando está no Supabase ou no site.
function cardImage(image, origin) {
  if (!image) return '';
  try {
    const u = new URL(image);
    const o = new URL(origin);
    let src = '';
    if (u.hostname === o.hostname) src = u.pathname + u.search;
    else if (/\.supabase\.co$/i.test(u.hostname)) src = u.href;
    if (!src) return image;
    // Na Vercel o redimensionador é o /_vercel/image (configurado em vercel.json); no Netlify, /.netlify/images.
    if (process.env.VERCEL) return `${o.origin}/_vercel/image?url=${encodeURIComponent(src)}&w=700&q=75`;
    return `${o.origin}/.netlify/images?url=${encodeURIComponent(src)}&w=700&fm=jpg&q=75`;
  } catch {
    return image;
  }
}


// ---- Escolha da foto do cartão ----
// O WhatsApp só mostra a foto se ela responder rápido, for imagem de verdade e ficar abaixo de ~300 KB.
// Testamos as fotos do produto (a escolhida em ?i= primeiro) e usamos a primeira que passa no teste.
// Se nenhuma passar, devolve '' (cartão só com nome e preço) em vez de apontar para uma foto quebrada.
const CARD_MAX_BYTES = 300 * 1024;
const CHECK_TIMEOUT_MS = 4500;

function orderedImages(product, index) {
  const list = Array.isArray(product && product.images) ? product.images : [];
  const idx = [];
  list.forEach((x, n) => { if (typeof x === 'string' && x.trim()) idx.push(n); });
  const first = idx.indexOf(Number.isInteger(index) ? index : 0);
  if (first > 0) idx.unshift(idx.splice(first, 1)[0]);
  return idx;
}

// 'ok' = serve; 'bad' = foto quebrada de verdade (404, não é imagem); 'unknown' = demorou/oscilou/ficou pesada.
async function checkImage(url, fetchImpl) {
  if (!url) return 'bad';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5' } });
    if (res.status >= 500) return 'unknown';
    if (!res.ok) return 'bad';
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) return 'bad';
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return 'bad';
    return buf.byteLength <= CARD_MAX_BYTES ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

async function chooseShareImage(product, index, origin, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return cardImage(pickImage(product, index, origin), origin);
  const order = orderedImages(product, index).slice(0, 4);
  let maybe = '';
  for (const n of order) {
    const card = cardImage(pickImage(product, n, origin), origin);
    if (!card) continue;
    const r = await checkImage(card, fetchImpl);
    if (r === 'ok') return card;
    if (r === 'unknown' && !maybe) maybe = card;
  }
  return maybe;
}

function formatPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';
}

function renderSharePage({ product, origin, index, storeName = 'Tênis Head', image: imageOverride }) {
  const target = `${origin}/produto.html?slug=${encodeURIComponent(product.slug)}`;
  const image = imageOverride !== undefined ? imageOverride : cardImage(pickImage(product, index, origin), origin);
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  // og:url e canonical apontam para ESTA página: se apontassem para a página do produto (sem tags Open Graph),
  // o WhatsApp leria aquela e o cartão ficaria sem foto.
  const self = `${origin}/p/${encodeURIComponent(product.slug)}?i=${i}`;
  const price = formatPrice(product.promo_price || product.price);
  const title = `${product.name}${product.brand ? ' · ' + product.brand : ''}`;
  const desc = [price, storeName].filter(Boolean).join(' · ');
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${t} | ${escapeHtml(storeName)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(storeName)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(self)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(image)}">` : '<meta name="twitter:card" content="summary">'}
<link rel="canonical" href="${escapeHtml(self)}">
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script>
</head>
<body>
<p><a href="${escapeHtml(target)}">${t}</a></p>
</body>
</html>`;
}

module.exports = { renderSharePage, pickImage, cardImage, escapeHtml, chooseShareImage, orderedImages };
