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

  // Se o otimizador não existir/falhar, volta para a foto original (uma vez só).
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || t.getAttribute('data-th-fb')) return;
    var src = t.currentSrc || t.src || '';
    if (src.indexOf('/_vercel/image') < 0) return;
    var m = /[?&]url=([^&]+)/.exec(src);
    if (!m) return;
    t.setAttribute('data-th-fb', '1');
    t.src = decodeURIComponent(m[1]);
  }, true);
})();
