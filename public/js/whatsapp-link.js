/* Tênis Head — link "Chamar no WhatsApp".
   A venda é feita no WhatsApp: o botão do produto abre a conversa com a loja já com a pergunta pronta
   e o cartão com a foto do produto (o WhatsApp mostra a imagem na conversa).
   Arquivo único: roda no navegador (window.TNWhatsApp) e nos testes (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TNWhatsApp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clean(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Aceita "(98) 99999-9999", "98999999999" ou "5598999999999". Devolve só dígitos com DDI 55, ou ''.
  function normalizeNumber(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (!d) return '';
    if (d.length <= 11) d = '55' + d;
    return d.length >= 12 && d.length <= 15 ? d : '';
  }

  // Endereço curto do produto com a foto escolhida (?i=). O WhatsApp transforma esse endereço num cartão com a
  // foto do produto (tags Open Graph servidas por netlify/functions/lib/share-page.js).
  function shareUrl(origin, slug, index) {
    var s = clean(slug);
    var o = clean(origin).replace(/\/+$/, '');
    if (!s || !/^https?:\/\//i.test(o)) return '';
    var i = Number(index);
    return o + '/p/' + encodeURIComponent(s) + '?i=' + (Number.isInteger(i) && i >= 0 ? i : 0);
  }

  // "O <modelo> da numeração <número> ainda está disponível em estoque?" + endereço do cartão com a foto.
  function buildMessage(opts) {
    var model = clean(opts && opts.name);
    var size = clean(opts && opts.size);
    var link = clean(opts && opts.link);
    var question = size
      ? 'O ' + model + ' da numeração ' + size + ' ainda está disponível em estoque?'
      : 'O ' + model + ' ainda está disponível em estoque?';
    return link ? question + '\n\n' + link : question;
  }

  function buildUrl(opts) {
    var number = normalizeNumber(opts && opts.number);
    if (!number) return '';
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(buildMessage(opts));
  }

  return { clean: clean, normalizeNumber: normalizeNumber, shareUrl: shareUrl, buildMessage: buildMessage, buildUrl: buildUrl };
});
