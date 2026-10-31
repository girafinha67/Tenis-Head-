/* Tênis Head — grade de tamanhos da página do produto.
   Junta "disponíveis" (product.sizes) e "esgotados" (product.sold_out_sizes) numa grade só, em ordem numérica.
   Arquivo único: roda no navegador (window.TNSizes) e nos testes (require). Sem dados fixos: só o que o admin cadastrou. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TNSizes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clean(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Lista (ou texto "34, 35") → itens limpos, sem vazios e sem repetidos.
  function toList(v) {
    var arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
    var seen = {}, out = [];
    arr.forEach(function (item) {
      var s = clean(item);
      if (!s) return;
      var k = s.toLowerCase();
      if (seen[k]) return;
      seen[k] = true; out.push(s);
    });
    return out;
  }

  // "38", "38.5", "38,5" → número; "P", "GG" → null.
  function numeric(s) {
    var m = /^\d+(?:[.,]\d+)?$/.exec(s);
    return m ? parseFloat(s.replace(',', '.')) : null;
  }

  // Devolve [{ size, soldOut }] na ordem numérica. Numerações não numéricas (P, M, G…) vão depois, na ordem cadastrada
  // (disponíveis primeiro). Se um tamanho estiver nas duas listas (dado antigo/inconsistente), vale como disponível.
  function buildOptions(product) {
    var available = toList(product && product.sizes);
    var soldOut = toList(product && product.sold_out_sizes);
    var have = {};
    available.forEach(function (s) { have[s.toLowerCase()] = true; });
    var items = available.map(function (s) { return { size: s, soldOut: false }; })
      .concat(soldOut.filter(function (s) { return !have[s.toLowerCase()]; }).map(function (s) { return { size: s, soldOut: true }; }));
    var nums = items.filter(function (i) { return numeric(i.size) !== null; });
    var rest = items.filter(function (i) { return numeric(i.size) === null; });
    nums.sort(function (a, b) { return numeric(a.size) - numeric(b.size); });
    return nums.concat(rest);
  }

  function isSoldOut(options, size) {
    var s = clean(size).toLowerCase();
    return (options || []).some(function (o) { return o.soldOut && o.size.toLowerCase() === s; });
  }

  return { clean: clean, toList: toList, buildOptions: buildOptions, isSoldOut: isSoldOut };
});
