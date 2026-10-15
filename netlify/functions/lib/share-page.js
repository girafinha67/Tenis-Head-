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
    return `${o.origin}/.netlify/images?url=${encodeURIComponent(src)}&w=700&fm=jpg&q=75`;
  } catch {
    return image;
  }
}

function formatPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';
}

function renderSharePage({ product, origin, index, storeName = 'Tênis Head' }) {
  const target = `${origin}/produto.html?slug=${encodeURIComponent(product.slug)}`;
  const image = cardImage(pickImage(product, index, origin), origin);
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
<meta property="og:image:type" content="image/jpeg">
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

module.exports = { renderSharePage, pickImage, cardImage, escapeHtml };
