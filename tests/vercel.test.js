'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

test('vercel.json é JSON válido e aponta a pasta public', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(cfg.outputDirectory, 'public');
  const sources = cfg.rewrites.map((r) => r.source);
  assert.ok(sources.includes('/api/:path*'));
  assert.ok(sources.includes('/p/:slug'));
});

test('api/index.js traduz as URLs da Vercel para as rotas do Express', () => {
  const seen = [];
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '../netlify/functions/api') return { app: (req) => seen.push(req.url) };
    return realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../api/index.js')];
    const handler = require('../api/index.js');
    handler({ url: '/api/products?sort=recent' }, {});
    handler({ url: '/p/tenis-x?i=2' }, {});
    handler({ url: '/api?__p=admin%2Fproducts&page=2' }, {});
    handler({ url: '/api?__p=share/tenis-y' }, {});
  } finally {
    Module._load = realLoad;
  }
  assert.deepEqual(seen, ['/api/products?sort=recent', '/api/share/tenis-x?i=2', '/api/admin/products?page=2', '/api/share/tenis-y']);
});

test('Vercel Web Analytics: páginas públicas carregam, o /admin não', () => {
  const pub = ['index', 'catalogo', 'produto', 'favoritos'];
  for (const p of pub) {
    const html = fs.readFileSync(path.join(ROOT, 'public', p + '.html'), 'utf8');
    assert.ok(html.includes('js/vercel-analytics.js'), p + ' deveria carregar o Web Analytics');
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'public', 'admin'))) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'admin', f), 'utf8');
    assert.ok(!html.includes('vercel-analytics'), 'admin/' + f + ' não deve carregar o Web Analytics');
  }
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'vercel-analytics.js'), 'utf8');
  assert.ok(js.includes('/_vercel/insights/script.js'));
});

test('img-opt: fotos do Supabase passam pelo /_vercel/image; o resto fica igual', () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'img-opt.js'), 'utf8');
  const run = (hostname) => {
    const win = {};
    vm.runInNewContext(code, { window: win, location: { hostname, protocol: 'https:' }, document: { addEventListener() {} } });
    return win.thImg;
  };
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const foto = 'https://abc.supabase.co/storage/v1/object/public/p/1-a.jpg';

  const prod = run('tenishead.com.br');
  const out = prod(foto, 600);
  assert.equal(out, '/_vercel/image?url=' + encodeURIComponent(foto) + '&w=640&q=75');
  const w = Number(/w=(\d+)/.exec(prod(foto, 3000))[1]);
  assert.ok(cfg.images.sizes.includes(w), 'largura precisa estar em vercel.json > images.sizes');
  assert.equal(prod('assets/hero/x.jpg', 640), 'assets/hero/x.jpg');
  assert.equal(prod(null, 640), null);

  assert.equal(run('localhost')(foto, 640), foto);
  assert.equal(run('loja.netlify.app')(foto, 640), foto);
});
