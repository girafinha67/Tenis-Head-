/* Fotos de produto pelo cache da Vercel (/_vercel/image).
   Sem isso, cada visita baixa a foto original direto do Supabase Storage e
   estoura a banda do plano. Com isso, o Supabase só é consultado na primeira
   vez; depois a Vercel entrega a foto redimensionada (WebP/AVIF) do cache.
   - thImg(url, largura): devolve a URL otimizada (só para fotos do Supabase);
     as larguras seguem vercel.json > images.sizes.
   - Fora da Vercel (localhost, netlify.app) devolve a URL original, e se uma
     foto otimizada falhar ao carregar, volta sozinha para a original. */
(function () {
  'use strict';
  var SIZES = [256, 640, 700, 1080, 1920];
  var h = location.hostname;
  var on = location.protocol !== 'file:' &&
    !/^(localhost|127\.|\[::1\])/.test(h) && !/netlify\.app$/.test(h);

  window.thImg = function (url, w) {
    if (!on || typeof url !== 'string' || !/^https:\/\/[^\/]+\.supabase\.co\//.test(url)) return url;
    var size = 1920;
    for (var i = 0; i < SIZES.length; i++) { if (SIZES[i] >= (w || 640)) { size = SIZES[i]; break; } }
    return '/_vercel/image?url=' + encodeURIComponent(url) + '&w=' + size + '&q=75';
  };

  // Foto "vazia" (cinza com um tênis) para quando nem a original carrega.
  var PH = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#f3f3f3"/>' +
    '<path d="M40 128c0-6 3-9 8-10l24-6 14-20c3-4 8-4 11-1l8 9c8 7 18 10 30 12 9 1 16 6 16 14v6H40z" fill="#d4d4d4"/></svg>');
  window.thImgPlaceholder = PH;

  // 1) Se o otimizador não existir/falhar, volta para a foto original (uma vez só).
  // 2) Se a original também falhar (arquivo apagado/URL inválida), não deixa o ícone de imagem quebrada:
  //    no card tenta a 2ª foto do produto, e avisa a página (evento "thimgdead") para trocar de foto.
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    var cur = t.currentSrc || t.src || '';
    if (cur === PH || t.getAttribute('data-th-dead')) return;
    if (!t.getAttribute('data-th-fb') && cur.indexOf('/_vercel/image') >= 0) {
      var m = /[?&]url=([^&]+)/.exec(cur);
      if (m) {
        t.setAttribute('data-th-fb', '1');
        t.src = decodeURIComponent(m[1]);
        return;
      }
    }
    // Só trata fotos de produto (Supabase ou otimizador); logos e ícones do site ficam como estão.
    if (!/supabase\.co|\/_vercel\/image/.test(cur) && !t.closest('.pc-visual, .gallery-main, .gallery-thumbs, .search-item')) return;
    // Card da vitrine: usa a 2ª foto no lugar da 1ª quebrada.
    if (t.classList.contains('img-1')) {
      var alt = t.parentNode && t.parentNode.querySelector('img.img-2');
      if (alt && alt.src && alt.src !== cur && !t.getAttribute('data-th-swap') && !alt.getAttribute('data-th-dead')) {
        t.setAttribute('data-th-swap', '1');
        t.removeAttribute('data-th-fb');
        t.src = alt.src;
        return;
      }
    }
    t.setAttribute('data-th-dead', '1');
    t.src = PH;
    t.classList.add('th-ph');
    t.style.objectFit = 'contain';
    try { t.dispatchEvent(new CustomEvent('thimgdead', { bubbles: true })); } catch (err) { /* navegador antigo */ }
  }, true);
})();
