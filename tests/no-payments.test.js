'use strict';

// Garante que a versão "só WhatsApp" não tem nada de pagamento no site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
const code = [...walk(path.join(ROOT, 'public')), ...walk(path.join(ROOT, 'netlify'))].filter((f) => /\.(html|js|css)$/.test(f));
const rel = (f) => path.relative(ROOT, f);

test('arquivos de carrinho, checkout, pagamento e cupom não existem mais', () => {
  for (const f of ['public/carrinho.html', 'public/checkout.html', 'public/admin/cupons.html', 'public/js/admin-cupons.js',
    'netlify/functions/mercadopago-webhook.js', 'netlify/functions/reconcile-payments.js', 'netlify/functions/routes/orders.routes.js',
    'netlify/functions/routes/coupons.routes.js', 'netlify/functions/lib/mercadopago.js', 'netlify/functions/lib/payments.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), false, f);
  }
});

test('nenhuma página, script ou função cita pagamento pelo site', () => {
  // db.js mantém o schema antigo (tabelas e dados dos pedidos anteriores continuam intactos no banco).
  const skip = new Set(['netlify/functions/lib/db.js']);
  const banned = /mercadopago|mercado pago|api\/payments|checkout\.html|carrinho\.html|addToCart|data-quick-add|COMPRAR AGORA|ADICIONAR AO CARRINHO/i;
  for (const f of code) {
    if (skip.has(rel(f))) continue;
    assert.ok(!banned.test(fs.readFileSync(f, 'utf8')), `${rel(f)} ainda cita pagamento/carrinho`);
  }
});

test('API não monta rotas de pedido, pagamento ou cupom', () => {
  const api = fs.readFileSync(path.join(ROOT, 'netlify/functions/api.js'), 'utf8');
  assert.ok(!/orders\.routes|coupons\.routes|orderRoutes|couponRoutes/.test(api));
});

test('nenhuma página do site tem ícone/gaveta de carrinho', () => {
  for (const f of walk(path.join(ROOT, 'public')).filter((x) => x.endsWith('.html'))) {
    assert.ok(!/cartToggle|cartDrawer|cartBadge/.test(fs.readFileSync(f, 'utf8')), rel(f));
  }
});

test('página do produto tem só o botão de WhatsApp (sem comprar, sem quantidade, sem parcelamento)', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/produto.html'), 'utf8');
  assert.match(h, /id="waBtn"[\s\S]*CHAMAR NO WHATSAPP/);
  assert.ok(!/Quantidade|qtyVal|pInstallment|Pix cai na hora/.test(h));
});

test('variáveis: Supabase só por pooler e URL (sem VITE_SUPABASE_*) e nada do Mercado Pago', () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const names = env.split('\n').filter(Boolean).map((l) => l.split('=')[0]);
  assert.ok(names.includes('SUPABASE_DB_POOLER_URL') && names.includes('SUPABASE_URL'));
  assert.ok(!names.some((n) => /^VITE_|MERCADOPAGO|WEBHOOK|WHATSAPP_|CALLMEBOT|POINTS/.test(n)));
  assert.ok(!env.includes('#'), '.env.example sem comentários');
  for (const f of code) assert.ok(!/VITE_SUPABASE/.test(fs.readFileSync(f, 'utf8')), rel(f));
});

test('configurações do site: só loja, contato, SEO e aviso (sem checkout, cartão ou pontos)', () => {
  const S = require('../netlify/functions/lib/site-settings');
  assert.deepEqual(Object.keys(S.DEFAULTS).sort(), ['announcement', 'contact', 'seo', 'store']);
  const pub = S.publicView(S.sanitize({ contact: { whatsapp: '(98) 99999-9999' } }));
  assert.equal(pub.contact.whatsapp, '98999999999');
  assert.equal('checkout' in pub, false);
});

test('CSP não libera mais hosts de pagamento', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.ok(!/mercado|mlstatic|schedule/i.test(toml));
});
