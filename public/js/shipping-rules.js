/* Tênis Head — regras de entrega (frete).
   Arquivo ÚNICO usado pelo navegador (checkout) e pelo servidor (netlify/functions/lib/shipping.js),
   então as opções mostradas ao cliente são sempre as mesmas que o servidor aceita.
   Formas de entrega: retirada na loja e motoboy a combinar pelo WhatsApp (região local). Sem Sedex.
   >>> Para mudar textos ou a região de entrega local, edite SÓ a seção CONFIG abaixo. <<< */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShippingRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================== CONFIG ==============================
  var CONFIG = {
    // Entrega local por motoboy: CEPs de São Luís, São José de Ribamar, Paço do Lumiar e Raposa.
    // Valor e horário são combinados com a loja pelo WhatsApp (nada é cobrado no checkout pela entrega).
    localCepFrom: 65000000,
    localCepTo: 65139999,
    motoboy: {
      label: 'ENTREGA EM SÃO LUÍS/Adjacentes - VIA MOTOBOY (A COMBINAR VIA WHATSAPP)',
      detail: 'Valor e horário da entrega são combinados com a loja pelo WhatsApp depois do pedido.'
    },
    pickup: {
      label: 'RETIRAR NA LOJA TÊNIS HEAD',
      detail: 'São Luís — MA. Endereço e horário confirmados pelo WhatsApp.'
    }
  };
  // ====================================================================

  var UF_RANGES = [ // [até CEP (5 primeiros dígitos), UF]
    [19999, 'SP'], [28999, 'RJ'], [29999, 'ES'], [39999, 'MG'], [48999, 'BA'], [49999, 'SE'],
    [56999, 'PE'], [57999, 'AL'], [58999, 'PB'], [59999, 'RN'], [63999, 'CE'], [64999, 'PI'],
    [65999, 'MA'], [68899, 'PA'], [68999, 'AP'], [69299, 'AM'], [69399, 'RR'], [69899, 'AM'],
    [69999, 'AC'], [72799, 'DF'], [73699, 'DF'], [76799, 'GO'], [76999, 'RO'], [77995, 'TO'],
    [78899, 'MT'], [78999, 'RO'], [79999, 'MS'], [87999, 'PR'], [89999, 'SC'], [99999, 'RS']
  ];
  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function validCep(cep) { var d = digits(cep); return d.length === 8 && !/^0{8}$/.test(d); }

  function ufFromCep(cep) {
    var d = digits(cep);
    if (d.length !== 8) return null;
    var n = Number(d.slice(0, 5));
    if (n < 1000) return null;
    for (var i = 0; i < UF_RANGES.length; i++) if (n <= UF_RANGES[i][0]) return UF_RANGES[i][1];
    return null;
  }
  function isLocal(cep) {
    var d = digits(cep);
    if (d.length !== 8) return false;
    var n = Number(d);
    return n >= CONFIG.localCepFrom && n <= CONFIG.localCepTo;
  }

  // Opções disponíveis para o CEP. subtotalCents é mantido por compatibilidade (não influencia mais o frete).
  // Cada opção: { id, kind, label, detail, priceCents, minDays, maxDays, requiresAddress, toArrange }
  // toArrange = true → valor/horário combinados pelo WhatsApp (priceCents fica 0 no checkout).
  function options(cep, subtotalCents) {
    var out = [];
    if (isLocal(cep)) {
      out.push({ id: 'motoboy', kind: 'motoboy', label: CONFIG.motoboy.label, detail: CONFIG.motoboy.detail,
        priceCents: 0, minDays: 0, maxDays: 1, requiresAddress: true, toArrange: true });
    }
    out.push({ id: 'pickup', kind: 'pickup', label: CONFIG.pickup.label, detail: CONFIG.pickup.detail,
      priceCents: 0, minDays: 0, maxDays: 0, requiresAddress: false, toArrange: false });
    return out;
  }

  function find(cep, subtotalCents, id) {
    var list = options(cep, subtotalCents);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  return { CONFIG: CONFIG, digits: digits, validCep: validCep, ufFromCep: ufFromCep, isLocal: isLocal, options: options, find: find };
});
