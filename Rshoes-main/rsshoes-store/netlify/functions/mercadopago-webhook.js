'use strict';

// Endpoint do webhook do Mercado Pago (Netlify Function dedicada).
// URL pública: https://SEU-SITE.netlify.app/.netlify/functions/mercadopago-webhook
// (cadastre em Mercado Pago > Suas integrações > Webhooks, evento "Pagamentos").

const { processWebhook } = require('./lib/mercadopago-webhook');

exports.handler = async (event) => {
  const json = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...json, Allow: 'POST' }, body: JSON.stringify({ error: 'Método não permitido.' }) };
  }

  const rawBody = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');

  const { getDefault } = require('./lib/payments');
  const deps = getDefault();
  const db = require('./lib/db');

  const result = await processWebhook(
    {
      payments: deps.payments,
      client: deps.client,
      store: deps.store,
      secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
      ready: () => db.init(),
    },
    { rawBody, headers: event.headers || {}, query: event.queryStringParameters || {} }
  );

  return { statusCode: result.statusCode, headers: json, body: JSON.stringify(result.body) };
};
