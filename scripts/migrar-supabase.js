#!/usr/bin/env node
'use strict';

/* Migra a loja de um Supabase para outro (ou para qualquer Postgres + um Supabase só para as fotos).
   Copia produtos, categorias, configurações, depoimentos, cupons e pedidos, baixa cada foto
   do Supabase antigo, envia para o novo e troca os links no banco novo.

   Uso (veja o passo a passo no README, seção "Migrar para outra conta do Supabase"):
     node scripts/migrar-supabase.js --simular      só mostra o que seria copiado, não altera nada
     node scripts/migrar-supabase.js                copia tudo (o destino precisa estar vazio de produtos)
     node scripts/migrar-supabase.js --substituir   apaga produtos/categorias do destino antes de copiar
     node scripts/migrar-supabase.js --analytics    inclui também o histórico do Analytics (pode ser grande)

   As variáveis podem ficar num arquivo .env.migracao (CHAVE=valor, uma por linha) na pasta do projeto.

   Variáveis de ambiente (use a connection string do "Session pooler", porta 5432, no Supabase):
     OLD_DB_URL                    banco antigo
     OLD_SUPABASE_URL              https://xxxx.supabase.co (projeto antigo)
     NEW_DB_URL                    banco novo
     NEW_SUPABASE_URL              https://yyyy.supabase.co (projeto novo)
     NEW_SUPABASE_SERVICE_ROLE_KEY chave service_role do projeto novo
     ADMIN_EMAIL, ADMIN_PASSWORD   login do painel no banco novo (como no deploy) */

// `pg` só é carregado ao rodar de verdade (os testes usam só as funções puras abaixo).
let pg = null;

// Ordem respeita as chaves estrangeiras.
const TABLES = [
  'categories', 'products', 'settings', 'feedbacks', 'coupons',
  'orders', 'order_items', 'payment_webhook_events', 'payment_notifications', 'coupon_redemptions',
];
const ANALYTICS_TABLES = ['analytics_visitors', 'analytics_sessions', 'analytics_events'];

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

// Parte "bucket/caminho" depois de /storage/v1/object/public/ (termina em aspas, espaço, \ ou ")" ).
function storageRegex(baseUrl) {
  return new RegExp(escapeRe(trimSlash(baseUrl)) + '/storage/v1/object/public/([^"\'\\s\\\\)<>]+)', 'g');
}

function collectPaths(value, re, found) {
  if (typeof value !== 'string') return;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(value))) found.add(m[1]);
}

// Troca os links das fotos copiadas com sucesso; as que falharam ficam com o link antigo.
function rewriteValue(value, re, newBase, okPaths) {
  if (typeof value !== 'string') return value;
  re.lastIndex = 0;
  return value.replace(re, (whole, rest) =>
    okPaths.has(rest) ? `${trimSlash(newBase)}/storage/v1/object/public/${rest}` : whole);
}

function makePool(url) {
  if (!pg) {
    pg = require('pg');
    // DATE volta como texto (evita o dia mudar por fuso ao copiar).
    pg.types.setTypeParser(1082, (v) => v);
  }
  return new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    max: 2,
  });
}

async function columnsOf(pool, table) {
  const { rows } = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function copyPhoto(rest, cfg) {
  const slash = rest.indexOf('/');
  if (slash < 1) throw new Error('caminho inválido');
  const bucket = rest.slice(0, slash);
  const from = `${trimSlash(cfg.oldSupabaseUrl)}/storage/v1/object/public/${rest}`;
  const res = await fetch(from);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const body = Buffer.from(await res.arrayBuffer());

  const up = await fetch(`${trimSlash(cfg.newSupabaseUrl)}/storage/v1/object/${rest}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.newKey}`,
      apikey: cfg.newKey,
      'Content-Type': type,
      'Cache-Control': '31536000',
      'x-upsert': 'true',
    },
    body,
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 120)}`);
  return { bucket, bytes: body.length };
}

async function ensureBucket(id, cfg) {
  const res = await fetch(`${trimSlash(cfg.newSupabaseUrl)}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.newKey}`, apikey: cfg.newKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: id, public: true }),
  });
  // 200 = criado; 400/409 = já existe.
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    throw new Error(`não consegui criar o bucket ${id}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
}

async function runPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// Lê um arquivo .env.migracao (linhas CHAVE=valor) se existir na pasta onde o comando é rodado.
function loadEnvFile(file) {
  const fs = require('node:fs');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}

async function main() {
  loadEnvFile('.env.migracao');
  const args = new Set(process.argv.slice(2));
  const simular = args.has('--simular');
  const substituir = args.has('--substituir');
  const env = process.env;

  const need = ['OLD_DB_URL', 'OLD_SUPABASE_URL'];
  if (!simular) need.push('NEW_DB_URL', 'NEW_SUPABASE_URL', 'NEW_SUPABASE_SERVICE_ROLE_KEY');
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    console.error('Faltam variáveis de ambiente: ' + missing.join(', ') + '\nVeja o topo deste arquivo ou o README.');
    process.exit(1);
  }
  const cfg = {
    oldSupabaseUrl: env.OLD_SUPABASE_URL, newSupabaseUrl: env.NEW_SUPABASE_URL, newKey: env.NEW_SUPABASE_SERVICE_ROLE_KEY,
  };
  if (!simular && trimSlash(env.OLD_DB_URL) === trimSlash(env.NEW_DB_URL)) {
    console.error('OLD_DB_URL e NEW_DB_URL são iguais. Confira as variáveis.');
    process.exit(1);
  }

  const tables = args.has('--analytics') ? TABLES.concat(ANALYTICS_TABLES) : TABLES;
  const oldPool = makePool(env.OLD_DB_URL);

  // 1) Lê tudo do banco antigo.
  console.log('Lendo o banco antigo...');
  const data = {};
  for (const t of tables) {
    const cols = await columnsOf(oldPool, t);
    if (!cols.length) { console.log(`  ${t}: não existe na origem, pulando`); continue; }
    const { rows } = await oldPool.query(`SELECT ${cols.map(q).join(', ')} FROM ${q(t)}`);
    data[t] = { cols, rows };
    console.log(`  ${t}: ${rows.length} linha(s)`);
  }

  // 2) Descobre as fotos do Supabase antigo usadas em qualquer texto.
  const re = storageRegex(cfg.oldSupabaseUrl);
  const found = new Set();
  for (const t of Object.keys(data)) {
    for (const row of data[t].rows) for (const v of Object.values(row)) collectPaths(v, re, found);
  }
  const photos = [...found];
  console.log(`\nFotos/arquivos para copiar: ${photos.length}`);

  if (simular) {
    console.log('\nModo --simular: nada foi alterado. Rode sem --simular para migrar de verdade.');
    await oldPool.end();
    return;
  }

  // 3) Prepara o banco novo (cria as tabelas do mesmo jeito que o site faz).
  console.log('\nPreparando o banco novo...');
  process.env.DATABASE_URL = env.NEW_DB_URL;
  delete process.env.SUPABASE_DB_POOLER_URL;
  delete process.env.DB_SCHEMA;
  const db = require('../netlify/functions/lib/db');
  await db.init();
  const dst = db.pool;

  const existing = Number((await dst.query('SELECT COUNT(*) AS n FROM products')).rows[0].n);
  if (existing > 0 && !substituir) {
    console.error(`O banco novo já tem ${existing} produto(s). Para apagar e copiar de novo, rode com --substituir.`);
    process.exit(1);
  }

  // 4) Copia as fotos (4 por vez) e guarda quais deram certo.
  const buckets = new Set(photos.map((p) => p.slice(0, p.indexOf('/'))));
  for (const b of buckets) await ensureBucket(b, cfg);
  const ok = new Set();
  const failed = [];
  let bytes = 0;
  await runPool(photos, 4, async (rest, i) => {
    try {
      const r = await copyPhoto(rest, cfg);
      ok.add(rest);
      bytes += r.bytes;
    } catch (err) {
      failed.push({ rest, error: err.message });
    }
    if ((i + 1) % 10 === 0 || i + 1 === photos.length) console.log(`  fotos: ${i + 1}/${photos.length}`);
  });
  console.log(`  copiadas: ${ok.size} (${(bytes / 1048576).toFixed(1)} MB) | falharam: ${failed.length}`);

  // 5) Copia as linhas para o banco novo trocando os links das fotos.
  console.log('\nCopiando os dados para o banco novo...');
  const client = await dst.connect();
  try {
    await client.query('BEGIN');
    const present = [...tables].reverse().filter((t) => data[t]);
    // limpa o destino (inclui o que o site criou sozinho ao iniciar) antes de copiar
    await client.query(`TRUNCATE ${present.map(q).join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of tables) {
      if (!data[t]) continue;
      const newCols = await columnsOf(client, t);
      const cols = data[t].cols.filter((c) => newCols.includes(c));
      const rows = data[t].rows;
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const params = [];
        const tuples = chunk.map((row) => '(' + cols.map((c) => {
          params.push(rewriteValue(row[c], re, cfg.newSupabaseUrl, ok));
          return '$' + params.length;
        }).join(', ') + ')');
        await client.query(`INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}`, params);
      }
      if (cols.includes('id')) {
        const seq = (await client.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [q(t)])).rows[0].s;
        if (seq) await client.query(`SELECT setval($1, (SELECT COALESCE(MAX(id), 0) + 1 FROM ${q(t)}), false)`, [seq]);
      }
      console.log(`  ${t}: ${rows.length} linha(s)`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('\nPronto.');
  if (failed.length) {
    console.log(`\n${failed.length} foto(s) não foram copiadas e continuam com o link do Supabase antigo:`);
    failed.slice(0, 20).forEach((f) => console.log(`  - ${f.rest} (${f.error})`));
    console.log('Reenvie essas fotos pelo painel (Produtos) ou rode o script de novo com --substituir.');
  }
  await oldPool.end();
  await dst.end();
}

if (require.main === module) {
  main().catch((err) => { console.error('\nErro:', err.message); process.exit(1); });
}

module.exports = { storageRegex, collectPaths, rewriteValue };
