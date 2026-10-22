'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { storageRegex, collectPaths, rewriteValue } = require('../scripts/migrar-supabase.js');

const OLD = 'https://aaaa.supabase.co';
const NEW = 'https://bbbb.supabase.co/';
const f1 = `${OLD}/storage/v1/object/public/rshoes-images/rshoes/1-a.webp`;
const f2 = `${OLD}/storage/v1/object/public/rshoes-images/rshoes/2-b.jpg`;
const fb = `${OLD}/storage/v1/object/public/rshoes-feedbacks/3-c.mp4`;

test('migração: acha as fotos antigas em JSON e texto simples', () => {
  const found = new Set();
  const re = storageRegex(OLD);
  collectPaths(JSON.stringify([f1, f2, 'assets/local.jpg', 'https://outro.supabase.co/storage/v1/object/public/x/y.jpg']), re, found);
  collectPaths(fb, re, found);
  collectPaths(null, re, found);
  collectPaths(42, re, found);
  assert.deepEqual([...found].sort(), [
    'rshoes-feedbacks/3-c.mp4', 'rshoes-images/rshoes/1-a.webp', 'rshoes-images/rshoes/2-b.jpg',
  ]);
});

test('migração: troca só os links das fotos copiadas; as que falharam ficam como estavam', () => {
  const re = storageRegex(OLD);
  const ok = new Set(['rshoes-images/rshoes/1-a.webp']);
  const input = JSON.stringify([f1, f2]);
  const out = JSON.parse(rewriteValue(input, re, NEW, ok));
  assert.equal(out[0], 'https://bbbb.supabase.co/storage/v1/object/public/rshoes-images/rshoes/1-a.webp');
  assert.equal(out[1], f2);
  assert.equal(rewriteValue(7, re, NEW, ok), 7);
  assert.equal(rewriteValue('sem foto', re, NEW, ok), 'sem foto');
});

test('migração: o script não depende do pacote pg ao ser importado', () => {
  assert.equal(typeof storageRegex, 'function');
});
