'use strict';

// Regras de cupom de desconto. As funções puras (normalizeCode, evaluateCoupon,
// couponStatus, parseCouponInput) não tocam no banco e têm testes em tests/coupons.test.js.
// As funções com `client` recebem {get, all, run} (db ou o client de uma transação).

const { CATEGORY_SLUG_TO_TAG } = require('./category-tags');

const CODE_PATTERN = /^[A-Z0-9]{3,32}$/;
const MIN_TOTAL_CENTS = 50; // mínimo que a Mercado Pago aceita cobrar

class CouponError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'CouponError';
    this.couponCode = code;
    this.status = status;
  }
}

const toCents = (v) => Math.round(Number(v) * 100);
const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function normalizeCode(input) {
  return String(input == null ? '' : input).trim().toUpperCase();
}
function isValidCodeFormat(code) {
  return CODE_PATTERN.test(code);
}

function parseJsonArray(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function rowToCoupon(r) {
  return {
    id: r.id,
    code: r.code,
    description: r.description || '',
    discountType: r.discount_type,
    discountValue: Number(r.discount_value),
    maxDiscount: r.max_discount == null ? null : Number(r.max_discount),
    minOrder: Number(r.min_order || 0),
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    usageLimit: r.usage_limit == null ? null : Number(r.usage_limit),
    perCustomerLimit: r.per_customer_limit == null ? null : Number(r.per_customer_limit),
    usedCount: Number(r.used_count || 0),
    firstPurchaseOnly: !!Number(r.first_purchase_only),
    allowOnPromo: !!Number(r.allow_on_promo),
    appliesTo: r.applies_to || 'all',
    productIds: parseJsonArray(r.product_ids).map(Number).filter(Number.isInteger),
    categorySlugs: parseJsonArray(r.category_slugs).map(String),
    active: !!Number(r.active),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

// paused | scheduled | expired | exhausted | active
function couponStatus(c, now = new Date()) {
  const t = now.getTime();
  if (!c.active) return 'paused';
  if (c.endsAt && t > new Date(c.endsAt).getTime()) return 'expired';
  if (c.startsAt && t < new Date(c.startsAt).getTime()) return 'scheduled';
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) return 'exhausted';
  return 'active';
}

function lineMatches(coupon, line) {
  if (coupon.appliesTo === 'products') return coupon.productIds.includes(Number(line.productId));
  if (coupon.appliesTo === 'categories') {
    const have = new Set(line.categorySlugs || []);
    return coupon.categorySlugs.some((slug) => have.has(slug) || (CATEGORY_SLUG_TO_TAG[slug] && have.has(CATEGORY_SLUG_TO_TAG[slug])));
  }
  return true;
}

// lines: [{ productId, unitCents, quantity, onPromo, categorySlugs }]
// ctx:   { now, customerKnown, customerUses, hasPriorOrder }
function evaluateCoupon(coupon, lines, ctx = {}) {
  const now = (ctx.now || new Date()).getTime();
  if (!coupon.active) throw new CouponError('INACTIVE', 'Este cupom não está ativo.');
  if (coupon.startsAt && now < new Date(coupon.startsAt).getTime()) throw new CouponError('NOT_STARTED', 'Este cupom ainda não está valendo.');
  if (coupon.endsAt && now > new Date(coupon.endsAt).getTime()) throw new CouponError('EXPIRED', 'Este cupom expirou.');
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) throw new CouponError('EXHAUSTED', 'Este cupom atingiu o limite de usos.');

  if (ctx.customerKnown) {
    if (coupon.perCustomerLimit != null && (ctx.customerUses || 0) >= coupon.perCustomerLimit) {
      throw new CouponError('CUSTOMER_LIMIT', 'Você já usou este cupom o máximo de vezes permitido.');
    }
    if (coupon.firstPurchaseOnly && ctx.hasPriorOrder) {
      throw new CouponError('FIRST_PURCHASE', 'Este cupom vale apenas para a primeira compra.');
    }
  }

  const subtotalCents = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  if (coupon.minOrder > 0 && subtotalCents < toCents(coupon.minOrder)) {
    throw new CouponError('MIN_ORDER', `Pedido mínimo de ${brl(toCents(coupon.minOrder))} para usar este cupom.`);
  }

  const inScope = lines.filter((l) => lineMatches(coupon, l));
  if (!inScope.length) throw new CouponError('NOT_APPLICABLE', 'Este cupom não vale para os produtos do pedido.');
  const eligible = coupon.allowOnPromo ? inScope : inScope.filter((l) => !l.onPromo);
  if (!eligible.length) throw new CouponError('NOT_APPLICABLE', 'Este cupom não vale para produtos que já estão em promoção.');
  const eligibleCents = eligible.reduce((s, l) => s + l.unitCents * l.quantity, 0);

  let discountCents;
  if (coupon.discountType === 'percent') {
    discountCents = Math.round((eligibleCents * coupon.discountValue) / 100);
    if (coupon.maxDiscount != null) discountCents = Math.min(discountCents, toCents(coupon.maxDiscount));
  } else {
    discountCents = toCents(coupon.discountValue);
  }
  discountCents = Math.min(discountCents, eligibleCents);

  // O PIX precisa cobrar pelo menos o mínimo do gateway: o desconto é limitado para isso.
  let clamped = false;
  if (subtotalCents - discountCents < MIN_TOTAL_CENTS) {
    discountCents = Math.max(0, subtotalCents - MIN_TOTAL_CENTS);
    clamped = true;
  }
  if (discountCents <= 0) throw new CouponError('NO_DISCOUNT', 'Este cupom não gera desconto para este pedido.');

  return { subtotalCents, eligibleCents, discountCents, totalCents: subtotalCents - discountCents, clamped };
}

// ---------- validação do cadastro feito no painel ----------
function parseCouponInput(b) {
  const errors = [];
  const body = b && typeof b === 'object' ? b : {};

  const code = normalizeCode(body.code);
  if (!code) errors.push('Informe o código do cupom.');
  else if (!isValidCodeFormat(code)) errors.push('O código deve ter de 3 a 32 caracteres, usando apenas letras e números (sem espaços ou símbolos).');

  const discountType = body.discountType === 'fixed' ? 'fixed' : body.discountType === 'percent' ? 'percent' : null;
  if (!discountType) errors.push('Escolha o tipo de desconto (porcentagem ou valor fixo).');

  const discountValue = Number(body.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) errors.push('Informe o valor do desconto.');
  else if (discountType === 'percent' && discountValue > 100) errors.push('A porcentagem não pode passar de 100%.');
  else if (discountType === 'fixed' && discountValue > 100000) errors.push('Valor de desconto alto demais.');

  const optMoney = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) { errors.push(`${label} inválido.`); return null; }
    return Math.round(n * 100) / 100;
  };
  const maxDiscount = discountType === 'percent' ? optMoney(body.maxDiscount, 'Desconto máximo') : null;
  const minOrder = optMoney(body.minOrder, 'Pedido mínimo') || 0;

  const optInt = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1000000) { errors.push(`${label} deve ser um número inteiro de 1 em diante.`); return null; }
    return n;
  };
  const usageLimit = optInt(body.usageLimit, 'Limite total de usos');
  const perCustomerLimit = optInt(body.perCustomerLimit, 'Limite por cliente');

  const optDate = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) { errors.push(`${label} inválido.`); return null; }
    return d.toISOString();
  };
  const startsAt = optDate(body.startsAt, 'Início');
  const endsAt = optDate(body.endsAt, 'Fim');
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) errors.push('O fim da validade precisa ser depois do início.');

  const appliesTo = ['all', 'products', 'categories'].includes(body.appliesTo) ? body.appliesTo : 'all';
  const productIds = Array.isArray(body.productIds) ? [...new Set(body.productIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500) : [];
  const categorySlugs = Array.isArray(body.categorySlugs)
    ? [...new Set(body.categorySlugs.map(String).filter((s) => /^[a-z0-9-]{1,60}$/.test(s)))].slice(0, 100)
    : [];
  if (appliesTo === 'products' && !productIds.length) errors.push('Selecione pelo menos um produto.');
  if (appliesTo === 'categories' && !categorySlugs.length) errors.push('Selecione pelo menos uma categoria.');

  const description = String(body.description || '').trim().slice(0, 200);

  return {
    errors,
    value: {
      code, description, discountType, discountValue: Math.round((discountValue || 0) * 100) / 100,
      maxDiscount, minOrder, startsAt, endsAt, usageLimit, perCustomerLimit,
      firstPurchaseOnly: !!body.firstPurchaseOnly,
      allowOnPromo: body.allowOnPromo === undefined ? true : !!body.allowOnPromo,
      appliesTo, productIds: appliesTo === 'products' ? productIds : [], categorySlugs: appliesTo === 'categories' ? categorySlugs : [],
      active: body.active === undefined ? true : !!body.active,
    },
  };
}

// ---------- acesso ao banco ----------
async function productCategorySlugs(client, product) {
  const slugs = new Set(parseJsonArray(product.category_tags).map(String));
  if (product.category_id) {
    const c = await client.get('SELECT slug FROM categories WHERE id = ?', [product.category_id]);
    if (c && c.slug) slugs.add(c.slug);
  }
  return [...slugs];
}

function lineFromProduct(product, quantity, categorySlugs) {
  const price = Number(product.price);
  const promo = product.promo_price == null ? null : Number(product.promo_price);
  const onPromo = promo != null && promo > 0 && promo < price;
  return { productId: product.id, unitCents: toCents(promo != null && promo > 0 ? promo : price), quantity, onPromo, categorySlugs };
}

// Calcula o desconto. Com lock=true (dentro da transação do pedido) a linha do cupom
// fica travada, então dois pedidos simultâneos não estouram o limite de usos.
async function quoteCoupon(client, { code, lines, cpf = '', email = '', now = new Date(), lock = false }) {
  const normalized = normalizeCode(code);
  if (!isValidCodeFormat(normalized)) throw new CouponError('INVALID', 'Cupom inválido.');
  const row = await client.get(`SELECT * FROM coupons WHERE UPPER(code) = ?${lock ? ' FOR UPDATE' : ''}`, [normalized]);
  if (!row) throw new CouponError('NOT_FOUND', 'Cupom inválido.');
  const coupon = rowToCoupon(row);

  const cpfDigits = String(cpf || '').replace(/\D/g, '');
  const mail = String(email || '').trim().toLowerCase();
  const customerKnown = Boolean(cpfDigits || mail);
  let customerUses = 0;
  let hasPriorOrder = false;
  if (customerKnown && coupon.perCustomerLimit != null) {
    const r = await client.get(
      `SELECT COUNT(*) AS n FROM coupon_redemptions
        WHERE coupon_id = ? AND status IN ('RESERVED','REDEEMED')
          AND ((? <> '' AND customer_cpf = ?) OR (? <> '' AND customer_email = ?))`,
      [coupon.id, cpfDigits, cpfDigits, mail, mail]
    );
    customerUses = Number(r.n);
  }
  if (customerKnown && coupon.firstPurchaseOnly) {
    const r = await client.get(
      `SELECT 1 AS x FROM orders
        WHERE status IN ('PAID','PENDING')
          AND ((? <> '' AND customer_cpf = ?) OR (? <> '' AND LOWER(customer_email) = ?))
        LIMIT 1`,
      [cpfDigits, cpfDigits, mail, mail]
    );
    hasPriorOrder = Boolean(r);
  }

  const result = evaluateCoupon(coupon, lines, { now, customerKnown, customerUses, hasPriorOrder });
  return { coupon, customerChecked: customerKnown, ...result };
}

async function reserveCoupon(client, { couponId, orderId, cpf, email, discountCents }) {
  await client.run(
    `INSERT INTO coupon_redemptions (coupon_id, order_id, customer_cpf, customer_email, discount_amount, status)
     VALUES (?, ?, ?, ?, ?, 'RESERVED')`,
    [couponId, orderId, String(cpf || '').replace(/\D/g, ''), String(email || '').trim().toLowerCase(), discountCents / 100]
  );
  await client.run('UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = ?', [couponId]);
}

// Pedido encerrado sem pagamento: o uso do cupom volta (idempotente).
async function releaseCoupon(client, orderId) {
  const r = await client.get(`SELECT id, coupon_id, status FROM coupon_redemptions WHERE order_id = ? FOR UPDATE`, [orderId]);
  if (!r || r.status !== 'RESERVED') return;
  await client.run(`UPDATE coupon_redemptions SET status = 'RELEASED' WHERE id = ?`, [r.id]);
  await client.run('UPDATE coupons SET used_count = GREATEST(used_count - 1, 0), updated_at = NOW() WHERE id = ?', [r.coupon_id]);
}

// Pagamento confirmado: o uso vira definitivo (inclusive em pagamento tardio, depois de liberado).
async function confirmCoupon(client, orderId) {
  const r = await client.get(`SELECT id, coupon_id, status FROM coupon_redemptions WHERE order_id = ? FOR UPDATE`, [orderId]);
  if (!r || r.status === 'REDEEMED') return;
  if (r.status === 'RELEASED') {
    await client.run('UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = ?', [r.coupon_id]);
  }
  await client.run(`UPDATE coupon_redemptions SET status = 'REDEEMED' WHERE id = ?`, [r.id]);
}

module.exports = {
  CouponError, CODE_PATTERN, MIN_TOTAL_CENTS,
  normalizeCode, isValidCodeFormat, rowToCoupon, couponStatus, evaluateCoupon, parseCouponInput,
  productCategorySlugs, lineFromProduct, quoteCoupon, reserveCoupon, releaseCoupon, confirmCoupon, toCents,
};
