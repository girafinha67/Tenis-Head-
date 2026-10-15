'use strict';

// Testes automatizados. Usam FAKES (ver tests/helpers.js) para a API do Mercado Pago e para o banco.
// Não fazem chamadas reais, não confirmam pagamento real e não executam SQL no Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClient, verifyWebhookSignature, GatewayError, mapStatus } = require('../netlify/functions/lib/mercadopago');
const { createPayments, PaymentError } = require('../netlify/functions/lib/payments');
const { processWebhook } = require('../netlify/functions/lib/mercadopago-webhook');
const H = require('./helpers');

const ENV = { MERCADOPAGO_ACCESS_TOKEN: H.API_KEY, MERCADOPAGO_WEBHOOK_SECRET: H.WEBHOOK_SECRET, MERCADOPAGO_TIMEOUT_MS: '200' };
const GET_A = 'GET /v1/payments/' + H.TX_A;

function setup({ orders, stock, routes = {}, notify } = {}) {
  const store = H.makeFakeStore({ orders, stock });
  const fetchImpl = H.makeFakeFetch(routes);
  const client = createClient({ env: ENV, fetchImpl });
  const log = H.makeLogger();
  const notified = [];
  const payments = createPayments({ store, client, log, notifyPaid: notify || (async (id) => { notified.push(id); }) });
  // Simula uma notificação do Mercado Pago: POST ?data.id=<id>&type=payment
  const webhook = ({ id = H.TX_A, secret = H.WEBHOOK_SECRET, signature, raw, type = 'payment', query } = {}) => {
    const body = raw !== undefined ? Buffer.from(raw) : Buffer.from(JSON.stringify({ action: 'payment.updated', type, data: { id } }));
    const sig = signature === undefined ? H.sign({ dataId: id }) : signature;
    return processWebhook(
      { payments, client, store, secret, log },
      { rawBody: body, headers: sig === null ? {} : { 'X-Signature': sig, 'X-Request-Id': 'req-test-1' }, query: query || { 'data.id': id, type } }
    );
  };
  return { store, fetchImpl, client, log, payments, notified, webhook };
}

// ------------------------------------------------------------------ criação de cobrança
test('cria cobrança PIX: endpoint, Bearer, idempotência, corpo e dados do gateway', async () => {
  const s = setup({ orders: [H.makeOrder({ mp_id: null })], routes: { 'POST /v1/payments': H.goodCreate(14990) } });
  const out = await s.payments.startPixCharge(s.store.state.orders.get('order-A'));
  const call = s.fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.mercadopago.com/v1/payments');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, `Bearer ${H.API_KEY}`);
  assert.equal(call.headers['X-Idempotency-Key'], 'mc-A');
  const sent = JSON.parse(call.body);
  assert.equal(sent.transaction_amount, 149.9);
  assert.equal(sent.payment_method_id, 'pix');
  assert.equal(sent.external_reference, 'order-A');
  assert.equal(sent.payer.email, 'cliente@exemplo.com');
  assert.deepEqual(sent.payer.identification, { type: 'CPF', number: '12345678909' });
  assert.match(sent.date_of_expiration, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-03:00$/);
  assert.equal(out.mp_id, H.TX_A);
  assert.equal(out.pix_qr_code, '00020126580014br.gov.bcb.pix6304ABCD');
  assert.match(out.pix_qr_code_base64, /^data:image\/png;base64,/);
  assert.equal(out.status, 'PENDING');
});

test('falha de comunicação: pedido vira ERROR, estoque volta, erro público sem detalhes', async () => {
  const s = setup({ orders: [H.makeOrder({ mp_id: null })], stock: { 1: 8 }, routes: { 'POST /v1/payments': new Error('ECONNRESET') } });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e instanceof PaymentError && e.status === 502);
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'ERROR');
  assert.equal(o.stock_reserved, 0);
  assert.equal(s.store.state.stock[1], 10);
  assert.equal(s.fetchImpl.calls.length, 1, 'POST não é repetido automaticamente');
});

test('timeout da API: GATEWAY_TIMEOUT, sem retry, estoque devolvido', async () => {
  const s = setup({ orders: [H.makeOrder({ mp_id: null })], stock: { 1: 8 }, routes: { 'POST /v1/payments': 'hang' } });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e.status === 504 && e.code === 'GATEWAY_TIMEOUT');
  assert.equal(s.store.state.orders.get('order-A').status, 'ERROR');
  assert.equal(s.store.state.stock[1], 10);
});

for (const [nome, over] of [
  ['sem copia-e-cola', { point_of_interaction: { transaction_data: { qr_code_base64: 'iVBORw0KGgo=' } } }],
  ['sem QR Code', { point_of_interaction: { transaction_data: { qr_code: '0002012658' } } }],
  ['sem id', { id: undefined }],
  ['valor diferente do solicitado', { transaction_amount: 0.01 }],
  ['status diferente de pending', { status: 'approved' }],
]) {
  test(`resposta inválida do gateway (${nome}) é rejeitada e nunca vira QR`, async () => {
    const s = setup({ orders: [H.makeOrder({ mp_id: null })], routes: { 'POST /v1/payments': H.goodCreate(14990, over) } });
    await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e instanceof PaymentError && e.status === 502);
    const o = s.store.state.orders.get('order-A');
    assert.equal(o.status, 'ERROR');
    assert.equal(o.pix_qr_code, undefined);
  });
}

test('resposta não-JSON do gateway é rejeitada', async () => {
  const client = createClient({ env: ENV, fetchImpl: H.makeFakeFetch({ 'POST /v1/payments': { status: 201, raw: '<html>oops</html>' } }) });
  await assert.rejects(() => client.createPixCharge({ amountCents: 100, email: 'a@b.com' }), (e) => e instanceof GatewayError && e.gatewayCode === 'INVALID_GATEWAY_RESPONSE');
});

test('sem e-mail do pagador a cobrança nem chega ao gateway', async () => {
  const fetchImpl = H.makeFakeFetch({});
  const client = createClient({ env: ENV, fetchImpl });
  await assert.rejects(() => client.createPixCharge({ amountCents: 100 }), (e) => e.gatewayCode === 'PAYER_INVALID');
  assert.equal(fetchImpl.calls.length, 0);
});

test('erros: 429 vira "tente novamente"; 401 não vaza o token', async () => {
  const s1 = setup({ orders: [H.makeOrder({ mp_id: null })], routes: { 'POST /v1/payments': { status: 429, body: { message: 'x' } } } });
  await assert.rejects(() => s1.payments.startPixCharge(s1.store.state.orders.get('order-A')), (e) => e.status === 429);
  const s2 = setup({ orders: [H.makeOrder({ mp_id: null })], routes: { 'POST /v1/payments': { status: 401, body: { message: 'invalid access token', error: 'unauthorized', status: 401 } } } });
  await assert.rejects(() => s2.payments.startPixCharge(s2.store.state.orders.get('order-A')), (e) => e.status === 502 && !e.message.includes('APP_USR'));
});

test('valor abaixo de 50 centavos nem chega ao gateway', async () => {
  const s = setup({ orders: [H.makeOrder({ mp_id: null, amount: 0.3 })] });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')), (e) => e.status === 400);
  assert.equal(s.fetchImpl.calls.length, 0);
});

test('access token e secret nunca aparecem nos logs', async () => {
  const s = setup({ orders: [H.makeOrder({ mp_id: null })], routes: { 'POST /v1/payments': { status: 401, body: { message: 'nope' } } } });
  await assert.rejects(() => s.payments.startPixCharge(s.store.state.orders.get('order-A')));
  await s.webhook({ signature: 'ts=1,v1=bad' });
  const all = s.log.lines.join('\n');
  assert.ok(!all.includes(H.API_KEY) && !all.includes(H.WEBHOOK_SECRET));
});

test('mapStatus: approved->PAID, rejected/cancelled->FAILED, demais->PENDING', () => {
  assert.equal(mapStatus('approved'), 'PAID');
  assert.equal(mapStatus('rejected'), 'FAILED');
  assert.equal(mapStatus('cancelled'), 'FAILED');
  assert.equal(mapStatus('pending'), 'PENDING');
  assert.equal(mapStatus('in_process'), 'PENDING');
});

// ------------------------------------------------------------------ assinatura
test('verifyWebhookSignature: manifest id;request-id;ts com HMAC-SHA256', () => {
  const sig = H.sign({ dataId: 'ABC123', requestId: 'r1', ts: '99', secret: 's3' });
  const ok = (o) => verifyWebhookSignature({ signatureHeader: sig, requestId: 'r1', dataId: 'abc123', secret: 's3', ...o });
  assert.equal(ok({}), true);
  assert.equal(ok({ dataId: 'ABC123' }), true, 'id alfanumérico é comparado em minúsculas');
  assert.equal(ok({ secret: 'outra' }), false);
  assert.equal(ok({ requestId: 'r2' }), false);
  assert.equal(ok({ dataId: '999' }), false);
  assert.equal(ok({ signatureHeader: 'ts=99' }), false, 'sem v1');
  assert.equal(ok({ signatureHeader: 'ts=99,v1=abc' }), false, 'tamanho diferente não lança');
  assert.equal(ok({ signatureHeader: undefined }), false);
  assert.equal(ok({ secret: '' }), false);
});

// ------------------------------------------------------------------ webhook
test('webhook válido + confirmação na API: pedido PENDING -> PAID, notificação enfileirada e enviada', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet() } });
  const r = await s.webhook();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.duplicate, false);
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'PAID');
  assert.equal(o.transaction_id, H.TX_A);
  assert.equal(s.store.state.stock[1], 10, 'estoque já estava reservado; não é debitado de novo');
  assert.deepEqual([...s.store.state.notifications], ['order-A']);
  assert.deepEqual(s.notified, ['order-A']);
  assert.equal(s.fetchImpl.calls[0].headers.Authorization, `Bearer ${H.API_KEY}`);
});

test('assinatura inválida, ausente ou de outro segredo: 401 e nada muda', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet() } });
  for (const opt of [{ signature: 'ts=1,v1=' + '0'.repeat(64) }, { signature: null }, { signature: H.sign({ dataId: H.TX_A, secret: 'outro' }) }, { signature: H.sign({ dataId: H.TX_B }) }]) {
    const r = await s.webhook(opt);
    assert.equal(r.statusCode, 401);
  }
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
  assert.equal(s.fetchImpl.calls.length, 0, 'nem consulta a API antes de validar a assinatura');
});

test('sem MERCADOPAGO_WEBHOOK_SECRET o webhook recusa tudo (500)', async () => {
  const s = setup();
  const r = await s.webhook({ secret: '' });
  assert.equal(r.statusCode, 500);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('notificação duplicada: segunda entrega é idempotente (200, duplicate, sem efeitos)', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet() } });
  assert.equal((await s.webhook()).body.duplicate, false);
  const second = await s.webhook();
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(s.notified.length, 1);
  assert.equal(s.store.state.events.size, 1);
});

test('pagamento sem pedido nesta loja: 200 ignorado (e não consulta a API)', async () => {
  const s = setup({ routes: { 'GET *': H.goodGet() } });
  const r = await s.webhook({ id: H.TX_C });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ignored, true);
  assert.equal(s.fetchImpl.calls.length, 0);
});

test('valor divergente na API: 409, pedido segue PENDING e o evento pode ser reenviado', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet({ transaction_amount: 1 }) } });
  const r = await s.webhook();
  assert.equal(r.statusCode, 409);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
  assert.equal(s.store.state.events.size, 0, 'rollback: evento não ficou marcado como processado');
  assert.equal(s.notified.length, 0);
});

test('forma de pagamento diferente de PIX: 409', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet({ payment_method_id: 'visa' }) } });
  assert.equal((await s.webhook()).statusCode, 409);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('webhook chega mas a API ainda diz pending: 200 pendente, nada muda', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet({ status: 'pending' }) } });
  const r = await s.webhook();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.pending, true);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('falha ao consultar a API durante o webhook: 502 (fail closed), pedido não é pago', async () => {
  const s = setup({ routes: { [GET_A]: new Error('network down') } });
  const r = await s.webhook();
  assert.equal(r.statusCode, 502);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('resposta da API com id de outro pagamento é rejeitada (um pedido não altera outro)', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet({ id: Number(H.TX_B) }) } });
  const r = await s.webhook();
  assert.equal(r.statusCode, 502);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
});

test('isolamento: evento do pagamento A só altera o pedido A', async () => {
  const orderB = H.makeOrder({ id: 'order-B', merchant_charge_id: 'mc-B', mp_id: H.TX_B });
  const s = setup({ orders: [H.makeOrder(), orderB], routes: { [GET_A]: H.goodGet() } });
  await s.webhook();
  assert.equal(s.store.state.orders.get('order-A').status, 'PAID');
  assert.equal(s.store.state.orders.get('order-B').status, 'PENDING');
});

test('pagamento rejeitado/cancelado encerra o pedido pendente e devolve o estoque', async () => {
  const s = setup({ stock: { 1: 8 }, routes: { [GET_A]: H.goodGet({ status: 'cancelled' }) } });
  const r = await s.webhook();
  assert.equal(r.statusCode, 200);
  assert.equal(s.store.state.orders.get('order-A').status, 'FAILED');
  assert.equal(s.store.state.stock[1], 10);
});

test('falha depois de PAID nunca desfaz o pagamento', async () => {
  const s = setup({ orders: [H.makeOrder({ status: 'PAID', stock_reserved: 0 })], routes: { [GET_A]: H.goodGet({ status: 'rejected' }) } });
  await s.webhook();
  assert.equal(s.store.state.orders.get('order-A').status, 'PAID');
});

test('notificação de teste do painel (id 123456) e tipos desconhecidos: 200 sem alterar nada', async () => {
  const s = setup();
  const t = await s.webhook({ id: '123456' });
  assert.equal(t.statusCode, 200);
  const ign = await s.webhook({ type: 'merchant_order' });
  assert.equal(ign.statusCode, 200);
  assert.equal(ign.body.ignored, true);
  assert.equal(s.store.state.orders.get('order-A').status, 'PENDING');
  assert.equal(s.fetchImpl.calls.length, 0);
});

test('id inválido (com assinatura válida) -> 400', async () => {
  const s = setup();
  assert.equal((await s.webhook({ id: '../../etc' })).statusCode, 400);
});

// ------------------------------------------------------------------ estados / reconciliação / repetição
test('pagamento tardio após expiração: reserva o estoque de novo e marca PAID', async () => {
  const s = setup({ orders: [H.makeOrder({ status: 'EXPIRED', stock_reserved: 0 })], stock: { 1: 10 }, routes: { [GET_A]: H.goodGet() } });
  await s.webhook();
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'PAID');
  assert.equal(s.store.state.stock[1], 8);
  assert.equal(o.error_message, null);
});

test('pagamento tardio sem estoque: continua PAID (dinheiro recebido) e sinaliza revisão', async () => {
  const s = setup({ orders: [H.makeOrder({ status: 'EXPIRED', stock_reserved: 0 })], stock: { 1: 0 }, routes: { [GET_A]: H.goodGet() } });
  await s.webhook();
  const o = s.store.state.orders.get('order-A');
  assert.equal(o.status, 'PAID');
  assert.match(o.error_message, /revisar/);
});

test('pedido vencido e não pago: refresh marca EXPIRED e devolve o estoque', async () => {
  const past = new Date(Date.now() - 10 * 60000).toISOString();
  const s = setup({ orders: [H.makeOrder({ pix_expires_at: past })], stock: { 1: 8 }, routes: { [GET_A]: H.goodGet({ status: 'pending' }) } });
  const after = await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(after.status, 'EXPIRED');
  assert.equal(s.store.state.stock[1], 10);
});

test('pedido ainda dentro do prazo e pending na API continua PENDING', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet({ status: 'pending' }) } });
  const after = await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(after.status, 'PENDING');
});

test('refresh: pagamento cancelado no gateway encerra o pedido', async () => {
  const s = setup({ stock: { 1: 8 }, routes: { [GET_A]: H.goodGet({ status: 'cancelled' }) } });
  const after = await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(after.status, 'FAILED');
  assert.equal(s.store.state.stock[1], 10);
});

test('consultas repetidas do navegador: no máximo 1 chamada à API por janela (throttle)', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet({ status: 'pending' }) } });
  for (let i = 0; i < 5; i++) await s.payments.refreshOrder(s.store.state.orders.get('order-A'));
  assert.equal(s.fetchImpl.calls.length, 1);
});

test('refresh confirma pagamento pela API (sem webhook) e é idempotente', async () => {
  const s = setup({ routes: { [GET_A]: H.goodGet() } });
  const a = await s.payments.refreshOrder(s.store.state.orders.get('order-A'), { force: true });
  assert.equal(a.status, 'PAID');
  const b = await s.payments.refreshOrder(s.store.state.orders.get('order-A'), { force: true });
  assert.equal(b.status, 'PAID');
  assert.equal(s.notified.length, 1);
});

test('reconciliação agendada: paga, expirada e com erro são contadas', async () => {
  const past = new Date(Date.now() - 10 * 60000).toISOString();
  const s = setup({
    orders: [H.makeOrder(), H.makeOrder({ id: 'order-B', mp_id: H.TX_B, pix_expires_at: past }), H.makeOrder({ id: 'order-C', mp_id: H.TX_C })],
    routes: {
      [GET_A]: H.goodGet(),
      ['GET /v1/payments/' + H.TX_B]: H.goodGet({ id: Number(H.TX_B), status: 'pending' }),
      ['GET /v1/payments/' + H.TX_C]: new Error('down'),
    },
  });
  const sum = await s.payments.reconcilePending();
  assert.deepEqual({ checked: sum.checked, paid: sum.paid, expired: sum.expired, failed: sum.failed }, { checked: 3, paid: 1, expired: 1, failed: 1 });
});

// ------------------------------------------------------------------ proteção contra o cliente
test('não existe rota/handler que aceite status vindo do navegador', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../netlify/functions/routes/orders.routes.js'), 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*(\[[^\]]+\]|'[^']+')/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.equal(routes.filter((r) => /^(PUT|PATCH|DELETE)/.test(r)).length, 0);
  assert.ok(routes.some((r) => r.startsWith('GET') && r.includes('/payments/orders/:id')));
  assert.ok(!/req\.(body|query|params)\.status/.test(src), 'nenhum status é lido da requisição');
});

test('a Netlify Function do webhook só aceita POST', async () => {
  const { handler } = require('../netlify/functions/mercadopago-webhook');
  const r = await handler({ httpMethod: 'GET', headers: {}, body: null });
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers.Allow, 'POST');
});

test('WhatsApp via CallMeBot: monta a URL com texto codificado (fetch falso, sem rede)', async () => {
  const wa = require('../netlify/functions/lib/whatsapp');
  const saved = { fetch: globalThis.fetch, k: process.env.CALLMEBOT_API_KEY, p: process.env.WHATSAPP_OWNER_PHONE };
  let seen;
  globalThis.fetch = async (url) => { seen = url; return { ok: true, status: 200, text: async () => 'Message queued' }; };
  process.env.CALLMEBOT_API_KEY = 'KEY123'; process.env.WHATSAPP_OWNER_PHONE = '+55 11 90000-0000';
  try {
    const r = await wa.notifyOwner('Total R$ 10,00 & mais');
    assert.equal(r.sent, true);
    assert.ok(seen.startsWith('https://api.callmebot.com/whatsapp.php?phone=5511900000000&text='));
    assert.ok(seen.includes('R%24%2010') && seen.includes('%26') && seen.endsWith('&apikey=KEY123'));
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.k === undefined) delete process.env.CALLMEBOT_API_KEY; else process.env.CALLMEBOT_API_KEY = saved.k;
    if (saved.p === undefined) delete process.env.WHATSAPP_OWNER_PHONE; else process.env.WHATSAPP_OWNER_PHONE = saved.p;
  }
});
