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
