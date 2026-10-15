'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../netlify/functions/lib/shipping');

const addr = { cep: '65125-145', street: 'Rua Itaúna', number: '1', neighborhood: 'Araçagy', city: 'São José de Ribamar', state: 'MA' };

test('CEP local libera motoboy grátis, motoboy pago, Uber/99, SEDEX e retirada', () => {
  const ids = S.rules.options('65125145', 30000).map((o) => o.id);
  assert.deepEqual(ids, ['motoboy_free', 'sedex', 'motoboy_paid', 'uber99', 'pickup']);
});
test('CEP de fora não tem motoboy; SEDEX por região e grátis acima do mínimo', () => {
  assert.deepEqual(S.rules.options('01310100', 30000).map((o) => o.id), ['sedex', 'pickup']);
  assert.equal(S.rules.find('01310100', 30000, 'sedex').priceCents, 3490);
  assert.equal(S.rules.find('01310100', 49900, 'sedex').priceCents, 0);
});
test('servidor recalcula o frete e valida o endereço', () => {
  const r = S.parseShipping({ shipping: { optionId: 'motoboy_paid', priceCents: 1 }, address: addr }, 30000);
  assert.equal(r.option.priceCents, 1500, 'preço enviado pelo navegador é ignorado');
  assert.equal(r.address.cep, '65125145');
  assert.throws(() => S.parseShipping({ shipping: { optionId: 'motoboy_free' }, address: { ...addr, cep: '01310100' } }, 30000), /não está disponível/);
  assert.throws(() => S.parseShipping({ shipping: { optionId: 'sedex' }, address: { ...addr, number: '' } }, 30000), /número/);
  assert.throws(() => S.parseShipping({ address: addr }, 30000), /forma de entrega/);
});
test('retirada na loja não exige endereço', () => {
  const r = S.parseShipping({ shipping: { optionId: 'pickup' }, address: {} }, 30000);
  assert.equal(r.address, null);
});
test('CNPJ válido/inválido', () => {
  assert.equal(S.validCnpj('11.222.333/0001-81'), true);
  assert.equal(S.validCnpj('11.222.333/0001-82'), false);
});
