'use strict';

const express = require('express');
const db = require('../lib/db');
const { asyncHandler } = require('../lib/http-utils');
const { log } = require('../lib/auth');
const siteSettings = require('../lib/site-settings');

const router = express.Router();

const SETTINGS_KEY = 'home_content';

const DEFAULT_HOME_CONTENT = {
  topbar: [
    'HÁ ANOS NO MERCADO DE TÊNIS E MODA',
    'PAGOU NO PIX, SEU PEDIDO SAI PRIMEIRO',
  ],
  hero: [
    { image: '/assets/hero/nike-air-force-black.jpg', link: '/catalogo.html?brand=Nike' },
    { image: '/assets/hero/nike-jordan-travis-scott.jpg', link: '/catalogo.html?brand=Nike' },
    { image: '/assets/hero/nike-air-force-verde.jpg', link: '/catalogo.html?brand=Nike' },
    { image: '/assets/hero/puma-speedcat-og.jpg', link: '/catalogo.html?q=Speedcat' },
    { image: '/assets/hero/adidas-adizero-adios.jpg', link: '/catalogo.html?q=Adizero' },
    { image: '/assets/hero/adidas-samba-originals.jpg', link: '/catalogo.html?q=Samba' },
    { image: '/assets/hero/adidas-samba-listras.jpg', link: '/catalogo.html?q=Samba' },
  ],
  benefits: [
    { icon: '🏆', title: 'Há anos no mercado', text: 'De tênis e moda.' },
    { icon: '↩️', title: 'Troca fácil', text: 'Até 7 dias depois que você receber.' },
    { icon: '🔒', title: 'Pagamento seguro', text: 'Pix seguro, confirmação automática.' },
    { icon: '🎧', title: 'Atendimento', text: 'Fale com a gente direto no WhatsApp.' },
  ],
  promoBanner: {
    active: true,
    eyebrow: 'PROMOÇÃO DE ATACADO',
    title: '🔥 COMPROU 2 PARES OU MAIS? GANHE R$ 30 DE DESCONTO EM CADA PAR!',
    subtitle: 'Leve 2 pares ou mais no atacado e cada par sai R$ 30 mais barato. Aproveite e monte o seu pedido!',
    ctaLabel: 'VER MODELOS NO ATACADO',
    ctaLink: '/catalogo.html?promo=1',
  },
};

function mergeDefaults(saved) {
  if (!saved || typeof saved !== 'object') return DEFAULT_HOME_CONTENT;
  return {
    topbar: Array.isArray(saved.topbar) && saved.topbar.length ? saved.topbar : DEFAULT_HOME_CONTENT.topbar,
    hero: Array.isArray(saved.hero) && saved.hero.length ? saved.hero : DEFAULT_HOME_CONTENT.hero,
    benefits: Array.isArray(saved.benefits) && saved.benefits.length ? saved.benefits : DEFAULT_HOME_CONTENT.benefits,
    promoBanner: saved.promoBanner && typeof saved.promoBanner === 'object'
      ? { ...DEFAULT_HOME_CONTENT.promoBanner, ...saved.promoBanner }
      : DEFAULT_HOME_CONTENT.promoBanner,
  };
}

// GET /api/settings/home — público, usado pela home para montar topbar/hero/benefícios/banner.
router.get(
  '/settings/home',
  asyncHandler(async (req, res) => {
    const raw = await db.getSetting(SETTINGS_KEY, null);
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    res.status(200).json(mergeDefaults(parsed));
  })
);

// PUT /api/admin/settings/home — protegido, usado pelo painel para editar os textos da home.
router.put(
  '/admin/settings/home',
  asyncHandler(async (req, res) => {
    const content = mergeDefaults(req.body || {});
    await db.setSetting(SETTINGS_KEY, JSON.stringify(content));
    await log(req.admin.id, 'settings_home_update', {});
    res.status(200).json({ ok: true, content });
  })
);

// GET /api/settings/site — público: nome, contato, SEO, aviso e regras do checkout (sempre fresco).
router.get(
  '/settings/site',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(siteSettings.publicView(await siteSettings.getSiteSettings()));
  })
);

// Painel: lê e salva as configurações gerais da loja.
router.get(
  '/admin/settings/site',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ settings: await siteSettings.getSiteSettings() });
  })
);

router.put(
  '/admin/settings/site',
  asyncHandler(async (req, res) => {
    const settings = await siteSettings.saveSiteSettings(req.body || {});
    await log(req.admin.id, 'settings_site_update', {});
    res.status(200).json({ ok: true, settings });
  })
);

module.exports = router;
