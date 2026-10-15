'use strict';

// Frete: as regras ficam em public/js/shipping-rules.js (as mesmas que o checkout mostra ao cliente).
// Aqui o servidor só recalcula o valor — nada do que o navegador manda sobre preço de frete é usado.

const rules = require('../../../public/js/shipping-rules.js');

function inputError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Lê entrega + endereço do corpo da requisição. Retorna { option, address, acceptsMarketing }.
// subtotalCents = valor dos produtos já com o cupom (não influencia mais o frete: motoboy é a combinar e retirada é grátis).
function parseShipping(body, subtotalCents) {
  const b = body || {};
  const s = b.shipping || {};
  const a = b.address || {};
  const id = clean(s.optionId, 40);
  if (!id) throw inputError('Escolha uma forma de entrega.');

  const cep = rules.digits(a.cep);
  const pickupOnly = id === 'pickup';
  if (!pickupOnly && !rules.validCep(cep)) throw inputError('CEP inválido.');

  const option = rules.find(pickupOnly && !rules.validCep(cep) ? '65000000' : cep, subtotalCents, id);
  if (!option) throw inputError('Esta forma de entrega não está disponível para o seu CEP.', 422);

  let address = null;
  if (option.requiresAddress) {
    const state = clean(a.state, 2).toUpperCase();
    address = {
      cep,
      street: clean(a.street, 120),
      number: clean(a.number, 20),
      complement: clean(a.complement, 80),
      neighborhood: clean(a.neighborhood, 80),
      city: clean(a.city, 80),
      state,
    };
    if (address.street.length < 2) throw inputError('Informe a rua do endereço de entrega.');
    if (!address.number) throw inputError('Informe o número do endereço (ou marque "Sem número").');
    if (address.city.length < 2) throw inputError('Informe a cidade do endereço de entrega.');
    if (!UFS.has(state)) throw inputError('Estado inválido no endereço de entrega.');
  } else if (rules.validCep(cep)) {
    address = { cep, street: clean(a.street, 120), number: clean(a.number, 20), complement: clean(a.complement, 80), neighborhood: clean(a.neighborhood, 80), city: clean(a.city, 80), state: clean(a.state, 2).toUpperCase() };
  }
  return { option, address, acceptsMarketing: b.acceptsMarketing === true };
}

// CPF (11) ou CNPJ (14).
function validCnpj(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    let sum = 0, pos = len - 7;
    for (let i = len; i >= 1; i--) { sum += Number(c[len - i]) * pos--; if (pos < 2) pos = 9; }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

module.exports = { parseShipping, validCnpj, rules };
