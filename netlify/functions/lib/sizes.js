'use strict';

// Tamanhos do produto: "disponíveis" (products.sizes, como sempre foi) e "esgotados" (products.sold_out_sizes).
// Funções puras (sem banco/rede) para poder testar. Produtos antigos não têm esgotados: lista vazia.

// Aceita lista ou texto "34, 35, 36"; tira espaços/controle, descarta vazios e repetidos (mantém a ordem digitada).
function normalizeSizeList(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const s = String(item == null ? '' : item).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Tamanhos que aparecem nas duas listas ao mesmo tempo (comparação sem diferenciar maiúscula/minúscula).
function findConflicts(available, soldOut) {
  const a = new Set(normalizeSizeList(available).map((s) => s.toLowerCase()));
  return normalizeSizeList(soldOut).filter((s) => a.has(s.toLowerCase()));
}

// Mensagem de erro para o admin (ou null quando está tudo certo).
function conflictMessage(available, soldOut) {
  const c = findConflicts(available, soldOut);
  if (!c.length) return null;
  return c.length === 1
    ? `O tamanho ${c[0]} não pode estar em "Tamanhos disponíveis" e em "Tamanhos esgotados" ao mesmo tempo.`
    : `Os tamanhos ${c.join(', ')} não podem estar em "Tamanhos disponíveis" e em "Tamanhos esgotados" ao mesmo tempo.`;
}

// Lê a coluna JSON (null/vazia/inválida → []). Produtos criados antes da coluna existir continuam funcionando.
function parseStoredList(raw) {
  if (Array.isArray(raw)) return normalizeSizeList(raw);
  try { return normalizeSizeList(JSON.parse(raw || '[]')); } catch { return []; }
}

module.exports = { normalizeSizeList, findConflicts, conflictMessage, parseStoredList };
