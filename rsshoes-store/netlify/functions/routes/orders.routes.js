'use strict';

const express = require('express');
const crypto = require('node:crypto');
const db = require('../lib/db');
const { isRateLimited, registerHit } = require('../lib/rate-limit');
const { getDefault, PaymentError, MIN_AMOUNT_CENTS } = require('../lib/payments');
const siteSettings = require('../lib/site-settings');
const C = require('../lib/coupons');
const CP = require('../lib/card-payment');
const { cardMessage } = require('../lib/mercadopago');
const SH = require('../lib/shipping');

const router = express.Router();

function digits(v) { return String(v || '').replace(/\D/g, ''); }
function normalizeCpf(v) { return digits(v); }
function validCpf(cpf) {
  cpf = normalizeCpf(cpf);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let d1 = (sum * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  let d2 = (sum * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === Number(cpf[10]);
}
function validDoc(v) { const d = digits(v); return d.length === 14 ? SH.validCnpj(d) : validCpf(d); }
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }
function validPhone(v) { return /^55\d{10,11}$/.test(digits(v)) || /^\d{10,11}$/.test(digits(v)); }
function getIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return String(xff || req.socket?.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '') || '0.0.0.0';
}
function amountFromProduct(product) {
  return Number(product.promo_price != null ? product.promo_price : product.price);
}
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const ORDER_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

// Status exibido ao cliente. O PIX vencido aparece como EXPIRED mesmo antes da
// reconciliação persistir isso no banco (que também devolve o estoque).
function effectiveStatus(row) {
  if (row.status === 'PENDING' && row.pix_expires_at && Date.now() > new Date(row.pix_expires_at).getTime()) {
    return 'EXPIRED';
  }
  return row.status;
}

function publicOrder(row) {
  const status = effectiveStatus(row);
  return {
    id: row.id,
    status,
    product: {
      id: row.product_id,
      name: row.product_name,
      slug: row.product_slug,
      image: row.product_image,
    },
    quantity: row.quantity,
    unit_price: Number(row.unit_price),
    amount: Number(row.amount),
    subtotal: row.subtotal_amount != null ? Number(row.subtotal_amount) : Number(row.amount),
    discount: Number(row.discount_amount || 0),
    shipping: row.shipping_method ? { method: row.shipping_method, label: row.shipping_label || null, amount: Number(row.shipping_amount || 0) } : null,
    coupon: row.coupon_code || null,
    points: Number(row.points),
    paymentMethod: row.payment_method || 'pix',
    installments: row.installments != null ? Number(row.installments) : null,
    interest: Number(row.interest_amount || 0),
    card: row.payment_method && row.payment_method !== 'pix' ? { brand: row.card_brand || null, last4: row.card_last4 || null } : null,
    // Mensagem do banco/Mercado Pago, já traduzida (recusa ou "em análise").
    cardMessage: row.payment_method && row.payment_method !== 'pix'
      ? (status === 'FAILED' ? cardMessage(row.mp_status_detail) : (status === 'PENDING' ? cardMessage(row.mp_status_detail, null) : null))
      : null,
    size: row.size,
    color: row.color,
    additionalData: row.additional_data,
    // QR e copia-e-cola só enquanto a cobrança é pagável. Vêm da resposta real do gateway.
    pix: status === 'PENDING' && row.pix_qr_code ? {
      qrCode: row.pix_qr_code,
      qrCodeBase64: row.pix_qr_code_base64,
      expiresAt: row.pix_expires_at,
    } : null,
    payment: row.status === 'PAID' ? {
      received: true,
      paidAt: row.paid_at,
      transactionId: row.transaction_id,
    } : { received: false },
  };
}

async function publicOrderWithItems(row) {
  const out = publicOrder(row);
  if (row.is_cart) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [row.id]);
    out.items = items.map((it) => ({
      productId: it.product_id, name: it.product_name, slug: it.product_slug, image: it.product_image,
      quantity: it.quantity, unitPrice: Number(it.unit_price), size: it.size, color: it.color,
    }));
  }
  return out;
}

// Anti-abuso: o gateway limita 45 cobranças/min por conta; limitamos por IP antes de chegar lá.
async function checkoutRateLimit(req) {
  const ip = getIp(req);
  if (await isRateLimited('checkout', ip, 12, 10 * 60 * 1000)) {
    throw httpError('Muitas tentativas de pagamento. Aguarde alguns minutos e tente de novo.', 429);
  }
  await registerHit('checkout', ip);
}

// Reenvio do mesmo checkout (duplo clique, retry de rede): devolve o pedido já criado
// em vez de gerar outra cobrança.
async function replayByToken(token) {
  if (!token) return null;
  const existing = await getDefault().store.findOrderByToken(token);
  return existing ? publicOrderWithItems(existing) : null;
}

function readToken(body) {
  const token = body && body.checkoutToken != null ? String(body.checkoutToken).trim() : '';
  return TOKEN_PATTERN.test(token) ? token : null;
}

// Cupom é opcional. Código em formato inválido é recusado (nada de "limpar" em silêncio).
function readCoupon(body) {
  const raw = body && body.couponCode != null ? String(body.couponCode).trim() : '';
  if (!raw) return null;
  const code = C.normalizeCode(raw);
  if (!C.isValidCodeFormat(code)) throw httpError('Cupom inválido.', 422);
  return code;
}

// Regras da loja vindas do painel, aplicadas no servidor.
function assertCheckoutAllowed(settings, subtotalCents) {
  if (!settings.checkout.salesOpen) throw httpError(settings.checkout.closedMessage, 503);
  const min = Number(settings.checkout.minOrder || 0);
  if (min > 0 && subtotalCents < Math.round(min * 100)) {
    throw httpError(`Pedido mínimo de ${min.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`, 400);
  }
}

// Calcula desconto (travando a linha do cupom) e reserva o uso, dentro da transação do pedido.
async function applyCouponInTx(client, { settings, code, lines, cpf, email }) {
  if (!code) return { discountCents: 0, coupon: null };
  if (!settings.checkout.couponsEnabled) throw httpError('Cupons estão desativados no momento.', 422);
  const q = await C.quoteCoupon(client, { code, lines, cpf, email, lock: true });
  return { discountCents: q.discountCents, coupon: q.coupon };
}

// Pix gera QR Code; cartão cobra na hora com o token do navegador (3DS opcional do banco).
async function runCharge(order, payment) {
  const { payments } = getDefault();
  if (payment.method === 'pix') return { order: await payments.startPixCharge(order), card: null };
  return payments.startCardCharge(order, payment);
}

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

// Grava entrega + endereço no pedido (colunas criadas em db.js / migrations/2026-10-16_entrega.sql).
async function saveShipping(run, orderId, ship) {
  const a = ship.address || {};
  await run(
    `UPDATE orders SET shipping_method = ?, shipping_label = ?, shipping_amount = ?,
            ship_cep = ?, ship_street = ?, ship_number = ?, ship_complement = ?, ship_neighborhood = ?,
            ship_city = ?, ship_state = ?, accepts_marketing = ? WHERE id = ?`,
    [ship.option.id, ship.option.label, ship.option.priceCents / 100,
      a.cep || null, a.street || null, a.number || null, a.complement || null, a.neighborhood || null,
      a.city || null, a.state || null, ship.acceptsMarketing ? 1 : 0, orderId]
  );
}

async function createDirect(req, res) {
  try {
    const b = req.body || {};
    const settings = await siteSettings.getSiteSettings();
    const productId = Number(b.productId);
    const quantity = Math.floor(Number(b.quantity || 1));
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const cpf = normalizeCpf(b.cpf);
    const phone = digits(b.phone);
    const size = b.size ? String(b.size).trim().slice(0, 80) : null;
    const color = b.color ? String(b.color).trim().slice(0, 80) : null;
    const additionalData = b.additionalData ? String(b.additionalData).trim().slice(0, 1000) : null;
    const token = readToken(b);

    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Produto inválido.' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > settings.checkout.maxQuantity) return res.status(400).json({ error: `Quantidade inválida (máximo ${settings.checkout.maxQuantity} por produto).` });
    if (name.length < 3) return res.status(400).json({ error: 'Informe o nome completo.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (!validDoc(cpf)) return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Telefone inválido.' });

    const couponCode = readCoupon(b);
    const payment = CP.parsePayment(b, settings);

    const replay = await replayByToken(token);
    if (replay) return res.status(200).json(replay);

    if (!settings.checkout.salesOpen) throw httpError(settings.checkout.closedMessage, 503);
    await checkoutRateLimit(req);

    let order;
    try {
      order = await db.tx(async ({ get, run }) => {
        // O preço vem SEMPRE do banco; nada do que o navegador manda sobre valor é usado.
        const product = await get('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [productId]);
        if (!product) throw httpError('Produto não encontrado ou indisponível.', 404);
        const unitPrice = amountFromProduct(product);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw httpError('Produto sem preço válido.', 400);
        if (Number(product.stock) < quantity) throw httpError(`Estoque insuficiente. Disponível: ${product.stock}.`, 409);

        const subtotalCents = Math.round(unitPrice * quantity * 100);
        assertCheckoutAllowed(settings, subtotalCents);
        if (subtotalCents < MIN_AMOUNT_CENTS) throw httpError('Valor do pedido abaixo do mínimo para pagamento (R$ 0,50).', 400);

        // Cupom (opcional): desconto recalculado no servidor, com o cupom travado.
        const { discountCents, coupon } = await applyCouponInTx({ get, run }, {
          settings, code: couponCode, cpf, email,
          lines: [C.lineFromProduct(product, quantity, await C.productCategorySlugs({ get }, product))],
        });
        // Acréscimo do parcelamento no cartão: calculado AQUI, com a tabela do painel (nada vem do navegador).
        // Frete e endereço: recalculados aqui com as regras da loja (o navegador só escolhe a opção).
        const ship = SH.parseShipping(b, subtotalCents - discountCents);
        const priced = CP.priceOrder(subtotalCents - discountCents + ship.option.priceCents, payment, settings);
        const amount = priced.totalCents / 100;

        // Reserva o estoque enquanto a cobrança estiver pendente.
        await run('UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ?', [quantity, productId]);

        const id = crypto.randomUUID();
        const merchantChargeId = crypto.randomUUID();
        const points = Math.floor(((subtotalCents - discountCents) / 100) * siteSettings.pointsPerReal(settings));

        await run(
          `INSERT INTO orders
            (id, merchant_charge_id, product_id, product_name, product_slug, product_image,
             quantity, unit_price, amount, points, customer_name, customer_cpf, customer_email,
             customer_phone, size, color, additional_data, status, created_at, updated_at, stock_reserved,
             payment_provider, checkout_token, coupon_id, coupon_code, discount_amount, subtotal_amount,
             payment_method, installments, interest_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW(), NOW(), 1, 'mercadopago', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, merchantChargeId, product.id, product.name, product.slug,
            JSON.parse(product.images || '[]')[0] || null, quantity, unitPrice, amount, points,
            name, cpf, email, phone, size, color, additionalData, token,
            coupon ? coupon.id : null, coupon ? coupon.code : null, discountCents / 100, subtotalCents / 100,
            payment.method, priced.installments, priced.feeCents / 100,
          ]
        );
        if (coupon) await C.reserveCoupon({ get, run }, { couponId: coupon.id, orderId: id, cpf, email, discountCents });
        await saveShipping(run, id, ship);
        return { id, amount };
      });
    } catch (err) {
      if (isUniqueViolation(err) && token) {
        const again = await replayByToken(token);
        if (again) return res.status(200).json(again);
      }
      throw err;
    }

    const result = await runCharge(order, payment);
    res.status(201).json({ ...publicOrder(result.order), threeDs: result.card ? result.card.challenge : null });
  } catch (err) {
    console.error('[rshoes] create payment:', err.message);
    res.status(err.status || 500).json({ error: err instanceof PaymentError || err.status ? err.message : 'Não deu pra gerar o pagamento.' });
  }
}

// Cobrança única para vários produtos (carrinho).
async function createCart(req, res) {
  try {
    const b = req.body || {};
    const settings = await siteSettings.getSiteSettings();
    const rawItems = Array.isArray(b.items) ? b.items : [];
    const items = rawItems
      .map((it) => ({
        productId: Number(it.productId),
        quantity: Math.floor(Number(it.quantity || 1)),
        size: it.size ? String(it.size).trim().slice(0, 80) : null,
        color: it.color ? String(it.color).trim().slice(0, 80) : null,
      }))
      .filter((it) => Number.isInteger(it.productId) && it.productId > 0 && Number.isInteger(it.quantity) && it.quantity >= 1 && it.quantity <= settings.checkout.maxQuantity);

    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const cpf = normalizeCpf(b.cpf);
    const phone = digits(b.phone);
    const additionalData = b.additionalData ? String(b.additionalData).trim().slice(0, 1000) : null;
    const token = readToken(b);

    if (!items.length) return res.status(400).json({ error: 'Carrinho vazio.' });
    if (items.length > 20) return res.status(400).json({ error: 'Carrinho com muitos itens.' });
    if (name.length < 3) return res.status(400).json({ error: 'Informe o nome completo.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (!validDoc(cpf)) return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Telefone inválido.' });

    const couponCode = readCoupon(b);
    const payment = CP.parsePayment(b, settings);

    const replay = await replayByToken(token);
    if (replay) return res.status(200).json(replay);

    if (!settings.checkout.salesOpen) throw httpError(settings.checkout.closedMessage, 503);
    await checkoutRateLimit(req);

    let order;
    try {
      order = await db.tx(async ({ get, run }) => {
        let amount = 0;
        const couponLines = [];
        let totalQuantity = 0;
        const lineItems = [];
        let firstImage = null;

        for (const it of items) {
          const product = await get('SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE', [it.productId]);
          if (!product) throw httpError('Um dos produtos do carrinho acabou ou saiu da loja.', 404);
          const unitPrice = amountFromProduct(product);
          if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw httpError(`Produto "${product.name}" sem preço válido.`, 400);
          if (Number(product.stock) < it.quantity) throw httpError(`Estoque insuficiente para "${product.name}". Disponível: ${product.stock}.`, 409);
          await run('UPDATE products SET stock = stock - ?, updated_at = NOW() WHERE id = ?', [it.quantity, product.id]);
          const image = JSON.parse(product.images || '[]')[0] || null;
          if (!firstImage) firstImage = image;
          amount += Math.round(unitPrice * it.quantity * 100) / 100;
          couponLines.push(C.lineFromProduct(product, it.quantity, await C.productCategorySlugs({ get }, product)));
          totalQuantity += it.quantity;
          lineItems.push({
            productId: product.id, name: product.name, slug: product.slug, image,
            quantity: it.quantity, unitPrice, size: it.size, color: it.color,
          });
        }
        const subtotalCents = Math.round(amount * 100);
        assertCheckoutAllowed(settings, subtotalCents);
        if (subtotalCents < MIN_AMOUNT_CENTS) throw httpError('Valor do pedido abaixo do mínimo para pagamento (R$ 0,50).', 400);

        const { discountCents, coupon } = await applyCouponInTx({ get, run }, { settings, code: couponCode, cpf, email, lines: couponLines });
        const subtotal = subtotalCents / 100;
        // Acréscimo do parcelamento no cartão: calculado no servidor com a tabela do painel.
        const ship = SH.parseShipping(b, subtotalCents - discountCents);
        const priced = CP.priceOrder(subtotalCents - discountCents + ship.option.priceCents, payment, settings);
        amount = priced.totalCents / 100;

        const id = crypto.randomUUID();
        const merchantChargeId = crypto.randomUUID();
        const points = Math.floor(((subtotalCents - discountCents) / 100) * siteSettings.pointsPerReal(settings));
        const productName = lineItems.length === 1 ? lineItems[0].name : `Carrinho (${lineItems.length} itens)`;

        await run(
          `INSERT INTO orders
            (id, merchant_charge_id, product_id, product_name, product_slug, product_image,
             quantity, unit_price, amount, points, customer_name, customer_cpf, customer_email,
             customer_phone, size, color, additional_data, status, is_cart, created_at, updated_at, stock_reserved,
             payment_provider, checkout_token, coupon_id, coupon_code, discount_amount, subtotal_amount,
             payment_method, installments, interest_amount)
           VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'PENDING', 1, NOW(), NOW(), 1, 'mercadopago', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, merchantChargeId, productName, firstImage, totalQuantity,
            Math.round((subtotal / totalQuantity) * 100) / 100, amount, points,
            name, cpf, email, phone, additionalData, token,
            coupon ? coupon.id : null, coupon ? coupon.code : null, discountCents / 100, subtotal,
            payment.method, priced.installments, priced.feeCents / 100,
          ]
        );
        if (coupon) await C.reserveCoupon({ get, run }, { couponId: coupon.id, orderId: id, cpf, email, discountCents });

        for (const li of lineItems) {
          await run(
            `INSERT INTO order_items (order_id, product_id, product_name, product_slug, product_image, quantity, unit_price, size, color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, li.productId, li.name, li.slug, li.image, li.quantity, li.unitPrice, li.size, li.color]
          );
        }
        await saveShipping(run, id, ship);
        return { id, amount };
      });
    } catch (err) {
      if (isUniqueViolation(err) && token) {
        const again = await replayByToken(token);
        if (again) return res.status(200).json(again);
      }
      throw err;
    }

    const result = await runCharge(order, payment);
    res.status(201).json({ ...(await publicOrderWithItems(result.order)), threeDs: result.card ? result.card.challenge : null });
  } catch (err) {
    console.error('[rshoes] create cart payment:', err.message);
    res.status(err.status || 500).json({ error: err instanceof PaymentError || err.status ? err.message : 'Não deu pra gerar o pagamento.' });
  }
}


// Consulta de CEP (ViaCEP, com BrasilAPI de reserva). Feita pelo servidor para não depender do CORS/CSP do navegador.
async function fetchJson(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 404) return { notFound: true };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { data: await r.json() };
  } finally { clearTimeout(t); }
}
router.get('/cep/:cep', async (req, res) => {
  const cep = digits(req.params.cep);
  if (!/^\d{8}$/.test(cep)) return res.status(400).json({ error: 'CEP inválido.' });
  try {
    const ip = getIp(req);
    if (await isRateLimited('cep', ip, 60, 10 * 60 * 1000)) return res.status(429).json({ error: 'Muitas consultas de CEP. Aguarde um pouco.' });
    await registerHit('cep', ip);
  } catch (e) { /* limite é best-effort */ }
  res.set('Cache-Control', 'public, max-age=86400');
  let answered = false;
  try {
    const r = await fetchJson(`https://viacep.com.br/ws/${cep}/json/`);
    answered = true;
    if (r.data && !r.data.erro) {
      const d = r.data;
      return res.json({ cep, street: d.logradouro || '', neighborhood: d.bairro || '', city: d.localidade || '', state: d.uf || '' });
    }
  } catch (e) { /* tenta a reserva */ }
  try {
    const r = await fetchJson(`https://brasilapi.com.br/api/cep/v2/${cep}`);
    answered = true;
    if (r.data && r.data.city) {
      const d = r.data;
      return res.json({ cep, street: d.street || '', neighborhood: d.neighborhood || '', city: d.city || '', state: d.state || '' });
    }
  } catch (e) { /* segue */ }
  if (answered) return res.status(404).json({ error: 'CEP não encontrado.' });
  res.status(502).json({ error: 'Não deu pra consultar o CEP agora.' });
});

// Rotas novas + aliases das rotas antigas (páginas em cache do navegador continuam funcionando).
// `paymentMethod` no corpo escolhe Pix (padrão), credit_card ou debit_card.
router.post(['/payments/pix/create', '/payments/picpay/create', '/payments/create'], createDirect);
router.post(['/payments/pix/create-cart', '/payments/picpay/create-cart', '/payments/create-cart'], createCart);

// O que o checkout precisa para montar as formas de pagamento (a chave pública do Mercado Pago é feita para ficar no navegador).
router.get('/payments/config', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const settings = await siteSettings.getSiteSettings();
    const available = CP.cardAvailable(settings);
    res.json({
      pix: true,
      card: available ? {
        available: true,
        publicKey: String(process.env.MERCADOPAGO_PUBLIC_KEY).trim(),
        credit: settings.card.credit,
        debit: settings.card.debit,
        maxInstallments: settings.card.maxInstallments,
        minInstallment: settings.card.minInstallment,
        rates: settings.card.rates,
        debitFee: settings.card.debitFee,
      } : { available: false },
    });
  } catch (err) {
    console.error('[rshoes] payments config:', err.message);
    res.json({ pix: true, card: { available: false } });
  }
});

// Consulta do pedido. O navegador só LÊ o estado gravado no servidor; nenhum parâmetro
// da URL ou do cliente altera o status. Se o pedido ainda está pendente, o servidor
// reconfirma na API da Mercado Pago (no máximo 1 consulta a cada 10 s por pedido).
router.get('/payments/orders/:id', async (req, res) => {
  try {
    if (!ORDER_ID_PATTERN.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const { payments, store } = getDefault();
    let row = await store.findOrderById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (row.status === 'PENDING') row = (await payments.refreshOrder(row)) || row;
    res.json(await publicOrderWithItems(row));
  } catch (err) {
    console.error('[rshoes] order status:', err.message);
    res.status(500).json({ error: 'Não deu pra consultar o pedido.' });
  }
});

// Reconciliação manual (admin): consulta o estado real na Mercado Pago e aplica as mesmas regras do webhook.
router.post('/admin/payments/reconcile/:orderId', async (req, res) => {
  try {
    const { payments, store } = getDefault();
    const row = await store.findOrderById(String(req.params.orderId || ''));
    if (!row) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const after = await payments.refreshOrder(row, { force: true });
    res.json({ ok: true, order: publicOrder(after || row) });
  } catch (err) {
    console.error('[rshoes] reconciliation:', err.message);
    res.status(err.status || 502).json({ error: 'Falha na reconciliação com a Mercado Pago.' });
  }
});

module.exports = router;
