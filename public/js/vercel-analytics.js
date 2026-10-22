/* Vercel Web Analytics (site estático, sem bundler).
   Mesmo snippet oficial da Vercel, em arquivo próprio para ser reaproveitado
   nas páginas públicas (index, catálogo, produto, favoritos). O painel /admin
   NÃO carrega este arquivo, para não contar as visitas da equipe.
   O script /_vercel/insights/script.js só existe na Vercel (com o Web Analytics
   ativado no projeto); em outro lugar (Netlify, localhost) ele só dá 404 e o
   site segue funcionando normalmente. Mesma origem: a CSP não precisa mudar. */
(function () {
  'use strict';
  window.va = window.va || function () { (window.va.q = window.va.q || []).push(arguments); };

  var h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return;

  var s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);
})();
