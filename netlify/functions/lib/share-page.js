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

function formatPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';
}

function renderSharePage({ product, origin, index, storeName = 'Tênis Head' }) {
  const target = `${origin}/produto.html?slug=${encodeURIComponent(product.slug)}`;
  const image = pickImage(product, index, origin);
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
<meta property="og:url" content="${escapeHtml(target)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(image)}">` : '<meta name="twitter:card" content="summary">'}
<link rel="canonical" href="${escapeHtml(target)}">
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script>
</head>
<body>
<p><a href="${escapeHtml(target)}">${t}</a></p>
</body>
</html>`;
}

module.exports = { renderSharePage, pickImage, escapeHtml };
