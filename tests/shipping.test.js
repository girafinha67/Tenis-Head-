'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../netlify/functions/lib/shipping');

const addr = { cep: '65125-145', street: 'Rua Itaúna', number: '1', neighborhood: 'Araçagy', city: 'São José de Ribamar', state: 'MA' };

test('CEP local libera só motoboy (a combinar via WhatsApp) e retirada na loja', () => {
  const opts = S.rules.options('65125145', 30000);
  assert.deepEqual(opts.map((o) => o.id), ['motoboy', 'pickup']);
  assert.equal(opts[0].priceCents, 0);
  assert.equal(opts[0].toArrange, true);
  assert.match(opts[0].label, /WHATSAPP/);
  assert.doesNotMatch(opts[0].label, /GR[ÁA]TIS/i);
});
test('CEP de fora: só retirada na loja, sem Sedex', () => {
  assert.deepEqual(S.rules.options('01310100', 30000).map((o) => o.id), ['pickup']);
  assert.equal(S.rules.find('01310100', 30000, 'sedex'), null);
});
test('opções removidas não existem mais', () => {
  for (const id of ['motoboy_free', 'motoboy_paid', 'uber99', 'sedex']) assert.equal(S.rules.find('65125145', 30000, id), null);
});
test('servidor recalcula o frete (motoboy a combinar = R$ 0) e valida o endereço', () => {
  const r = S.parseShipping({ shipping: { optionId: 'motoboy', priceCents: 999 }, address: addr }, 30000);
  assert.equal(r.option.priceCents, 0, 'preço enviado pelo navegador é ignorado');
  assert.equal(r.address.cep, '65125145');
  assert.throws(() => S.parseShipping({ shipping: { optionId: 'motoboy' }, address: { ...addr, cep: '01310100' } }, 30000), /não está disponível/);
  assert.throws(() => S.parseShipping({ shipping: { optionId: 'sedex' }, address: addr }, 30000), /não está disponível/);
  assert.throws(() => S.parseShipping({ shipping: { optionId: 'motoboy' }, address: { ...addr, number: '' } }, 30000), /número/);
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
