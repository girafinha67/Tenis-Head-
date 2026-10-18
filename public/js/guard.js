/* Travas de comportamento da loja (complementa assets/guard.css):
   - não deixa arrastar imagens, ícones e links para fora do lugar;
   - bloqueia o menu "salvar imagem/vídeo" (botão direito e toque longo);
   - tira o botão de baixar dos vídeos;
   - impede que soltar um arquivo na página abra a imagem e saia da loja. */
(function () {
  'use strict';

  var MEDIA = 'img,picture,video,svg,canvas,audio';
  var EDITABLE = 'input,textarea,select,[contenteditable="true"]';

  function inside(el, selector) {
    return !!(el && el.closest && el.closest(selector));
  }

  // Arrastar (imagem, link, ícone, texto) — só continua liberado dentro de campos de digitação.
  document.addEventListener('dragstart', function (e) {
    if (!inside(e.target, EDITABLE)) e.preventDefault();
  }, true);

  // Soltar arquivo em cima da página não pode navegar para o arquivo.
  window.addEventListener('dragover', function (e) {
    if (!inside(e.target, EDITABLE)) e.preventDefault();
  });
  window.addEventListener('drop', function (e) {
    if (!inside(e.target, EDITABLE)) e.preventDefault();
  });

  // Botão direito / toque longo em imagem ou vídeo não abre "salvar como...".
  document.addEventListener('contextmenu', function (e) {
    if (inside(e.target, MEDIA)) e.preventDefault();
  }, true);

  // Vídeos: sem botão de baixar, sem picture-in-picture e sem enviar para outra tela.
  function lockVideo(v) {
    if (!v || v.__locked) return;
    v.__locked = true;
    v.setAttribute('controlsList', 'nodownload noremoteplayback noplaybackrate');
    v.setAttribute('disablePictureInPicture', '');
    v.setAttribute('disableRemotePlayback', '');
    v.setAttribute('playsinline', '');
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.tagName === 'VIDEO') lockVideo(root);
    var list = root.querySelectorAll('video');
    for (var i = 0; i < list.length; i++) lockVideo(list[i]);
  }

  function start() {
    scan(document);
    if (!window.MutationObserver) return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) scan(added[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
