'use strict';

// Testes dos cupons e das configurações da loja. Funções puras + um fake de banco em memória
// (identificado aqui). Não executam SQL no Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../netlify/functions/lib/coupons');
const S = require('../netlify/functions/lib/site-settings');

const NOW = new Date('2026-10-14T12:00:00Z');
const base = (over = {}) => ({
  id: 1, code: 'TESTE10', description: '', discountType: 'percent', discountValue: 10, maxDiscount: null, minOrder: 0,
  startsAt: null, endsAt: null, usageLimit: null, perCustomerLimit: null, usedCount: 0, firstPurchaseOnly: false,
  allowOnPromo: true, appliesTo: 'all', productIds: [], categorySlugs: [], active: true, ...over,
});
const line = (over = {}) => ({ productId: 1, unitCents: 10000, quantity: 1, onPromo: false, categorySlugs: [], ...over });
const ev = (coupon, lines = [line()], ctx = {}) => C.evaluateCoupon(coupon, lines, { now: NOW, ...ctx });
const fails = (fn, reason) => assert.throws(fn, (e) => e instanceof C.CouponError && e.couponCode === reason, `esperava ${reason}`);

// ------------------------------------------------------------ código
test('código: só letras e números, 3 a 32, case-insensitive', () => {
  assert.equal(C.normalizeCode('  bemvindo10 '), 'BEMVINDO10');
  for (const ok of ['ABC', 'abc123', 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6']) assert.ok(C.isValidCodeFormat(C.normalizeCode(ok)), ok);
  for (const bad of ['', 'AB', 'AB-12', 'AB 12', 'AB_12', 'AÇAÍ10', 'A'.repeat(33), 'DROP;TABLE', '10%OFF', 'ab\n12']) {
    assert.ok(!C.isValidCodeFormat(C.normalizeCode(bad)), `deveria recusar "${bad}"`);
  }
});

// ------------------------------------------------------------ cálculo
test('porcentagem e valor fixo', () => {
  assert.equal(ev(base()).discountCents, 1000);
  assert.equal(ev(base({ discountType: 'fixed', discountValue: 25 })).discountCents, 2500);
  const r = ev(base({ discountValue: 15 }), [line({ unitCents: 14990, quantity: 2 })]);
  assert.equal(r.subtotalCents, 29980);
  assert.equal(r.discountCents, 4497);
  assert.equal(r.totalCents, 25483);
});
test('desconto máximo limita a porcentagem; fixo nunca passa do elegível', () => {
  assert.equal(ev(base({ discountValue: 50, maxDiscount: 20 })).discountCents, 2000);
  assert.equal(ev(base({ discountType: 'fixed', discountValue: 9999 }), [line({ unitCents: 8000 })]).discountCents, 7950, 'sobra o mínimo do PIX');
});
test('nunca cobra menos que R$ 0,50 (mínimo do PIX): desconto é limitado', () => {
  const r = ev(base({ discountValue: 100 }), [line({ unitCents: 5000 })]);
  assert.equal(r.totalCents, 50);
  assert.equal(r.clamped, true);
});
test('desconto zero é recusado', () => {
  fails(() => ev(base({ discountType: 'fixed', discountValue: 5 }), [line({ unitCents: 50 })]), 'NO_DISCOUNT');
});

// ------------------------------------------------------------ validade e limites
test('inativo, agendado, expirado, esgotado', () => {
  fails(() => ev(base({ active: false })), 'INACTIVE');
  fails(() => ev(base({ startsAt: '2026-10-15T00:00:00Z' })), 'NOT_STARTED');
  fails(() => ev(base({ endsAt: '2026-10-14T11:59:59Z' })), 'EXPIRED');
  fails(() => ev(base({ usageLimit: 5, usedCount: 5 })), 'EXHAUSTED');
  assert.ok(ev(base({ startsAt: '2026-10-14T12:00:00Z', endsAt: '2026-10-14T12:00:01Z' })).discountCents > 0, 'limites inclusivos');
  assert.ok(ev(base({ usageLimit: 5, usedCount: 4 })).discountCents > 0);
});
test('status exibido no painel', () => {
  assert.equal(C.couponStatus(base(), NOW), 'active');
  assert.equal(C.couponStatus(base({ active: false }), NOW), 'paused');
  assert.equal(C.couponStatus(base({ startsAt: '2026-11-01T00:00:00Z' }), NOW), 'scheduled');
  assert.equal(C.couponStatus(base({ endsAt: '2026-10-01T00:00:00Z' }), NOW), 'expired');
  assert.equal(C.couponStatus(base({ usageLimit: 1, usedCount: 1 }), NOW), 'exhausted');
});
test('limite por cliente e primeira compra só valem quando o cliente é conhecido', () => {
  const c = base({ perCustomerLimit: 1, firstPurchaseOnly: true });
  assert.ok(ev(c, [line()], { customerKnown: false }).discountCents > 0, 'prévia sem CPF/e-mail não bloqueia');
  fails(() => ev(c, [line()], { customerKnown: true, customerUses: 1 }), 'CUSTOMER_LIMIT');
  fails(() => ev(c, [line()], { customerKnown: true, customerUses: 0, hasPriorOrder: true }), 'FIRST_PURCHASE');
  assert.ok(ev(c, [line()], { customerKnown: true, customerUses: 0, hasPriorOrder: false }).discountCents > 0);
});
test('pedido mínimo considera o subtotal inteiro', () => {
  const c = base({ minOrder: 150 });
  fails(() => ev(c, [line({ unitCents: 14999 })]), 'MIN_ORDER');
  assert.ok(ev(c, [line({ unitCents: 15000 })]).discountCents > 0);
});

// ------------------------------------------------------------ escopo
test('só produtos específicos: desconto só sobre os elegíveis', () => {
  const c = base({ appliesTo: 'products', productIds: [2] });
  const r = ev(c, [line({ productId: 1, unitCents: 10000 }), line({ productId: 2, unitCents: 20000 })]);
  assert.equal(r.eligibleCents, 20000);
  assert.equal(r.discountCents, 2000);
  fails(() => ev(c, [line({ productId: 1 })]), 'NOT_APPLICABLE');
});
test('só categorias: casa por slug da categoria ou pela tag do produto', () => {
  const c = base({ appliesTo: 'categories', categorySlugs: ['nike'] });
  assert.ok(ev(c, [line({ categorySlugs: ['nike'] })]).discountCents > 0);
  fails(() => ev(c, [line({ categorySlugs: ['adidas'] })]), 'NOT_APPLICABLE');
});
test('sem permissão em promoção: ignora itens promocionais', () => {
  const c = base({ allowOnPromo: false });
  const r = ev(c, [line({ productId: 1, unitCents: 10000, onPromo: true }), line({ productId: 2, unitCents: 20000 })]);
  assert.equal(r.eligibleCents, 20000);
  fails(() => ev(c, [line({ onPromo: true })]), 'NOT_APPLICABLE');
});

// ------------------------------------------------------------ cadastro no painel
test('parseCouponInput aceita um cupom válido e normaliza', () => {
  const { errors, value } = C.parseCouponInput({ code: ' black10 ', discountType: 'percent', discountValue: '10', usageLimit: '100', startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-27T10:00:00Z' });
  assert.deepEqual(errors, []);
  assert.equal(value.code, 'BLACK10');
  assert.equal(value.usageLimit, 100);
  assert.equal(value.allowOnPromo, true);
});
test('parseCouponInput recusa dados inválidos', () => {
  const bad = (o) => C.parseCouponInput({ code: 'OK123', discountType: 'percent', discountValue: 10, ...o }).errors.length > 0;
  assert.ok(bad({ code: 'sem espaço' }));
  assert.ok(bad({ code: 'ab' }));
  assert.ok(bad({ code: 'acentuação' }));
  assert.ok(bad({ discountValue: 0 }));
  assert.ok(bad({ discountValue: 101 }));
  assert.ok(bad({ discountType: 'x' }));
  assert.ok(bad({ usageLimit: 0 }));
  assert.ok(bad({ startsAt: '2026-10-20', endsAt: '2026-10-19' }), 'fim antes do início');
  assert.ok(bad({ appliesTo: 'products', productIds: [] }));
  assert.ok(bad({ appliesTo: 'categories', categorySlugs: [] }));
  assert.ok(!bad({}));
});

// ------------------------------------------------------------ quoteCoupon com banco falso
function fakeClient({ coupon, uses = 0, prior = false }) {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push(sql);
      if (/FROM coupons/.test(sql)) return params[0] === coupon.code.toUpperCase() ? coupon.row : null;
      if (/FROM coupon_redemptions/.test(sql)) return { n: uses };
      if (/FROM orders/.test(sql)) return prior ? { x: 1 } : null;
      throw new Error('SQL inesperado');
    },
  };
}
const row = (over = {}) => ({ id: 1, code: 'TESTE10', discount_type: 'percent', discount_value: '10.00', min_order: '0', used_count: 0, first_purchase_only: 0, allow_on_promo: 1, applies_to: 'all', product_ids: '[]', category_slugs: '[]', active: 1, per_customer_limit: null, ...over });

test('quoteCoupon: código inexistente ou fora do formato é "Cupom inválido"', async () => {
  const cl = fakeClient({ coupon: { code: 'TESTE10', row: row() } });
  await assert.rejects(() => C.quoteCoupon(cl, { code: 'NAOEXISTE', lines: [line()] }), (e) => e.couponCode === 'NOT_FOUND' && e.message === 'Cupom inválido.');
  await assert.rejects(() => C.quoteCoupon(cl, { code: "x' OR 1=1 --", lines: [line()] }), (e) => e.couponCode === 'INVALID');
  assert.equal(cl.calls.length === 1, true, 'o formato inválido nem chega ao banco');
});
test('quoteCoupon: busca em maiúsculas e trava a linha só quando pedido (lock)', async () => {
  const cl = fakeClient({ coupon: { code: 'TESTE10', row: row() } });
  const q = await C.quoteCoupon(cl, { code: 'teste10', lines: [line()], now: NOW });
  assert.equal(q.discountCents, 1000);
  assert.ok(!/FOR UPDATE/.test(cl.calls[0]));
  const cl2 = fakeClient({ coupon: { code: 'TESTE10', row: row() } });
  await C.quoteCoupon(cl2, { code: 'TESTE10', lines: [line()], now: NOW, lock: true });
  assert.ok(/FOR UPDATE/.test(cl2.calls[0]));
});
test('quoteCoupon: por cliente e primeira compra consultam o histórico', async () => {
  const cl = fakeClient({ coupon: { code: 'TESTE10', row: row({ per_customer_limit: 1, first_purchase_only: 1 }) }, uses: 1 });
  await assert.rejects(() => C.quoteCoupon(cl, { code: 'TESTE10', lines: [line()], cpf: '111.222.333-44', now: NOW }), (e) => e.couponCode === 'CUSTOMER_LIMIT');
  const cl2 = fakeClient({ coupon: { code: 'TESTE10', row: row({ first_purchase_only: 1 }) }, prior: true });
  await assert.rejects(() => C.quoteCoupon(cl2, { code: 'TESTE10', lines: [line()], email: 'A@B.COM', now: NOW }), (e) => e.couponCode === 'FIRST_PURCHASE');
});

// ------------------------------------------------------------ configurações da loja
test('configurações: valores inválidos são recusados e o restante é preservado', () => {
  const s = S.sanitize({ announcement: { bgColor: 'red', textColor: '#ABCDEF', link: 'javascript:alert(1)' }, checkout: { maxQuantity: 5000, minOrder: -5 }, contact: { instagram: 'https://instagram.com/loja.tn/?x=1', whatsapp: '(98) 99999-1234', email: 'nao-e-email' } });
  assert.equal(s.announcement.bgColor, S.DEFAULTS.announcement.bgColor);
  assert.equal(s.announcement.textColor, '#ABCDEF');
  assert.equal(s.announcement.link, '', 'só / ou https:// são aceitos');
  assert.equal(s.checkout.maxQuantity, 99);
  assert.equal(s.checkout.minOrder, 0);
  assert.equal(s.contact.instagram, 'loja.tn');
  assert.equal(s.contact.whatsapp, '98999991234');
  assert.equal(s.contact.email, '', 'e-mail inválido mantém o anterior (vazio)');
  assert.equal(s.checkout.salesOpen, true, 'o que não veio fica como estava');
});
test('configurações: atualização parcial não apaga o resto', () => {
  const current = S.sanitize({ store: { name: 'Minha Loja' }, checkout: { minOrder: 80 } });
  const next = S.sanitize({ checkout: { salesOpen: false } }, current);
  assert.equal(next.store.name, 'Minha Loja');
  assert.equal(next.checkout.minOrder, 80);
  assert.equal(next.checkout.salesOpen, false);
});
test('configurações: texto sem caracteres de controle, tamanho limitado; página pública não expõe pontos', () => {
  const s = S.sanitize({ store: { name: 'A'.repeat(200) + '\u0000' }, loyalty: { pointsPerReal: 2 } });
  assert.equal(s.store.name.length, 60);
  const pub = S.publicView(s);
  assert.equal(pub.loyalty, undefined);
  assert.equal(pub.announcement.active, false);
  assert.equal(S.pointsPerReal(s), 2);
  assert.equal(S.pointsPerReal(S.sanitize({})), 1);
});
