'use strict';

// Configurações gerais da loja editáveis no painel (aba "Configurações").
// Guardadas em app_settings (chave site_settings). Toda entrada é sanitizada aqui.
// O site não vende nem cobra: o contato.whatsapp daqui é o número do botão "Chamar no WhatsApp".

// db é carregado sob demanda (as funções puras abaixo não dependem do banco e são testadas sem ele).
const getDb = () => require('./db');

const SETTINGS_KEY = 'site_settings';

const DEFAULTS = {
  store: { name: "Tênis Head", tagline: 'Tênis e streetwear escolhidos a dedo em São Luís, Maranhão.' },
  contact: { whatsapp: '', instagram: 'tenishead', email: '', hours: '' },
  seo: { homeTitle: "Tênis Head | Tênis e Streetwear em São Luís", homeDescription: '' },
  announcement: { active: false, text: '', link: '', bgColor: '#e10600', textColor: '#ffffff' },
};

function str(v, max, fallback) {
  if (v === undefined || v === null) return fallback;
  return String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}
function bool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
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

// Aceita parcial; completa com o que já existe (base) ou com os padrões.
function sanitize(input, base = DEFAULTS) {
  const i = input && typeof input === 'object' ? input : {};
  const s = i.store || {}, c = i.contact || {}, o = i.seo || {}, a = i.announcement || {};
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
  };
}

module.exports = { DEFAULTS, sanitize, getSiteSettings, saveSiteSettings, publicView };
