'use strict';

// Regras de pagamento PIX (Mercado Pago). Banco e cliente HTTP são injetados:
// em produção vêm de getDefault(); nos testes automatizados, de fakes.

const { normalizeStatus, MIN_AMOUNT_CENTS, cardMessage } = require('./mercadopago');

class PaymentError extends Error {
  constructor(message, status = 500, code = 'PAYMENT_ERROR') {
    super(message);
    this.name = 'PaymentError';
    this.status = status;
    this.code = code;
  }
}

function orderCents(order) {
  return Math.round(Number(order.amount) * 100);
}

// Converte falha do gateway numa mensagem segura para o cliente (sem detalhes internos).
function toPublicError(err) {
  const code = err && err.gatewayCode;
  if (code === 'AMOUNT_INVALID') return new PaymentError('Valor do pedido abaixo do mínimo para PIX.', 400, code);
  if (code === 'PAYER_INVALID') return new PaymentError('Informe um e-mail válido para gerar o PIX.', 400, code);
  if (code === 'TOO_MANY_REQUESTS') return new PaymentError('Muitos pagamentos sendo gerados agora. Aguarde alguns segundos e tente de novo.', 429, code);
  if (code === 'CARD_DATA_INVALID' || code === 'bad_request' || code === 'HTTP_400') return new PaymentError('Não foi possível processar o cartão. Confira os dados e tente novamente.', 400, code);
  if (code === 'GATEWAY_TIMEOUT') return new PaymentError('O provedor de pagamento demorou para responder. Tente novamente.', 504, code);
  return new PaymentError('Não deu pra gerar o pagamento agora. Tente novamente em instantes.', 502, code || 'GATEWAY_ERROR');
}

function createPayments({
  store,
  client,
  notifyPaid = async () => {},
  now = () => Date.now(),
  log = console,
  refreshMinSeconds = 10,
  expiryGraceMs = 2 * 60 * 1000,
  orphanAfterMs = 15 * 60 * 1000,
  fallbackExpiryMs = 24 * 60 * 60 * 1000,
  challengeExpiryMs = 30 * 60 * 1000,
} = {}) {
  // Cria a cobrança real para um pedido já gravado como PENDING (estoque reservado).
  // Em qualquer falha: pedido vira ERROR e o estoque é devolvido. Sem retry automático.
  async function startPixCharge(order) {
    const amountCents = orderCents(order);
    let charge;
    try {
      charge = await client.createPixCharge({
        amountCents,
        email: order.customer_email,
        name: order.customer_name,
        cpf: order.customer_cpf,
        description: `Pedido Tênis Head${order.product_name ? ' - ' + order.product_name : ''}`,
        externalReference: order.id,
        idempotencyKey: order.merchant_charge_id,
      });
    } catch (err) {
      log.error('[mercadopago] falha ao criar cobrança', { orderId: order.id, code: err.gatewayCode || err.code, http: err.httpStatus || null });
      await store.failOrderAndRelease(order.id, `Falha ao criar cobrança (${err.gatewayCode || 'erro'})`);
      throw toPublicError(err);
    }

    try {
      const linked = await store.saveCharge(order.id, charge);
      if (!linked) throw new Error('pedido já possuía cobrança vinculada');
    } catch (err) {
      // A cobrança existe no gateway, mas não foi vinculada. O cliente nunca recebe o QR
      // e o pedido órfão é encerrado pela reconciliação. O id fica no log p/ conferência.
      log.error('[mercadopago] cobrança criada mas não vinculada ao pedido', { orderId: order.id, paymentId: charge.id });
      throw new PaymentError('Não deu pra gerar o pagamento. Tente novamente.', 500, 'PERSIST_FAILED');
    }
    return store.findOrderById(order.id);
  }

  // Cobra o cartão (token vindo do navegador) para um pedido já gravado como PENDING.
  // Resultado: aprovado => pedido PAID (confirmado de novo na API); recusado => pedido FAILED e estoque devolvido;
  // em análise / aguardando banco (3DS) => segue PENDING e o webhook/consulta resolve depois.
  async function startCardCharge(order, card) {
    const amountCents = orderCents(order);
    let charge;
    try {
      charge = await client.createCardCharge({
        amountCents,
        token: card.token,
        installments: card.installments,
        paymentMethodId: card.paymentMethodId,
        issuerId: card.issuerId,
        email: order.customer_email,
        name: order.customer_name,
        cpf: order.customer_cpf,
        description: `Pedido Tênis Head${order.product_name ? ' - ' + order.product_name : ''}`,
        externalReference: order.id,
        idempotencyKey: order.merchant_charge_id,
        deviceId: card.deviceId,
      });
    } catch (err) {
      log.error('[mercadopago] falha ao cobrar cartão', { orderId: order.id, code: err.gatewayCode || err.code, http: err.httpStatus || null });
      await store.failOrderAndRelease(order.id, `Falha ao cobrar cartão (${err.gatewayCode || 'erro'})`);
      throw toPublicError(err);
    }

    let linked = false;
    try { linked = await store.saveCardCharge(order.id, charge); } catch (err) { linked = false; }
    if (!linked) {
      // O gateway já tem a cobrança, mas ela não ficou ligada ao pedido. Se foi aprovada, estorna para não cobrar sem pedido.
      log.error('[mercadopago] cartão cobrado mas não vinculado ao pedido', { orderId: order.id, paymentId: charge.id, status: charge.rawStatus });
      if (charge.status === 'PAID') {
        try { await client.refundPayment(charge.id, `refund-${order.merchant_charge_id}`); } catch (e) {
          log.error('[mercadopago] ESTORNO MANUAL NECESSÁRIO', { orderId: order.id, paymentId: charge.id });
        }
      }
      await store.failOrderAndRelease(order.id, 'Cartão não foi vinculado ao pedido');
      throw new PaymentError('Não deu pra concluir o pagamento. Tente novamente.', 500, 'PERSIST_FAILED');
    }
    if (charge.paidCents != null && charge.paidCents !== amountCents) {
      log.warn('[mercadopago] valor pago difere do enviado (a conta MP está cobrando juros próprios?)', { orderId: order.id, sent: amountCents, paid: charge.paidCents });
    }

    let message = null;
    if (charge.status === 'PAID') {
      // Nunca confia só na resposta da criação: confirma na API antes de marcar como pago.
      try {
        const tx = await client.getTransaction(charge.id);
        await applyPaid({ transaction: tx });
      } catch (err) {
        log.error('[mercadopago] não foi possível confirmar o cartão aprovado agora (webhook/conciliação resolvem)', { orderId: order.id, code: err.code || err.gatewayCode });
      }
    } else if (charge.status === 'FAILED') {
      message = cardMessage(charge.statusDetail);
      await applyFailed({ paymentId: charge.id, eventKey: `mp:${charge.id}:FAILED`, eventType: 'CARD_CREATE' });
    } else {
      message = charge.statusDetail ? cardMessage(charge.statusDetail, null) : null;
    }
    return { order: await store.findOrderById(order.id), card: { status: charge.status, statusDetail: charge.statusDetail, message, challenge: charge.challenge } };
  }

  // Aplica uma transação CONFIRMADA PELO GATEWAY (GET /transactions/:id) como paga.
  async function applyPaid({ transaction, eventKey = null, eventType = 'RECONCILIATION', payload = null }) {
    const paymentId = String(transaction && transaction.id || '');
    if (!paymentId) throw new PaymentError('ID da transação ausente.', 400, 'MISSING_ID');
    if (normalizeStatus(transaction.status) !== 'PAID') {
      throw new PaymentError('Transação não está paga.', 409, 'NOT_PAID');
    }

    const outcome = await store.tx(async (t) => {
      const order = await t.lockOrderByGatewayId(paymentId);
      if (!order) throw new PaymentError('Pedido não encontrado para esta transação.', 404, 'ORDER_NOT_FOUND');

      // Validações antes de gravar qualquer coisa (se lançar, a transação inteira é revertida,
      // inclusive o registro do evento — a notificação pode ser reenviada).
      const okType = ['DEPOSIT', 'CARD'];
      if (transaction.type && !okType.includes(normalizeStatus(transaction.type))) {
        throw new PaymentError('Tipo de transação inesperado para um pagamento de pedido.', 409, 'TYPE_MISMATCH');
      }
      const expected = orderCents(order);
      if (!Number.isInteger(transaction.amount) || transaction.amount !== expected) {
        log.error('[mercadopago] valor divergente', { orderId: order.id, expected, received: transaction.amount });
        throw new PaymentError(`Valor divergente: esperado ${expected} centavos, recebido ${transaction.amount}.`, 409, 'AMOUNT_MISMATCH');
      }

      if (eventKey) {
        const inserted = await t.recordEvent({ key: eventKey, merchantChargeId: order.merchant_charge_id, type: eventType, status: 'PAID', payload });
        if (!inserted) return { order, duplicate: true, paidNow: false };
      }
      if (order.status === 'PAID') return { order, duplicate: false, paidNow: false };

      let note = null;
      if (!Number(order.stock_reserved)) {
        // Pedido já tinha expirado/falhado e o estoque foi devolvido: tenta reservar de novo.
        const reserved = await t.reserveStock(order);
        if (!reserved) note = 'Pago após o pedido ter sido encerrado e sem estoque suficiente — revisar manualmente.';
      }
      await t.markPaid(order, { note });
      await t.enqueueNotification(order.id);
      return { order: await t.getOrder(order.id), duplicate: false, paidNow: true };
    });

    if (outcome.paidNow) {
      try { await notifyPaid(outcome.order.id); } catch (err) {
        log.error('[mercadopago] notificação pós-pagamento falhou (pagamento segue confirmado)', { orderId: outcome.order.id });
      }
    }
    return outcome;
  }

  // payment.failed: cobrança recusada ou expirada sem pagamento (conforme a documentação).
  async function applyFailed({ paymentId, eventKey = null, eventType = 'payment.failed', payload = null }) {
    return store.tx(async (t) => {
      const order = await t.lockOrderByGatewayId(String(paymentId || ''));
      if (!order) throw new PaymentError('Pedido não encontrado para esta transação.', 404, 'ORDER_NOT_FOUND');
      if (eventKey) {
        const inserted = await t.recordEvent({ key: eventKey, merchantChargeId: order.merchant_charge_id, type: eventType, status: 'FAILED', payload });
        if (!inserted) return { order, duplicate: true };
      }
      // Um pedido já pago nunca volta atrás por causa de um evento de falha.
      if (order.status !== 'PENDING') return { order, duplicate: false };
      await t.closeOrder(order, 'FAILED');
      return { order: await t.getOrder(order.id), duplicate: false };
    });
  }

  // Reconsulta o estado real no gateway. Usado pelo status do pedido (com throttle),
  // pela reconciliação agendada e pelo botão do admin (force).
  async function refreshOrder(order, { force = false } = {}) {
    if (!order || order.status !== 'PENDING' || !order.mp_id) return order;

    if (force) await store.touchChecked(order.id);
    else if (!(await store.claimRefresh(order.id, refreshMinSeconds))) return order;

    let tx;
    try {
      tx = await client.getTransaction(order.mp_id);
    } catch (err) {
      log.error('[mercadopago] consulta de cobrança falhou', { orderId: order.id, code: err.gatewayCode || err.code });
      if (force) throw err;
      return order;
    }

    if (tx.status === 'PAID') {
      try {
        const out = await applyPaid({ transaction: tx });
        return out.order;
      } catch (err) {
        log.error('[mercadopago] não foi possível aplicar pagamento consultado', { orderId: order.id, code: err.code });
        if (force) throw err;
        return order;
      }
    }

    if (tx.status === 'FAILED') {
      try {
        const out = await applyFailed({ paymentId: order.mp_id, eventKey: `mp:${order.mp_id}:FAILED`, eventType: 'RECONCILIATION' });
        return out.order;
      } catch (err) {
        log.error('[mercadopago] não foi possível encerrar pedido recusado', { orderId: order.id, code: err.code });
        if (force) throw err;
        return order;
      }
    }

    // Demais status ficam apenas registrados; o pedido não muda por eles.
    await store.setGatewayStatus(order.id, tx.status, tx.statusDetail);

    const createdMs = new Date(order.created_at).getTime();
    const isCard = order.payment_method === 'credit_card' || order.payment_method === 'debit_card';
    const cardWaitMs = isCard && order.mp_status_detail === 'pending_challenge' ? challengeExpiryMs : fallbackExpiryMs;
    const expiresMs = order.pix_expires_at ? new Date(order.pix_expires_at).getTime() : createdMs + cardWaitMs;
    if (Number.isFinite(expiresMs) && now() > expiresMs + expiryGraceMs) {
      await store.expireOrder(order.id);
    }
    return store.findOrderById(order.id);
  }

  // Executada a cada 10 min (reconcile-payments): rede de segurança caso um webhook se perca.
  async function reconcilePending({ limit = 20 } = {}) {
    const orphans = await store.expireOrphans(orphanAfterMs);
    const rows = await store.listReconcilable(limit);
    const summary = { checked: 0, paid: 0, expired: 0, failed: 0, orphans };
    for (const row of rows) {
      summary.checked += 1;
      try {
        const after = await refreshOrder(row, { force: true });
        if (after && after.status === 'PAID') summary.paid += 1;
        else if (after && after.status === 'EXPIRED') summary.expired += 1;
      } catch (err) {
        summary.failed += 1;
      }
    }
    return summary;
  }

  return { startPixCharge, startCardCharge, applyPaid, applyFailed, refreshOrder, reconcilePending };
}

let defaultInstance = null;
function getDefault() {
  if (!defaultInstance) {
    const { createClient } = require('./mercadopago');
    const store = require('./payments-store');
    const { deliverPendingWhatsApp } = require('./order-notifications');
    const client = createClient();
    defaultInstance = {
      payments: createPayments({ store, client, notifyPaid: deliverPendingWhatsApp }),
      store,
      client,
    };
  }
  return defaultInstance;
}

module.exports = { createPayments, PaymentError, toPublicError, getDefault, orderCents, MIN_AMOUNT_CENTS };
