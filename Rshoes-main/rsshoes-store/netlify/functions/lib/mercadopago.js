'use strict';

// Cliente da API Mercado Pago (PIX) — https://www.mercadopago.com.br/developers/pt/reference
//
//  - Base URL:      https://api.mercadopago.com
//  - Autenticação:  header `Authorization: Bearer <MERCADOPAGO_ACCESS_TOKEN>`
//  - Criar PIX:     POST /v1/payments  (header X-Idempotency-Key obrigatório; valor em REAIS)
//  - Consultar:     GET  /v1/payments/:id
//  - Webhook:       header `x-signature` = "ts=...,v1=..." ; v1 = HMAC-SHA256 do manifest
//                   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com a chave secreta do webhook.
//
// O vínculo pedido <-> cobrança é o `id` do pagamento, gravado em orders.mp_id
// (e o pedido vai em `external_reference`). O X-Idempotency-Key é o merchant_charge_id do pedido.

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.mercadopago.com';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_EXPIRATION_MINUTES = 30;
const MIN_AMOUNT_CENTS = 50;
const ID_PATTERN = /^[0-9]{5,20}$/;

class GatewayError extends Error {
  constructor(message, { code, httpStatus, details } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.gatewayCode = code || 'GATEWAY_ERROR';
    this.httpStatus = httpStatus || null;
    // `details` nunca contém o access token; só dados devolvidos pelo gateway.
    this.details = details || null;
  }
}

// PIX => 'DEPOSIT' (como antes); cartão de crédito/débito => 'CARD'.
function methodType(data) {
  const id = String(data.payment_method_id || '').toLowerCase();
  const typeId = String(data.payment_type_id || '').toLowerCase();
  if (id === 'pix' || typeId === 'bank_transfer') return 'DEPOSIT';
  if (typeId === 'credit_card' || typeId === 'debit_card' || typeId === 'prepaid_card') return 'CARD';
  return normalizeStatus(data.payment_method_id);
}

function normalizeStatus(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

// Status do Mercado Pago -> status internos usados pelo resto do sistema.
//  approved -> PAID | rejected/cancelled -> FAILED | demais (pending, in_process...) -> PENDING
function mapStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === 'approved') return 'PAID';
  if (s === 'rejected' || s === 'cancelled' || s === 'canceled') return 'FAILED';
  if (s === 'refunded' || s === 'charged_back') return 'REFUNDED';
  return 'PENDING';
}

// Mensagem segura para o cliente a partir do status_detail de um cartão recusado.
const CARD_MESSAGES = {
  cc_rejected_insufficient_amount: 'Saldo ou limite insuficiente no cartão. Tente outro cartão ou pague no Pix.',
  cc_rejected_bad_filled_card_number: 'Confira o número do cartão.',
  cc_rejected_bad_filled_date: 'Confira a data de validade do cartão.',
  cc_rejected_bad_filled_security_code: 'Confira o código de segurança (CVV) do cartão.',
  cc_rejected_bad_filled_other: 'Confira os dados do cartão e tente novamente.',
  cc_rejected_call_for_authorize: 'O banco precisa autorizar este pagamento. Fale com o emissor do cartão ou use outro meio de pagamento.',
  cc_rejected_card_disabled: 'Cartão inativo. Ative-o com o seu banco ou use outro cartão.',
  cc_rejected_card_error: 'Não foi possível processar o cartão. Tente novamente ou use outro cartão.',
  cc_rejected_duplicated_payment: 'Você já fez um pagamento igual a este há pouco. Confira antes de pagar de novo.',
  cc_rejected_high_risk: 'Pagamento recusado por segurança. Tente outro cartão ou pague no Pix.',
  cc_rejected_max_attempts: 'Limite de tentativas atingido. Use outro cartão ou tente mais tarde.',
  cc_rejected_blacklist: 'Não foi possível processar este cartão. Use outro meio de pagamento.',
  cc_rejected_invalid_installments: 'Este cartão não aceita esse número de parcelas. Escolha outro parcelamento.',
  cc_rejected_card_type_not_allowed: 'Este tipo de cartão não é aceito. Use outro cartão ou pague no Pix.',
  cc_rejected_3ds_challenge: 'A autenticação do banco não foi concluída. Tente novamente.',
  cc_rejected_other_reason: 'O banco recusou o pagamento. Tente outro cartão ou pague no Pix.',
  pending_challenge: 'Aguardando a confirmação do pagamento junto ao seu banco.',
  pending_contingency: 'Estamos processando seu pagamento. Em instantes você recebe a confirmação.',
  pending_review_manual: 'Seu pagamento está em análise. Em até 2 dias úteis você recebe a confirmação.',
};
function cardMessage(detail, fallback = 'O pagamento no cartão não foi aprovado. Tente outro cartão ou pague no Pix.') {
  const d = String(detail == null ? '' : detail).trim().toLowerCase();
  return CARD_MESSAGES[d] || fallback;
}

function readConfig(env) {
  const accessToken = String(env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  if (!accessToken) throw new GatewayError('MERCADOPAGO_ACCESS_TOKEN não configurado.', { code: 'NOT_CONFIGURED' });
  const baseUrl = String(env.MERCADOPAGO_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new GatewayError('MERCADOPAGO_BASE_URL precisa ser HTTPS.', { code: 'NOT_CONFIGURED' });
  }
  const timeoutMs = Number(env.MERCADOPAGO_TIMEOUT_MS) > 0 ? Number(env.MERCADOPAGO_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const expMin = Number(env.MERCADOPAGO_PIX_EXPIRATION_MINUTES);
  const expirationMinutes = expMin >= 1 && expMin <= 60 * 24 * 30 ? Math.floor(expMin) : DEFAULT_EXPIRATION_MINUTES;
  const notificationUrl = String(env.MERCADOPAGO_NOTIFICATION_URL || '').trim();
  return { accessToken, baseUrl, timeoutMs, expirationMinutes, notificationUrl };
}

// "2026-10-15T10:00:00.000-03:00" (formato exigido pelo Mercado Pago em date_of_expiration)
function formatExpiration(ms) {
  const local = new Date(ms - 3 * 60 * 60 * 1000);
  return local.toISOString().replace('Z', '-03:00');
}

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}

function createClient({ env = process.env, fetchImpl, now = () => Date.now() } = {}) {
  async function request(method, path, body, extraHeaders = {}) {
    const cfg = readConfig(env);
    const doFetch = fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    let status;
    let text;
    try {
      const response = await doFetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new GatewayError('O Mercado Pago não respondeu a tempo.', { code: 'GATEWAY_TIMEOUT' });
      }
      throw new GatewayError('Falha de rede ao falar com o Mercado Pago.', { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }

    if (status < 200 || status >= 300) {
      let code = `HTTP_${status}`;
      if (status === 429) code = 'TOO_MANY_REQUESTS';
      else if (data && data.error && typeof data.error === 'string') code = data.error;
      const message = (data && typeof data.message === 'string' && data.message) || 'sem detalhe';
      throw new GatewayError(`Mercado Pago respondeu ${status} (${code}): ${message}`, {
        code,
        httpStatus: status,
        details: data && typeof data === 'object' ? { code, message } : null,
      });
    }
    if (!data || typeof data !== 'object') {
      throw new GatewayError('Resposta do Mercado Pago não é um JSON válido.', { code: 'INVALID_GATEWAY_RESPONSE', httpStatus: status });
    }
    return { status, data };
  }

  function toDataUrl(qr) {
    if (typeof qr !== 'string' || !qr.trim()) return null;
    const v = qr.trim();
    if (/^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/i.test(v)) return v;
    if (/^[A-Za-z0-9+/=]+$/.test(v)) return `data:image/png;base64,${v}`;
    return null;
  }

  // Cria uma cobrança PIX REAL. A chave de idempotência (id do pedido) evita cobrança duplicada
  // caso a mesma requisição seja repetida. Mesmo assim, nunca repetimos automaticamente.
  async function createPixCharge({ amountCents, email, name, cpf, description, externalReference, idempotencyKey }) {
    if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS) {
      throw new GatewayError(`Valor mínimo da cobrança é ${MIN_AMOUNT_CENTS} centavos.`, { code: 'AMOUNT_INVALID' });
    }
    const cfg = readConfig(env);
    const payerEmail = String(email || '').trim();
    if (!payerEmail) throw new GatewayError('E-mail do pagador é obrigatório no Mercado Pago.', { code: 'PAYER_INVALID' });

    const fullName = String(name || '').trim().split(/\s+/).filter(Boolean);
    const cpfDigits = onlyDigits(cpf);
    const expiresMs = now() + cfg.expirationMinutes * 60 * 1000;

    const payload = {
      transaction_amount: Number((amountCents / 100).toFixed(2)),
      description: String(description || 'Pedido Tênis Head').slice(0, 250),
      payment_method_id: 'pix',
      date_of_expiration: formatExpiration(expiresMs),
      payer: {
        email: payerEmail,
        ...(fullName.length ? { first_name: fullName[0] } : {}),
        ...(fullName.length > 1 ? { last_name: fullName.slice(1).join(' ') } : {}),
        ...(cpfDigits.length === 11 || cpfDigits.length === 14 ? { identification: { type: cpfDigits.length === 14 ? 'CNPJ' : 'CPF', number: cpfDigits } } : {}),
      },
      ...(externalReference ? { external_reference: String(externalReference) } : {}),
      ...(cfg.notificationUrl ? { notification_url: cfg.notificationUrl } : {}),
    };

    const key = String(idempotencyKey || crypto.randomUUID());
    const { data } = await request('POST', '/v1/payments', payload, { 'X-Idempotency-Key': key });

    const id = data.id != null ? String(data.id).trim() : '';
    const tx = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
    const copyPaste = typeof tx.qr_code === 'string' ? tx.qr_code.trim() : '';
    const qrCodeBase64 = toDataUrl(tx.qr_code_base64);
    const status = mapStatus(data.status);
    const receivedCents = Math.round(Number(data.transaction_amount) * 100);

    if (!ID_PATTERN.test(id) || !copyPaste || !qrCodeBase64 || status !== 'PENDING' || receivedCents !== amountCents) {
      // Nunca monta QR/copia-e-cola a partir de resposta incompleta ou divergente.
      throw new GatewayError('Resposta inválida do Mercado Pago ao criar a cobrança.', {
        code: 'INVALID_GATEWAY_RESPONSE',
        details: { hasId: Boolean(id), hasCopyPaste: Boolean(copyPaste), hasQr: Boolean(qrCodeBase64), status, amountMatches: receivedCents === amountCents },
      });
    }

    let expiresAt = new Date(expiresMs).toISOString();
    if (data.date_of_expiration) {
      const d = new Date(data.date_of_expiration);
      if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
    }

    const fee = Array.isArray(data.fee_details) && data.fee_details.length
      ? Math.round(data.fee_details.reduce((s, f) => s + Number(f.amount || 0), 0) * 100)
      : null;

    return {
      id,
      status: 'PENDING',
      amountCents,
      copyPaste,
      qrCodeBase64,
      expiresAt,
      fee: Number.isInteger(fee) ? fee : null,
    };
  }

  // Cobrança no CARTÃO (crédito/débito) a partir do token gerado no navegador (o número do cartão nunca passa por aqui).
  // `amountCents` já inclui o acréscimo de parcelamento. Recusa do banco NÃO lança erro: volta com status FAILED.
  async function createCardCharge({
    amountCents, token, installments, paymentMethodId, issuerId, email, name, cpf,
    description, externalReference, idempotencyKey, deviceId,
  }) {
    if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS) {
      throw new GatewayError(`Valor mínimo da cobrança é ${MIN_AMOUNT_CENTS} centavos.`, { code: 'AMOUNT_INVALID' });
    }
    const cfg = readConfig(env);
    const payerEmail = String(email || '').trim();
    if (!payerEmail) throw new GatewayError('E-mail do pagador é obrigatório no Mercado Pago.', { code: 'PAYER_INVALID' });
    const inst = Number(installments);
    if (!token || !paymentMethodId || !Number.isInteger(inst) || inst < 1) {
      throw new GatewayError('Dados do cartão incompletos.', { code: 'CARD_DATA_INVALID' });
    }
    const fullName = String(name || '').trim().split(/\s+/).filter(Boolean);
    const cpfDigits = onlyDigits(cpf);
    const threeDs = String(env.MERCADOPAGO_3DS_MODE || 'optional').trim().toLowerCase() === 'not_supported' ? 'not_supported' : 'optional';
    const descriptor = String(env.MERCADOPAGO_STATEMENT_DESCRIPTOR || '').trim().slice(0, 22);

    const payload = {
      transaction_amount: Number((amountCents / 100).toFixed(2)),
      token: String(token),
      description: String(description || 'Pedido Tênis Head').slice(0, 250),
      installments: inst,
      payment_method_id: String(paymentMethodId),
      ...(issuerId && /^\d+$/.test(String(issuerId)) ? { issuer_id: Number(issuerId) } : {}),
      capture: true,
      binary_mode: false,
      three_d_secure_mode: threeDs,
      ...(descriptor ? { statement_descriptor: descriptor } : {}),
      payer: {
        email: payerEmail,
        ...(fullName.length ? { first_name: fullName[0] } : {}),
        ...(fullName.length > 1 ? { last_name: fullName.slice(1).join(' ') } : {}),
        ...(cpfDigits.length === 11 || cpfDigits.length === 14 ? { identification: { type: cpfDigits.length === 14 ? 'CNPJ' : 'CPF', number: cpfDigits } } : {}),
      },
      ...(externalReference ? { external_reference: String(externalReference) } : {}),
      ...(cfg.notificationUrl ? { notification_url: cfg.notificationUrl } : {}),
    };

    const key = String(idempotencyKey || crypto.randomUUID());
    const headers = { 'X-Idempotency-Key': key };
    if (deviceId) headers['X-meli-session-id'] = String(deviceId);
    const { data } = await request('POST', '/v1/payments', payload, headers);

    const id = data.id != null ? String(data.id).trim() : '';
    const receivedCents = Math.round(Number(data.transaction_amount) * 100);
    if (!ID_PATTERN.test(id) || typeof data.status !== 'string' || receivedCents !== amountCents) {
      throw new GatewayError('Resposta inválida do Mercado Pago ao cobrar o cartão.', {
        code: 'INVALID_GATEWAY_RESPONSE',
        details: { hasId: Boolean(id), status: data.status || null, amountMatches: receivedCents === amountCents },
      });
    }
    const td = data.three_ds_info && typeof data.three_ds_info === 'object' ? data.three_ds_info : null;
    const challenge = td && typeof td.external_resource_url === 'string' && /^https:\/\//i.test(td.external_resource_url) && td.creq
      ? { url: td.external_resource_url, creq: String(td.creq) }
      : null;
    const card = data.card && typeof data.card === 'object' ? data.card : {};
    const paidCents = data.transaction_details && data.transaction_details.total_paid_amount != null
      ? Math.round(Number(data.transaction_details.total_paid_amount) * 100) : null;
    const fee = Array.isArray(data.fee_details) && data.fee_details.length
      ? Math.round(data.fee_details.reduce((sum, f) => sum + Number(f.amount || 0), 0) * 100) : null;

    return {
      id,
      status: mapStatus(data.status),
      rawStatus: String(data.status).toLowerCase(),
      statusDetail: data.status_detail ? String(data.status_detail).toLowerCase() : null,
      amountCents,
      // Se o Mercado Pago somar juros por conta própria, total_paid_amount fica acima do valor enviado.
      paidCents: Number.isInteger(paidCents) ? paidCents : null,
      brand: String(data.payment_method_id || paymentMethodId || '').toLowerCase() || null,
      typeId: String(data.payment_type_id || '').toLowerCase() || null,
      lastFour: /^\d{4}$/.test(String(card.last_four_digits || '')) ? String(card.last_four_digits) : null,
      installments: Number.isInteger(Number(data.installments)) ? Number(data.installments) : inst,
      challenge,
      fee: Number.isInteger(fee) ? fee : null,
    };
  }

  // Estorno total (usado só quando o cartão foi cobrado e o pedido não pôde ser gravado).
  async function refundPayment(id, idempotencyKey) {
    const txId = String(id == null ? '' : id).trim();
    if (!ID_PATTERN.test(txId)) throw new GatewayError('ID de pagamento inválido.', { code: 'INVALID_TRANSACTION_ID' });
    await request('POST', `/v1/payments/${encodeURIComponent(txId)}/refunds`, {}, { 'X-Idempotency-Key': String(idempotencyKey || crypto.randomUUID()) });
    return true;
  }

  // Estado real do pagamento (fonte de verdade para confirmar pagamento).
  async function getTransaction(id) {
    const txId = String(id == null ? '' : id).trim();
    if (!ID_PATTERN.test(txId)) {
      throw new GatewayError('ID de pagamento inválido.', { code: 'INVALID_TRANSACTION_ID' });
    }
    const { data } = await request('GET', `/v1/payments/${encodeURIComponent(txId)}`);

    // Garante que a resposta é mesmo do pagamento pedido (evita um pedido alterar outro).
    const amountCents = Math.round(Number(data.transaction_amount) * 100);
    if (String(data.id) !== txId || typeof data.status !== 'string' || !Number.isInteger(amountCents)) {
      throw new GatewayError('Resposta inválida do Mercado Pago ao consultar a cobrança.', { code: 'INVALID_GATEWAY_RESPONSE' });
    }
    return {
      id: txId,
      status: mapStatus(data.status),
      rawStatus: normalizeStatus(data.status),
      type: methodType(data),
      statusDetail: data.status_detail ? String(data.status_detail).toLowerCase() : null,
      amount: amountCents,
      externalReference: data.external_reference != null ? String(data.external_reference) : null,
      fee: null,
    };
  }

  return { createPixCharge, createCardCharge, refundPayment, getTransaction };
}

// Assinatura do webhook, conforme a documentação do Mercado Pago:
//   x-signature: "ts=1704908010,v1=<hex>"
//   manifest   : "id:<data.id em minúsculas>;request-id:<x-request-id>;ts:<ts>;"
//   v1         : HMAC-SHA256(manifest, chave secreta) em hexadecimal.
function verifyWebhookSignature({ signatureHeader, requestId, dataId, secret }) {
  if (!secret || typeof signatureHeader !== 'string' || !signatureHeader.trim()) return false;
  let ts = '';
  let v1 = '';
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 'ts') ts = v;
    else if (k === 'v1') v1 = v;
  }
  if (!ts || !v1) return false;

  let manifest = '';
  if (dataId != null && String(dataId) !== '') manifest += `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;

  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const received = Buffer.from(v1.toLowerCase());
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && crypto.timingSafeEqual(received, wanted);
}

module.exports = {
  GatewayError,
  createClient,
  verifyWebhookSignature,
  normalizeStatus,
  mapStatus,
  cardMessage,
  MIN_AMOUNT_CENTS,
  ID_PATTERN,
};
