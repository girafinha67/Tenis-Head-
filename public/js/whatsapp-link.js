/* Tênis Head — link "Chamar no WhatsApp".
   A venda é feita no WhatsApp: o botão do produto abre a conversa com a loja já com a pergunta pronta
   e o endereço da foto do produto (o WhatsApp mostra a prévia da imagem na conversa).
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

  // A foto precisa ir como endereço completo (https://...), senão o WhatsApp não consegue abri-la.
  function absoluteUrl(url, base) {
    var u = clean(url);
    if (!u || /^data:/i.test(u)) return '';
    try {
      var abs = new URL(u, base || (typeof location !== 'undefined' ? location.href : undefined)).href;
      return /^https?:\/\//i.test(abs) ? abs : '';
    } catch (e) { return ''; }
  }

  // "O <modelo> da numeração <número> ainda está disponível em estoque?" + endereço da foto.
  function buildMessage(opts) {
    var model = clean(opts && opts.name);
    var size = clean(opts && opts.size);
    var image = clean(opts && opts.imageUrl);
    var question = size
      ? 'O ' + model + ' da numeração ' + size + ' ainda está disponível em estoque?'
      : 'O ' + model + ' ainda está disponível em estoque?';
    return image ? question + '\n\n' + image : question;
  }

  function buildUrl(opts) {
    var number = normalizeNumber(opts && opts.number);
    if (!number) return '';
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(buildMessage(opts));
  }

  return { clean: clean, normalizeNumber: normalizeNumber, absoluteUrl: absoluteUrl, buildMessage: buildMessage, buildUrl: buildUrl };
});
