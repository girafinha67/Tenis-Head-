'use strict';

// Parcelamento no cartão com acréscimo (juros/taxa repassada ao cliente).
//
// A taxa é um PERCENTUAL TOTAL sobre o valor da compra, por número de parcelas
// (ex.: 6x = 8,5% => compra de R$ 100,00 vira R$ 108,50 em 6x de R$ 18,08).
// A tabela é editável no painel (Configurações > Cartão) e o cálculo definitivo
// é SEMPRE refeito no servidor: o navegador só mostra a simulação.
//
// IMPORTANTE (Mercado Pago): o valor enviado ao gateway já inclui o acréscimo, então a conta
// do Mercado Pago deve estar configurada para parcelar "sem juros para o comprador"
// (a loja absorve o custo do parcelamento junto ao MP e o repassa por esta tabela).

const MAX_INSTALLMENTS = 12;

// Valores iniciais de exemplo — ajuste no painel conforme o que o Mercado Pago cobra de você.
const DEFAULT_RATES = [0, 4.5, 5.5, 6.5, 7.5, 8.5, 10, 11, 12, 13, 14, 15];

const DEFAULT_CARD = {
  enabled: true,
  credit: true,
  debit: true,
  maxInstallments: 12,
  minInstallment: 5, // R$ — valor mínimo de cada parcela
  rates: DEFAULT_RATES,
  debitFee: 0, // % sobre o valor, no débito
};

const CREDIT = 'credit_card';
const DEBIT = 'debit_card';

function ratePercent(card, type, installments) {
  if (type === DEBIT) return Number(card.debitFee) || 0;
  const r = Number(card.rates && card.rates[installments - 1]);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

// baseCents = valor da compra já com cupom, sem acréscimo.
function quote(baseCents, card, { type, installments }) {
  const n = type === DEBIT ? 1 : installments;
  const pct = ratePercent(card, type, n);
  const feeCents = Math.round((baseCents * pct) / 100);
  const totalCents = baseCents + feeCents;
  return { installments: n, ratePercent: pct, feeCents, totalCents, installmentCents: Math.round(totalCents / n) };
}

// Opções que o cliente vê no crédito: 1x até o máximo, respeitando o valor mínimo da parcela.
function creditOptions(baseCents, card) {
  const minCents = Math.round(Number(card.minInstallment || 0) * 100);
  const max = Math.max(1, Math.min(MAX_INSTALLMENTS, Number(card.maxInstallments) || 1));
  const out = [];
  for (let n = 1; n <= max; n += 1) {
    const q = quote(baseCents, card, { type: CREDIT, installments: n });
    if (n > 1 && q.totalCents / n < minCents) break;
    out.push(q);
  }
  return out;
}

// Valida a escolha do cliente (feita no navegador) contra as regras do servidor.
function quoteChecked(baseCents, card, { type, installments }) {
  if (type !== CREDIT && type !== DEBIT) throw new Error('Forma de pagamento inválida.');
  if (type === CREDIT && !card.credit) throw new Error('Cartão de crédito indisponível no momento.');
  if (type === DEBIT && !card.debit) throw new Error('Cartão de débito indisponível no momento.');
  const n = type === DEBIT ? 1 : installments;
  if (!Number.isInteger(n) || n < 1) throw new Error('Número de parcelas inválido.');
  if (type === CREDIT && !creditOptions(baseCents, card).some((o) => o.installments === n)) {
    throw new Error('Esse parcelamento não está disponível para o valor do pedido.');
  }
  return quote(baseCents, card, { type, installments: n });
}

module.exports = { MAX_INSTALLMENTS, DEFAULT_RATES, DEFAULT_CARD, CREDIT, DEBIT, ratePercent, quote, creditOptions, quoteChecked };
