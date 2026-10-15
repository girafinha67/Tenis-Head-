'use strict';

// Leitura/validação do que o navegador manda para pagar no cartão e cálculo do valor final.
// Sem banco e sem rede (testável). O número do cartão NUNCA passa por aqui: o navegador troca
// os dados do cartão por um token direto com o Mercado Pago e só o token chega ao servidor.

const F = require('./card-fees');

function inputError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cardAvailable(settings, env = process.env) {
  return Boolean(
    settings && settings.card && settings.card.enabled && (settings.card.credit || settings.card.debit) &&
    String(env.MERCADOPAGO_PUBLIC_KEY || '').trim() && String(env.MERCADOPAGO_ACCESS_TOKEN || '').trim()
  );
}

const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const METHOD_RE = /^[a-z0-9_]{2,30}$/;
const ISSUER_RE = /^\d{1,12}$/;
const DEVICE_RE = /^[A-Za-z0-9._-]{8,128}$/;

// Devolve { method: 'pix' } ou { method: 'credit_card'|'debit_card', token, paymentMethodId, issuerId, installments, deviceId, expectedAmount }.
function parsePayment(body, settings, env = process.env) {
  const raw = String((body && body.paymentMethod) || 'pix').trim().toLowerCase();
  if (raw === 'pix') return { method: 'pix' };
  if (raw !== F.CREDIT && raw !== F.DEBIT) throw inputError('Forma de pagamento inválida.');
  if (!cardAvailable(settings, env)) throw inputError('Pagamento com cartão indisponível no momento. Use o Pix.', 503);
  if (raw === F.CREDIT && !settings.card.credit) throw inputError('Cartão de crédito indisponível no momento.', 422);
  if (raw === F.DEBIT && !settings.card.debit) throw inputError('Cartão de débito indisponível no momento.', 422);

  const c = (body && body.card) || {};
  const token = String(c.token || '').trim();
  const paymentMethodId = String(c.paymentMethodId || '').trim().toLowerCase();
  const issuerId = c.issuerId != null && String(c.issuerId).trim() !== '' ? String(c.issuerId).trim() : null;
  const deviceId = c.deviceId ? String(c.deviceId).trim() : null;
  if (!TOKEN_RE.test(token)) throw inputError('Não foi possível validar os dados do cartão. Confira e tente novamente.');
  if (!METHOD_RE.test(paymentMethodId)) throw inputError('Bandeira do cartão não identificada. Confira o número do cartão.');
  if (issuerId && !ISSUER_RE.test(issuerId)) throw inputError('Banco emissor inválido.');
  const installments = raw === F.DEBIT ? 1 : Math.floor(Number(c.installments || 1));
  if (!Number.isInteger(installments) || installments < 1 || installments > F.MAX_INSTALLMENTS) throw inputError('Número de parcelas inválido.');
  const expected = body.expectedAmount != null && body.expectedAmount !== '' ? Number(body.expectedAmount) : null;
  return {
    method: raw,
    token,
    paymentMethodId,
    issuerId,
    installments,
    deviceId: deviceId && DEVICE_RE.test(deviceId) ? deviceId : null,
    expectedAmountCents: Number.isFinite(expected) ? Math.round(expected * 100) : null,
  };
}

// baseCents = subtotal - cupom. Retorna o que será cobrado de fato (já com o acréscimo do parcelamento).
function priceOrder(baseCents, payment, settings) {
  if (payment.method === 'pix') return { feeCents: 0, totalCents: baseCents, installments: null };
  let q;
  try {
    q = F.quoteChecked(baseCents, settings.card, { type: payment.method, installments: payment.installments });
  } catch (err) {
    throw inputError(err.message, 422);
  }
  if (payment.expectedAmountCents != null && payment.expectedAmountCents !== q.totalCents) {
    throw inputError('O valor do pedido mudou. Atualize a página e confira o total antes de pagar.', 409);
  }
  return { feeCents: q.feeCents, totalCents: q.totalCents, installments: q.installments };
}

module.exports = { inputError, cardAvailable, parsePayment, priceOrder };
