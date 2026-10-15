'use strict';

// ============================ FAKES SÓ PARA TESTES ============================
// Nada aqui é usado em produção. Simulam o banco (em memória, com rollback de
// transação) e a API HTTP da Mercado Pago. Não falam com Postgres nem com a rede.

const crypto = require('node:crypto');

const WEBHOOK_SECRET = 'test-only-webhook-secret';
const API_KEY = 'APP_USR-TEST-ONLY-TOKEN-123';
const TX_A = '1234567890';
const TX_B = '1111222233';
const TX_C = '9999888877';

// Assinatura do webhook do Mercado Pago: x-signature = "ts=<ts>,v1=<hmac do manifest>".
function sign({ dataId, requestId = 'req-test-1', ts = '1704908010', secret = WEBHOOK_SECRET } = {}) {
  let manifest = '';
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  return `ts=${ts},v1=${crypto.createHmac('sha256', secret).update(manifest).digest('hex')}`;
}

function makeLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  return { error: push('error'), warn: push('warn'), info: push('info'), log: push('log'), lines };
}

function makeOrder(over = {}) {
  return {
    id: 'order-A', merchant_charge_id: 'mc-A', amount: 149.9, customer_email: 'cliente@exemplo.com', customer_name: 'Maria Silva', customer_cpf: '123.456.789-09', product_name: 'Tênis Teste', status: 'PENDING',
    mp_id: TX_A, mp_status: 'PENDING', stock_reserved: 1, is_cart: 0,
    product_id: 1, quantity: 2, pix_expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
    created_at: new Date().toISOString(), error_message: null, mp_checked_at: null, transaction_id: null,
    ...over,
  };
}

function makeFakeStore({ orders = [makeOrder()], stock = { 1: 10, 2: 10 } } = {}) {
  const state = {
    orders: new Map(orders.map((o) => [o.id, { ...o }])),
    stock: { ...stock },
    events: new Set(),
    notifications: new Set(),
  };
  const snapshot = () => JSON.stringify({ o: [...state.orders], s: state.stock, e: [...state.events], n: [...state.notifications] });
  const restore = (j) => {
    const x = JSON.parse(j);
    state.orders = new Map(x.o); state.stock = x.s; state.events = new Set(x.e); state.notifications = new Set(x.n);
  };
  const byGateway = (id) => [...state.orders.values()].find((o) => o.mp_id === id) || null;
  const clone = (o) => (o ? { ...o } : null);
  const items = (o) => (o.product_id ? [{ product_id: o.product_id, quantity: o.quantity }] : []);
  const release = (o) => {
    if (!Number(o.stock_reserved)) return;
    for (const it of items(o)) state.stock[it.product_id] += it.quantity;
    o.stock_reserved = 0;
  };

  const t = {
    lockOrderByGatewayId: async (id) => clone(byGateway(id)),
    getOrder: async (id) => clone(state.orders.get(id)),
    async recordEvent({ key }) { if (state.events.has(key)) return false; state.events.add(key); return true; },
    async reserveStock(o) {
      for (const it of items(o)) if (state.stock[it.product_id] < it.quantity) return false;
      for (const it of items(o)) state.stock[it.product_id] -= it.quantity;
      return true;
    },
    async markPaid(o, { note }) {
      const row = state.orders.get(o.id);
      Object.assign(row, { status: 'PAID', mp_status: 'PAID', stock_reserved: 0, error_message: note || null, transaction_id: row.mp_id });
    },
    async closeOrder(o, status) {
      const row = state.orders.get(o.id); release(row); row.status = status;
    },
    async enqueueNotification(orderId) { state.notifications.add(orderId); },
  };

  const store = {
    state,
    findOrderById: async (id) => clone(state.orders.get(id)),
    findOrderByGatewayId: async (id) => clone(byGateway(id)),
    async tx(fn) {
      const snap = snapshot();
      try { return await fn(t); } catch (err) { restore(snap); throw err; }
    },
    async saveCharge(orderId, c) {
      const row = state.orders.get(orderId);
      if (!row || row.mp_id) return false;
      Object.assign(row, { mp_id: c.id, mp_status: 'PENDING', pix_qr_code: c.copyPaste, pix_qr_code_base64: c.qrCodeBase64, pix_expires_at: c.expiresAt });
      return true;
    },
    async saveCardCharge(orderId, c) {
      const row = state.orders.get(orderId);
      if (!row || row.mp_id) return false;
      Object.assign(row, { mp_id: c.id, mp_status: c.rawStatus, mp_status_detail: c.statusDetail, card_brand: c.brand, card_last4: c.lastFour });
      return true;
    },
    async failOrderAndRelease(orderId, message) {
      const row = state.orders.get(orderId); release(row); Object.assign(row, { status: 'ERROR', error_message: message });
    },
    async expireOrder(orderId) {
      const row = state.orders.get(orderId); if (row.status !== 'PENDING') return; release(row); row.status = 'EXPIRED';
    },
    async claimRefresh(orderId, minSeconds) {
      const row = state.orders.get(orderId);
      if (row.status !== 'PENDING') return false;
      if (row.mp_checked_at && Date.now() - row.mp_checked_at < minSeconds * 1000) return false;
      row.mp_checked_at = Date.now(); return true;
    },
    async touchChecked(orderId) { state.orders.get(orderId).mp_checked_at = Date.now(); },
    async setGatewayStatus(orderId, s, detail) { const r = state.orders.get(orderId); if (r.status === 'PENDING') { r.mp_status = s; if (detail) r.mp_status_detail = detail; } },
    async listReconcilable(limit) { return [...state.orders.values()].filter((o) => o.status === 'PENDING' && o.mp_id).slice(0, limit).map(clone); },
    async expireOrphans() { return 0; },
  };
  return store;
}

// fetch falso da API Mercado Pago. `routes` mapeia "METHOD /path" -> () => ({status, body}) | Error | 'hang'.
function makeFakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, path });
    const handler = routes[`${init.method} ${path}`] || routes[`${init.method} *`];
    if (!handler) throw new Error(`rota não mockada: ${init.method} ${path}`);
    const out = typeof handler === 'function' ? handler(init) : handler;
    if (out === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    if (out instanceof Error) throw out;
    return { status: out.status, text: async () => (out.raw !== undefined ? out.raw : JSON.stringify(out.body)) };
  };
  fn.calls = calls;
  return fn;
}

const goodCreate = (amountCents, over = {}) => ({
  status: 201,
  body: {
    id: Number(TX_A), status: 'pending', status_detail: 'pending_waiting_transfer',
    transaction_amount: amountCents / 100, payment_method_id: 'pix',
    date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString(),
    point_of_interaction: { transaction_data: { qr_code: '00020126580014br.gov.bcb.pix6304ABCD', qr_code_base64: 'iVBORw0KGgo=' } },
    ...over,
  },
});
const goodGet = (over = {}) => ({ status: 200, body: { id: Number(TX_A), status: 'approved', payment_method_id: 'pix', transaction_amount: 149.9, ...over } });

module.exports = { WEBHOOK_SECRET, API_KEY, TX_A, TX_B, TX_C, sign, makeLogger, makeOrder, makeFakeStore, makeFakeFetch, goodCreate, goodGet };
