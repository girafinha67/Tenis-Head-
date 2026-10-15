'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler, parseIntId } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const { isRateLimited, registerHit } = require('../lib/rate-limit');
const siteSettings = require('../lib/site-settings');
const C = require('../lib/coupons');

const router = express.Router();

function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return String(xff || req.socket?.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '') || '0.0.0.0';
}

// ---------------------------------------------------------------- público
// Calcula o desconto em tempo real para o checkout (não reserva nada).
// Os preços SEMPRE vêm do banco; o navegador só diz produto + quantidade.
router.post(
  '/coupons/validate',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ip = getIp(req);
    // Anti força-bruta de códigos: 20 tentativas a cada 10 minutos por IP.
    if (await isRateLimited('coupon', ip, 20, 10 * 60 * 1000)) {
      return res.status(429).json({ valid: false, error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    }
    await registerHit('coupon', ip);

    const b = req.body || {};
    const settings = await siteSettings.getSiteSettings();
    if (!settings.checkout.couponsEnabled) {
      return res.status(422).json({ valid: false, error: 'Cupons estão desativados no momento.' });
    }

    const rawItems = Array.isArray(b.items) ? b.items : (b.productId ? [{ productId: b.productId, quantity: b.quantity }] : []);
    const items = rawItems
      .map((it) => ({ productId: Number(it.productId), quantity: Math.floor(Number(it.quantity || 1)) }))
      .filter((it) => Number.isInteger(it.productId) && it.productId > 0 && Number.isInteger(it.quantity) && it.quantity >= 1 && it.quantity <= 99)
      .slice(0, 20);
    if (!items.length) return res.status(400).json({ valid: false, error: 'Pedido sem produtos.' });

    const lines = [];
    for (const it of items) {
      const product = await db.get('SELECT * FROM products WHERE id = ? AND active = 1', [it.productId]);
      if (!product) return res.status(404).json({ valid: false, error: 'Um dos produtos não está mais disponível.' });
      lines.push(C.lineFromProduct(product, it.quantity, await C.productCategorySlugs(db, product)));
    }

    try {
      const q = await C.quoteCoupon(db, { code: b.code, lines, cpf: b.cpf, email: b.email });
      res.status(200).json({
        valid: true,
        coupon: {
          code: q.coupon.code,
          description: q.coupon.description,
          discountType: q.coupon.discountType,
          discountValue: q.coupon.discountValue,
        },
        subtotal: q.subtotalCents / 100,
        discount: q.discountCents / 100,
        total: q.totalCents / 100,
        clamped: q.clamped,
        customerChecked: q.customerChecked,
      });
    } catch (err) {
      if (err instanceof C.CouponError) return res.status(err.status).json({ valid: false, error: err.message, reason: err.couponCode });
      throw err;
    }
  })
);

// ---------------------------------------------------------------- admin
function present(row, stats, now) {
  const c = C.rowToCoupon(row);
  return {
    ...c,
    status: C.couponStatus(c, now),
    paidUses: stats ? Number(stats.uses) : 0,
    discountGiven: stats ? Number(stats.discount) : 0,
    revenue: stats ? Number(stats.revenue) : 0,
  };
}

router.get(
  '/admin/coupons',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rows = await db.all('SELECT * FROM coupons ORDER BY created_at DESC');
    const stats = await db.all(
      `SELECT r.coupon_id, COUNT(*) AS uses, COALESCE(SUM(r.discount_amount),0) AS discount, COALESCE(SUM(o.amount),0) AS revenue
         FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
        WHERE o.status = 'PAID' GROUP BY r.coupon_id`
    );
    const byId = new Map(stats.map((s) => [s.coupon_id, s]));
    const now = new Date();
    const coupons = rows.map((r) => present(r, byId.get(r.id), now));
    const summary = {
      total: coupons.length,
      active: coupons.filter((c) => c.status === 'active').length,
      paidUses: coupons.reduce((s, c) => s + c.paidUses, 0),
      discountGiven: coupons.reduce((s, c) => s + c.discountGiven, 0),
      revenue: coupons.reduce((s, c) => s + c.revenue, 0),
    };
    res.status(200).json({ coupons, summary });
  })
);

async function ensureUniqueCode(code, ignoreId) {
  const existing = await db.get('SELECT id FROM coupons WHERE UPPER(code) = ?', [code]);
  return !existing || existing.id === ignoreId;
}

function dbValues(v) {
  return [
    v.code, v.description || null, v.discountType, v.discountValue, v.maxDiscount, v.minOrder,
    v.startsAt, v.endsAt, v.usageLimit, v.perCustomerLimit, v.firstPurchaseOnly ? 1 : 0, v.allowOnPromo ? 1 : 0,
    v.appliesTo, JSON.stringify(v.productIds), JSON.stringify(v.categorySlugs), v.active ? 1 : 0,
  ];
}

router.post(
  '/admin/coupons',
  asyncHandler(async (req, res) => {
    const { errors, value } = C.parseCouponInput(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    if (!(await ensureUniqueCode(value.code))) return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
    try {
      const info = await db.run(
        `INSERT INTO coupons (code, description, discount_type, discount_value, max_discount, min_order, starts_at, ends_at,
           usage_limit, per_customer_limit, first_purchase_only, allow_on_promo, applies_to, product_ids, category_slugs, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        dbValues(value)
      );
      await log(req.admin.id, 'coupon_create', { id: info.lastInsertRowid, code: value.code });
      res.status(201).json({ id: info.lastInsertRowid });
    } catch (err) {
      if (err && err.code === '23505') return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
      throw err;
    }
  })
);

router.put(
  '/admin/coupons/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    const current = await db.get('SELECT id FROM coupons WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Cupom não encontrado.' });
    const { errors, value } = C.parseCouponInput(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    if (!(await ensureUniqueCode(value.code, id))) return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
    try {
      await db.run(
        `UPDATE coupons SET code=?, description=?, discount_type=?, discount_value=?, max_discount=?, min_order=?, starts_at=?, ends_at=?,
           usage_limit=?, per_customer_limit=?, first_purchase_only=?, allow_on_promo=?, applies_to=?, product_ids=?, category_slugs=?, active=?, updated_at=NOW()
         WHERE id=?`,
        [...dbValues(value), id]
      );
    } catch (err) {
      if (err && err.code === '23505') return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
      throw err;
    }
    await log(req.admin.id, 'coupon_update', { id, code: value.code });
    res.status(200).json({ ok: true });
  })
);

// Pausar / ativar sem mexer no resto.
router.patch(
  '/admin/coupons/:id/active',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    const info = await db.run('UPDATE coupons SET active = ?, updated_at = NOW() WHERE id = ?', [req.body && req.body.active ? 1 : 0, id]);
    if (!info.changes) return res.status(404).json({ error: 'Cupom não encontrado.' });
    await log(req.admin.id, 'coupon_toggle', { id, active: !!(req.body && req.body.active) });
    res.status(200).json({ ok: true });
  })
);

router.delete(
  '/admin/coupons/:id',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    const used = await db.get('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?', [id]);
    if (Number(used.n) > 0) {
      return res.status(409).json({ error: 'Este cupom já foi usado em pedidos. Pause-o em vez de excluir para manter o histórico.' });
    }
    const info = await db.run('DELETE FROM coupons WHERE id = ?', [id]);
    if (!info.changes) return res.status(404).json({ error: 'Cupom não encontrado.' });
    await log(req.admin.id, 'coupon_delete', { id });
    res.status(200).json({ ok: true });
  })
);

router.get(
  '/admin/coupons/:id/redemptions',
  asyncHandler(async (req, res) => {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido.' });
    const rows = await db.all(
      `SELECT r.order_id, r.discount_amount, r.status AS redemption_status, r.created_at, o.status AS order_status, o.amount, o.customer_name
         FROM coupon_redemptions r LEFT JOIN orders o ON o.id = r.order_id
        WHERE r.coupon_id = ? ORDER BY r.created_at DESC LIMIT 200`,
      [id]
    );
    res.status(200).json({
      redemptions: rows.map((r) => ({
        orderId: r.order_id,
        customerName: r.customer_name || '',
        discount: Number(r.discount_amount),
        amount: Number(r.amount || 0),
        orderStatus: r.order_status,
        redemptionStatus: r.redemption_status,
        createdAt: r.created_at,
      })),
    });
  })
);

module.exports = router;
