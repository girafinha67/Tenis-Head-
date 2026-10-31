-- Tamanhos esgotados por produto — migração aditiva e idempotente.
-- Também é aplicada automaticamente por netlify/functions/lib/db.js na primeira requisição.
-- products.sizes continua sendo a lista de tamanhos DISPONÍVEIS; esta coluna guarda os ESGOTADOS
-- (numerações que a loja trabalha/consegue por encomenda, mas não tem à pronta entrega).
ALTER TABLE products ADD COLUMN IF NOT EXISTS sold_out_sizes TEXT NOT NULL DEFAULT '[]';
