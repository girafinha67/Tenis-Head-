'use strict';

// Configurações gerais da loja editáveis no painel (aba "Configurações").
// Guardadas em app_settings (chave site_settings). Toda entrada é sanitizada aqui;
// o que o checkout aplica (vendas abertas, pedido mínimo, quantidade máxima, pontos,
// cupons) é lido do banco NO SERVIDOR a cada pedido — o navegador nunca decide isso.

// db é carregado sob demanda (as funções puras abaixo não dependem do banco e são testadas sem ele).
const getDb = () => require('./db');

const CARD = require('./card-fees');

const SETTINGS_KEY = 'site_settings';

const DEFAULTS = {
  store: { name: "Tênis Head", tagline: 'Tênis e streetwear escolhidos a dedo em São Luís, Maranhão.' },
  contact: { whatsapp: '', instagram: 'tenishead', email: '', hours: '' },
  seo: { homeTitle: "Tênis Head | Tênis e Streetwear em São Luís", homeDescription: '' },
  announcement: { active: false, text: '', link: '', bgColor: '#e10600', textColor: '#ffffff' },
  checkout: {
    salesOpen: true,
    closedMessage: 'Estamos com as vendas pausadas no momento. Volte em breve!',
    minOrder: 0,
    maxQuantity: 20,
    notice: '',
    couponsEnabled: true,
  },
  loyalty: { pointsPerReal: null },
  card: { ...CARD.DEFAULT_CARD, rates: [...CARD.DEFAULT_RATES] },
};

function str(v, max, fallback) {
  if (v === undefined || v === null) return fallback;
  return String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}
function bool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
}
function num(v, min, max, fallback, { integer = false } = {}) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}
function color(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : fallback;
}
function link(v) {
  const s = str(v, 300, '');
  return /^(\/[^\s]*|https:\/\/[^\s]+)$/.test(s) ? s : '';
}
function whatsapp(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const d = String(v).replace(/\D/g, '');
  if (!d) return '';
  return d.length >= 10 && d.length <= 15 ? d : fallback;
}
function instagram(v, fallback) {
  if (v === undefined || v === null) return fallback;
  let s = String(v).trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  if (!s) return '';
  return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s : fallback;
}
function email(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  if (!s) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120 ? s : fallback;
}

// Cartão: tabela de acréscimo por nº de parcelas (percentual total, 0 a 50%).
function sanitizeCard(input, base) {
  const i = input && typeof input === 'object' ? input : {};
  const rates = [];
  for (let n = 0; n < CARD.MAX_INSTALLMENTS; n += 1) {
    const incoming = Array.isArray(i.rates) ? i.rates[n] : undefined;
    rates.push(num(incoming, 0, 50, (base.rates && base.rates[n] != null) ? base.rates[n] : CARD.DEFAULT_RATES[n]));
  }
  return {
    enabled: bool(i.enabled, base.enabled),
    credit: bool(i.credit, base.credit),
    debit: bool(i.debit, base.debit),
    maxInstallments: num(i.maxInstallments, 1, CARD.MAX_INSTALLMENTS, base.maxInstallments, { integer: true }),
    minInstallment: num(i.minInstallment, 0, 10000, base.minInstallment),
    rates,
    debitFee: num(i.debitFee, 0, 50, base.debitFee),
  };
}

// Aceita parcial; completa com o que já existe (base) ou com os padrões.
function sanitize(input, base = DEFAULTS) {
  const i = input && typeof input === 'object' ? input : {};
  const s = i.store || {}, c = i.contact || {}, o = i.seo || {}, a = i.announcement || {}, k = i.checkout || {}, l = i.loyalty || {};
  const b = base;
  return {
    store: {
      name: str(s.name, 60, b.store.name) || DEFAULTS.store.name,
      tagline: str(s.tagline, 200, b.store.tagline),
    },
    contact: {
      whatsapp: whatsapp(c.whatsapp, b.contact.whatsapp),
      instagram: instagram(c.instagram, b.contact.instagram),
      email: email(c.email, b.contact.email),
      hours: str(c.hours, 120, b.contact.hours),
    },
    seo: {
      homeTitle: str(o.homeTitle, 70, b.seo.homeTitle) || DEFAULTS.seo.homeTitle,
      homeDescription: str(o.homeDescription, 170, b.seo.homeDescription),
    },
    announcement: {
      active: bool(a.active, b.announcement.active),
      text: str(a.text, 160, b.announcement.text),
      link: a.link === undefined ? b.announcement.link : link(a.link),
      bgColor: color(a.bgColor, b.announcement.bgColor),
      textColor: color(a.textColor, b.announcement.textColor),
    },
    checkout: {
      salesOpen: bool(k.salesOpen, b.checkout.salesOpen),
      closedMessage: str(k.closedMessage, 200, b.checkout.closedMessage) || DEFAULTS.checkout.closedMessage,
      minOrder: num(k.minOrder, 0, 100000, b.checkout.minOrder),
      maxQuantity: num(k.maxQuantity, 1, 99, b.checkout.maxQuantity, { integer: true }),
      notice: str(k.notice, 300, b.checkout.notice),
      couponsEnabled: bool(k.couponsEnabled, b.checkout.couponsEnabled),
    },
    loyalty: {
      pointsPerReal: l.pointsPerReal === null || l.pointsPerReal === '' ? null : num(l.pointsPerReal, 0, 1000, b.loyalty.pointsPerReal),
    },
    card: sanitizeCard(i.card, b.card || DEFAULTS.card),
  };
}

async function getSiteSettings() {
  const raw = await getDb().getSetting(SETTINGS_KEY, null);
  let saved = null;
  if (raw) { try { saved = JSON.parse(raw); } catch { saved = null; } }
  return sanitize(saved, DEFAULTS);
}

async function saveSiteSettings(input) {
  const current = await getSiteSettings();
  const next = sanitize(input, current);
  await getDb().setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// O que o site público precisa saber (sem nada interno).
function publicView(s) {
  return {
    store: s.store,
    contact: s.contact,
    seo: s.seo,
    announcement: s.announcement.active && s.announcement.text ? s.announcement : { active: false },
    checkout: {
      salesOpen: s.checkout.salesOpen,
      closedMessage: s.checkout.closedMessage,
      minOrder: s.checkout.minOrder,
      maxQuantity: s.checkout.maxQuantity,
      notice: s.checkout.notice,
      couponsEnabled: s.checkout.couponsEnabled,
    },
  };
}

function pointsPerReal(s) {
  const v = s.loyalty.pointsPerReal;
  if (v !== null && v !== undefined) return v;
  const env = Number(process.env.POINTS_PER_REAL);
  return Number.isFinite(env) && env >= 0 ? env : 1;
}

module.exports = { DEFAULTS, sanitize, getSiteSettings, saveSiteSettings, publicView, pointsPerReal };
