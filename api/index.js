'use strict';

// Entrada da Vercel: reaproveita exatamente o mesmo app Express do Netlify
// (netlify/functions/api.js), sem duplicar nenhuma rota ou regra de negócio.
//
// O vercel.json manda /api/* e /p/:slug para esta função. A Vercel pode entregar
// a URL original ou a reescrita, então aceitamos os dois formatos:
//   - /api/<rota>            -> o Express já monta as rotas em /api
//   - /p/<slug>              -> vira /api/share/<slug> (cartão de compartilhamento)
//   - /api?__p=<rota>&...    -> vira /api/<rota>?... (formato reescrito)
const { app } = require('../netlify/functions/api');

module.exports = (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    const p = u.searchParams.get('__p');
    if (p !== null) {
      u.searchParams.delete('__p');
      const rest = u.searchParams.toString();
      req.url = '/api/' + p.replace(/^\/+/, '') + (rest ? '?' + rest : '');
    } else {
      const m = /^\/p\/([^/?#]+)/.exec(u.pathname);
      if (m) req.url = '/api/share/' + m[1] + u.search;
    }
  } catch (err) {
    // URL inesperada: deixa o Express tratar (cai no 404 da API).
  }
  return app(req, res);
};
