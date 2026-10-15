'use strict';

// Processamento do webhook do Mercado Pago (sem dependência de Netlify/Express,
// para poder ser testado). A Netlify Function mercadopago-webhook.js só adapta
// o evento HTTP e chama processWebhook().
//
// Contrato (documentação oficial):
//  - POST com query `?data.id=<id>&type=payment` e corpo { action, type, data: { id } }
//  - Assinatura no header `x-signature` ("ts=...,v1=...") + `x-request-id`
//  - Respondemos 200/201 quando o evento foi recebido; qualquer outro status gera reenvio.
//  - O corpo do evento NÃO traz o status: sempre consultamos GET /v1/payments/:id
//    (fonte de verdade) antes de marcar o pedido como pago ou falho.
//  - O mesmo evento pode chegar mais de uma vez: chave de idempotência = mp:<id>:<status>.

const { verifyWebhookSignature, ID_PATTERN } = require('./mercadopago');
const { PaymentError } = require('./payments');

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] ?? '');
  }
  return '';
}

function respond(statusCode, body) {
  return { statusCode, body };
}

async function processWebhook({ payments, client, store, secret, ready, log = console }, { rawBody, headers, query = {} }) {
  let payload = null;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { payload = null; }

  if (!secret) {
    log.error('[mercadopago-webhook] MERCADOPAGO_WEBHOOK_SECRET não configurada; evento recusado.');
    return respond(500, { error: 'Webhook não configurado.' });
  }

  // O id do pagamento vem na query (data.id) e/ou no corpo (data.id).
  const bodyId = payload && payload.data && payload.data.id != null ? String(payload.data.id).trim() : '';
  const queryId = String(query['data.id'] ?? query.id ?? '').trim();
  const dataId = queryId || bodyId;

  const valid = verifyWebhookSignature({
    signatureHeader: headerValue(headers, 'x-signature'),
    requestId: headerValue(headers, 'x-request-id'),
    dataId,
    secret,
  });
  if (!valid) {
    log.warn('[mercadopago-webhook] assinatura inválida');
    return respond(401, { error: 'Assinatura inválida.' });
  }

  const type = String((payload && payload.type) || query.type || query.topic || '').toLowerCase();
  if (type !== 'payment') return respond(200, { received: true, ignored: true });

  // Notificação de teste do painel (id fictício) — não altera nada.
  if (dataId === '123456') return respond(200, { received: true, test: true });

  const paymentId = dataId;
  if (!ID_PATTERN.test(paymentId)) return respond(400, { error: 'ID do pagamento ausente ou inválido.' });

  try {
    if (ready) await ready();

    // O pedido é sempre localizado pelo id do pagamento (único): um evento nunca atinge outro pedido.
    const order = await store.findOrderByGatewayId(paymentId);
    if (!order) {
      // Pagamento que não é de nenhum pedido desta loja: confirma recebimento para o MP não reenviar.
      log.warn('[mercadopago-webhook] pagamento sem pedido correspondente', { paymentId });
      return respond(200, { received: true, ignored: true });
    }

    // O estado real é confirmado na API (e o valor é conferido contra o pedido).
    const confirmed = await client.getTransaction(paymentId);
    const eventKey = `mp:${paymentId}:${confirmed.status}`;

    let result;
    if (confirmed.status === 'PAID') {
      result = await payments.applyPaid({ transaction: confirmed, eventKey, eventType: String((payload && payload.action) || 'payment.updated'), payload });
    } else if (confirmed.status === 'FAILED') {
      result = await payments.applyFailed({ paymentId, eventKey, eventType: String((payload && payload.action) || 'payment.updated'), payload });
    } else {
      return respond(200, { received: true, pending: true, status: confirmed.rawStatus || confirmed.status });
    }

    return respond(200, { received: true, duplicate: Boolean(result.duplicate), status: result.order && result.order.status });
  } catch (err) {
    if (err instanceof PaymentError) {
      log.error('[mercadopago-webhook] evento rejeitado', { paymentId, code: err.code });
      return respond(err.status, { error: err.message });
    }
    if (err && err.name === 'GatewayError') {
      log.error('[mercadopago-webhook] falha ao consultar a API', { paymentId, code: err.gatewayCode });
      return respond(502, { error: 'Falha ao confirmar o pagamento na API.' });
    }
    log.error('[mercadopago-webhook] erro interno', { paymentId, message: err && err.message });
    return respond(500, { error: 'Erro interno.' });
  }
}

module.exports = { processWebhook };
