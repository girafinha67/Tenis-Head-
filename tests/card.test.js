'use strict';

// Testes do pagamento com cartão (crédito/débito) e do cálculo de parcelas com acréscimo.
// Usam FAKES (tests/helpers.js): nenhuma chamada real ao Mercado Pago nem ao Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../netlify/functions/lib/card-fees');
const CP = require('../netlify/functions/lib/card-payment');
const S = require('../netlify/functions/lib/site-settings');
const { createClient, cardMessage } = require('../netlify/functions/lib/mercadopago');
const { createPayments, PaymentError } = require('../netlify/functions/lib/payments');
const { processWebhook } = require('../netlify/functions/lib/mercadopago-webhook');
const H = require('./helpers');

const ENV = { MERCADOPAGO_ACCESS_TOKEN: H.API_KEY, MERCADOPAGO_PUBLIC_KEY: 'APP_USR-pub', MERCADOPAGO_WEBHOOK_SECRET: H.WEBHOOK_SECRET, MERCADOPAGO_TIMEOUT_MS: '200' };
const settings = S.sanitize({}, S.DEFAULTS);
const GET_A = 'GET /v1/payments/' + H.TX_A;
const CARD = { token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', paymentMethodId: 'visa', issuerId: '25', installments: 3, deviceId: 'device-abc-123' };

// ------------------------------------------------------------------ parcelas e acréscimo
test('acréscimo por parcela: percentual total sobre o valor, tabela padrão', () => {
  const q6 = F.quote(10000, settings.card, { type: 'credit_card', installments: 6 });
  assert.deepEqual([q6.ratePercent, q6.feeCents, q6.totalCents, q6.installmentCents], [8.5, 850, 10850, 1808]);
  const q1 = F.quote(10000, settings.card, { type: 'credit_card', installments: 1 });
  assert.equal(q1.feeCents, 0);
  assert.equal(F.quote(10000, { ...settings.card, debitFee: 2 }, { type: 'debit_card', installments: 9 }).installments, 1);
  assert.equal(F.quote(10000, { ...settings.card, debitFee: 2 }, { type: 'debit_card', installments: 9 }).feeCents, 200);
});

test('opções de crédito respeitam máximo de parcelas e valor mínimo da parcela', () => {
  assert.equal(F.creditOptions(100000, settings.card).length, 12);
  assert.equal(F.creditOptions(100000, { ...settings.card, maxInstallments: 6 }).length, 6);
  // R$ 12,00 com mínimo de R$ 5,00 por parcela => só 1x e 2x
  assert.deepEqual(F.creditOptions(1200, settings.card).map((o) => o.installments), [1, 2]);
});

test('configurações do cartão: sanitização e limites', () => {
  const c = S.sanitize({ card: { maxInstallments: 99, rates: [1, 'x', 900], debitFee: -5, credit: 'false' } }, S.DEFAULTS).card;
  assert.equal(c.maxInstallments, 12);
  assert.equal(c.rates.length, 12);
  assert.equal(c.rates[0], 1);
  assert.equal(c.rates[1], 4.5); // inválido mantém o valor anterior
  assert.equal(c.rates[2], 50); // limite de 50%
  assert.equal(c.debitFee, 0);
  assert.equal(c.credit, false);
});

// ------------------------------------------------------------------ leitura/validação do pedido
test('pagamento: padrão é Pix; cartão exige token, bandeira e chave pública configurada', () => {
  assert.deepEqual(CP.parsePayment({}, settings, ENV), { method: 'pix' });
  assert.throws(() => CP.parsePayment({ paymentMethod: 'credit_card', card: CARD }, settings, {}), (e) => e.status === 503);
  assert.throws(() => CP.parsePayment({ paymentMethod: 'credit_card', card: { ...CARD, token: 'curto' } }, settings, ENV), (e) => e.status === 400);
  assert.throws(() => CP.parsePayment({ paymentMethod: 'boleto' }, settings, ENV), (e) => e.status === 400);
  const noDebit = S.sanitize({ card: { debit: false } }, S.DEFAULTS);
  assert.throws(() => CP.parsePayment({ paymentMethod: 'debit_card', card: CARD }, noDebit, ENV), (e) => e.status === 422);
  const p = CP.parsePayment({ paymentMethod: 'debit_card', card: { ...CARD, installments: 6 } }, settings, ENV);
  assert.equal(p.installments, 1); // débito é sempre à vista
});

test('valor final é calculado no servidor e confere com o que o cliente viu', () => {
  const p = CP.parsePayment({ paymentMethod: 'credit_card', card: { ...CARD, installments: 6 }, expectedAmount: 108.5 }, settings, ENV);
  const out = CP.priceOrder(10000, p, settings);
  assert.deepEqual([out.feeCents, out.totalCents, out.installments], [850, 10850, 6]);
  const stale = CP.parsePayment({ paymentMethod: 'credit_card', card: { ...CARD, installments: 6 }, expectedAmount: 100 }, settings, ENV);
  assert.throws(() => CP.priceOrder(10000, stale, settings), (e) => e.status === 409);
  const tooMany = CP.parsePayment({ paymentMethod: 'credit_card', card: { ...CARD, installments: 12 } }, settings, ENV);
  assert.throws(() => CP.priceOrder(1000, tooMany, settings), (e) => e.status === 422); // parcela abaixo do mínimo
  assert.deepEqual(CP.priceOrder(10000, { method: 'pix' }, settings), { feeCents: 0, totalCents: 10000, installments: null });
});

// ------------------------------------------------------------------ cobrança no gateway
function cardResp(over = {}, amountCents = 14990) {
  return {
    status: 201,
    body: {
      id: Number(H.TX_A), status: 'approved', status_detail: 'accredited', transaction_amount: amountCents / 100,
      payment_method_id: 'visa', payment_type_id: 'credit_card', installments: 3,
      card: { last_four_digits: '4242' }, transaction_details: { total_paid_amount: amountCents / 100 },
      ...over,
    },
  };
}
function setup({ orders, stock, routes = {} } = {}) {
  const store = H.makeFakeStore({ orders, stock });
  const fetchImpl = H.makeFakeFetch(routes);
  const client = createClient({ env: ENV, fetchImpl });
  const log = H.makeLogger();
  const notified = [];
  const payments = createPayments({ store, client, log, notifyPaid: async (id) => { notified.push(id); } });
  return { store, fetchImpl, client, log, payments, notified };
}
const cardOrder = (over = {}) => H.makeOrder({ mp_id: null, payment_method: 'credit_card', installments: 3, ...over });

test('cartão: corpo enviado ao Mercado Pago (token, parcelas, bandeira, emissor, 3DS, device id)', async () => {
  const s = setup({ orders: [cardOrder()], routes: { 'POST /v1/payments': cardResp(), [GET_A]: H.goodGet({ payment_method_id: 'visa', payment_type_id: 'credit_card' }) } });
  await s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD);
  const call = s.fetchImpl.calls[0];
  const sent = JSON.parse(call.body);
  assert.equal(call.headers.Authorization, `Bearer ${H.API_KEY}`);
  assert.equal(call.headers['X-Idempotency-Key'], 'mc-A');
  assert.equal(call.headers['X-meli-session-id'], 'device-abc-123');
  assert.equal(sent.transaction_amount, 149.9);
  assert.equal(sent.token, CARD.token);
  assert.equal(sent.installments, 3);
  assert.equal(sent.payment_method_id, 'visa');
  assert.equal(sent.issuer_id, 25);
  assert.equal(sent.three_d_secure_mode, 'optional');
  assert.equal(sent.binary_mode, false);
  assert.equal(sent.external_reference, 'order-A');
  assert.deepEqual(sent.payer.identification, { type: 'CPF', number: '12345678909' });
});

test('cartão aprovado: confirma na API, marca pago, guarda bandeira/final e notifica', async () => {
  const s = setup({ orders: [cardOrder()], routes: { 'POST /v1/payments': cardResp(), [GET_A]: H.goodGet({ payment_method_id: 'visa', payment_type_id: 'credit_card' }) } });
  const out = await s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD);
  assert.equal(out.order.status, 'PAID');
  assert.equal(out.order.card_last4, '4242');
  assert.equal(out.order.card_brand, 'visa');
  assert.equal(out.card.status, 'PAID');
  assert.deepEqual(s.notified, ['order-A']);
  assert.equal(s.fetchImpl.calls.length, 2); // criar + reconsultar
});

test('cartão recusado: pedido FAILED, estoque devolvido e mensagem clara ao cliente', async () => {
  const s = setup({ orders: [cardOrder()], stock: { 1: 8 }, routes: { 'POST /v1/payments': cardResp({ status: 'rejected', status_detail: 'cc_rejected_insufficient_amount' }) } });
  const out = await s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD);
  assert.equal(out.order.status, 'FAILED');
  assert.equal(s.store.state.stock[1], 10);
  assert.match(out.card.message, /Saldo ou limite insuficiente/);
  assert.equal(s.notified.length, 0);
});

test('cartão em análise / aguardando banco (3DS): segue PENDING e devolve o desafio do banco', async () => {
  const challenge = { external_resource_url: 'https://acs.banco.example/challenge', creq: 'abc123' };
  const s = setup({ orders: [cardOrder()], routes: { 'POST /v1/payments': cardResp({ status: 'pending', status_detail: 'pending_challenge', three_ds_info: challenge }) } });
  const out = await s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD);
  assert.equal(out.order.status, 'PENDING');
  assert.deepEqual(out.card.challenge, { url: challenge.external_resource_url, creq: 'abc123' });
  assert.equal(s.store.state.orders.get('order-A').mp_status_detail, 'pending_challenge');
});

test('desafio 3DS só é aceito em https', async () => {
  const s = setup({ orders: [cardOrder()], routes: { 'POST /v1/payments': cardResp({ status: 'pending', status_detail: 'pending_challenge', three_ds_info: { external_resource_url: 'http://x.example', creq: 'a' } }) } });
  const out = await s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD);
  assert.equal(out.card.challenge, null);
});

test('valor devolvido diferente do enviado: não confia, pedido encerrado e estoque volta', async () => {
  const s = setup({ orders: [cardOrder()], stock: { 1: 8 }, routes: { 'POST /v1/payments': cardResp({ transaction_amount: 10 }) } });
  await assert.rejects(() => s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD), (e) => e instanceof PaymentError);
  assert.equal(s.store.state.orders.get('order-A').status, 'ERROR');
  assert.equal(s.store.state.stock[1], 10);
});

test('erro 400 do gateway (dados do cartão): mensagem pública sem detalhes internos', async () => {
  const s = setup({ orders: [cardOrder()], routes: { 'POST /v1/payments': { status: 400, body: { error: 'bad_request', message: 'invalid token', cause: [] } } } });
  await assert.rejects(() => s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD), (e) => e instanceof PaymentError && e.status === 400 && !/token/i.test(e.message));
  assert.equal(s.store.state.orders.get('order-A').status, 'ERROR');
});

test('cartão cobrado mas não vinculado ao pedido: estorna e encerra o pedido', async () => {
  const s = setup({ orders: [cardOrder()], routes: { 'POST /v1/payments': cardResp(), ['POST /v1/payments/' + H.TX_A + '/refunds']: { status: 201, body: { id: 1 } } } });
  s.store.saveCardCharge = async () => false;
  await assert.rejects(() => s.payments.startCardCharge(s.store.state.orders.get('order-A'), CARD), (e) => e.code === 'PERSIST_FAILED');
  assert.ok(s.fetchImpl.calls.some((c) => c.path.endsWith('/refunds')));
  assert.equal(s.store.state.orders.get('order-A').status, 'ERROR');
});

test('pagamento no cartão aprovado com valor diferente do pedido é rejeitado (não marca pago)', async () => {
  const s = setup({ orders: [cardOrder({ mp_id: H.TX_A })], routes: { [GET_A]: H.goodGet({ payment_method_id: 'visa', payment_type_id: 'credit_card', transaction_amount: 120 }) } });
  const tx = await s.client.getTransaction(H.TX_A);
  assert.equal(tx.type, 'CARD');
  await assert.rejects(() => s.payments.applyPaid({ transaction: tx }), (e) => e.code === 'AMOUNT_MISMATCH');
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('webhook confirma cartão que estava em análise e marca como pago', async () => {
  const s = setup({ orders: [cardOrder({ mp_id: H.TX_A, mp_status: 'in_process' })], routes: { [GET_A]: H.goodGet({ payment_method_id: 'visa', payment_type_id: 'credit_card' }) } });
  const body = Buffer.from(JSON.stringify({ action: 'payment.updated', type: 'payment', data: { id: H.TX_A } }));
  const res = await processWebhook(
    { payments: s.payments, client: s.client, store: s.store, secret: H.WEBHOOK_SECRET, log: s.log },
    { rawBody: body, headers: { 'X-Signature': H.sign({ dataId: H.TX_A }), 'X-Request-Id': 'req-test-1' }, query: { 'data.id': H.TX_A, type: 'payment' } }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(s.store.state.orders.get('order-A').status, 'PAID');
});

test('mensagens de recusa traduzidas e genérica para motivos desconhecidos', () => {
  assert.match(cardMessage('cc_rejected_bad_filled_security_code'), /CVV/);
  assert.match(cardMessage('algo_novo_do_mp'), /não foi aprovado/);
});
