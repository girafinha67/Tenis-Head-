'use strict';

// Marcas com categoria própria na home. Cada marca aceita variações de escrita
// (ex.: "ON", "On Cloud", "On Running"), então um tênis cadastrado ANTES da
// categoria existir já entra nela e no filtro de marca, sem precisar editar nada.
const BRAND_GROUPS = [
  { slug: 'lacoste', name: 'Lacoste', exact: ['lacoste'], like: ['lacoste%'] },
  { slug: 'on-cloud', name: 'ON Cloud', exact: ['on', 'on cloud', 'oncloud', 'on running', 'onrunning'], like: ['on cloud%', 'oncloud%'] },
  { slug: 'hugo-boss', name: 'Hugo Boss', exact: ['boss', 'hugo boss', 'hugoboss'], like: ['%hugo boss%', 'boss %'] },
];

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

function groupByBrandName(brand) {
  const n = norm(brand);
  if (!n) return null;
  return (
    BRAND_GROUPS.find(
      (g) => n === norm(g.name) || g.exact.includes(n) || g.like.some((p) => new RegExp('^' + p.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(n))
    ) || null
  );
}

function groupBySlug(slug) {
  return BRAND_GROUPS.find((g) => g.slug === slug) || null;
}

// Cláusula SQL (com placeholders ?) + parâmetros para casar a coluna `brand` com o grupo.
function brandClause(group, column = 'brand') {
  const parts = [];
  const params = [];
  if (group.exact.length) {
    parts.push(`LOWER(TRIM(${column})) IN (${group.exact.map(() => '?').join(',')})`);
    params.push(...group.exact);
  }
  group.like.forEach((p) => {
    parts.push(`LOWER(${column}) LIKE ?`);
    params.push(p);
  });
  return { sql: `(${parts.join(' OR ')})`, params };
}

// Lista de marcas para o filtro do catálogo, sem duplicar variações ("ON" + "On Cloud").
function canonicalBrandList(brands) {
  const seen = new Set();
  const out = [];
  brands.forEach((b) => {
    const g = groupByBrandName(b);
    const label = g ? g.name : String(b).trim();
    const key = norm(label);
    if (!label || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  });
  return out.sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

module.exports = { BRAND_GROUPS, groupByBrandName, groupBySlug, brandClause, canonicalBrandList, escapeLike };
