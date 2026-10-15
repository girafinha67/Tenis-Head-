/* Tênis Head — regras de entrega (frete).
   Arquivo ÚNICO usado pelo navegador (checkout) e pelo servidor (netlify/functions/lib/shipping.js),
   então o valor mostrado ao cliente é sempre o mesmo que o servidor cobra.
   >>> Para mudar preços, prazos ou a região de entrega local, edite SÓ a seção CONFIG abaixo. <<< */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShippingRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================== CONFIG ==============================
  var CONFIG = {
    // Entrega local por motoboy: CEPs de São Luís, São José de Ribamar, Paço do Lumiar e Raposa.
    localCepFrom: 65000000,
    localCepTo: 65139999,
    motoboyPaidCents: 1500,        // "Entrega via Motoboy" (mesmo dia se pedir até as 14h)
    motoboyCutoffHour: 14,
    sedexFreeFromCents: 49900,     // SEDEX grátis a partir deste subtotal (0 = nunca)
    // SEDEX por região (tabela fixa — não é cotação ao vivo dos Correios).
    sedex: {
      MA: { cents: 1452, days: 4 },
      NE: { cents: 2490, days: 5 },   // demais estados do Nordeste
      N:  { cents: 3290, days: 7 },
      CO: { cents: 3290, days: 7 },
      SE: { cents: 3490, days: 6 },
      S:  { cents: 3990, days: 7 }
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
  var REGION = {
    MA: 'MA', PI: 'NE', CE: 'NE', RN: 'NE', PB: 'NE', PE: 'NE', AL: 'NE', SE: 'NE', BA: 'NE',
    AC: 'N', AP: 'N', AM: 'N', PA: 'N', RO: 'N', RR: 'N', TO: 'N',
    DF: 'CO', GO: 'CO', MT: 'CO', MS: 'CO',
    SP: 'SE', RJ: 'SE', MG: 'SE', ES: 'SE', PR: 'S', SC: 'S', RS: 'S'
  };

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

  // Opções disponíveis para o CEP. subtotalCents = valor dos produtos já com cupom.
  // Cada opção: { id, kind, label, detail, priceCents, minDays, maxDays, requiresAddress }
  function options(cep, subtotalCents) {
    var out = [];
    var uf = ufFromCep(cep);
    var local = isLocal(cep);
    if (local) {
      out.push({ id: 'motoboy_free', kind: 'motoboy', label: 'ENTREGA GRÁTIS EM SÃO LUÍS/Adjacentes - VIA MOTOBOY',
        detail: '', priceCents: 0, minDays: 0, maxDays: 1, requiresAddress: true });
    }
    if (uf) {
      var cfg = CONFIG.sedex[REGION[uf]] || CONFIG.sedex.SE;
      var free = CONFIG.sedexFreeFromCents > 0 && subtotalCents >= CONFIG.sedexFreeFromCents;
      out.push({ id: 'sedex', kind: 'correios', label: 'Correios SEDEX', detail: '',
        priceCents: free ? 0 : cfg.cents, minDays: cfg.days, maxDays: cfg.days, requiresAddress: true });
    }
    if (local) {
      out.push({ id: 'motoboy_paid', kind: 'motoboy', label: 'Entrega via Motoboy',
        detail: 'Pedidos realizados até às ' + CONFIG.motoboyCutoffHour + 'h são entregues no mesmo dia. O horário de entrega pode variar de acordo com a rota. Aguarde nosso contato pelo WhatsApp para mais informações.',
        priceCents: CONFIG.motoboyPaidCents, minDays: 0, maxDays: 1, requiresAddress: true, sameDayCutoff: CONFIG.motoboyCutoffHour });
      out.push({ id: 'uber99', kind: 'app', label: 'UBER / 99',
        detail: 'A corrida é paga por você direto ao motorista. Combinamos pelo WhatsApp.',
        priceCents: 0, minDays: 0, maxDays: 1, requiresAddress: true });
    }
    out.push({ id: 'pickup', kind: 'pickup', label: CONFIG.pickup.label, detail: CONFIG.pickup.detail,
      priceCents: 0, minDays: 0, maxDays: 0, requiresAddress: false });
    return out;
  }

  function find(cep, subtotalCents, id) {
    var list = options(cep, subtotalCents);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  return { CONFIG: CONFIG, digits: digits, validCep: validCep, ufFromCep: ufFromCep, isLocal: isLocal, options: options, find: find };
});
