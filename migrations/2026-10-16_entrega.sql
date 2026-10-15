-- Entrega e endereço no pedido — migração aditiva e idempotente.
-- Também é aplicada automaticamente por netlify/functions/lib/db.js na primeira requisição.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method TEXT;        -- motoboy (a combinar via WhatsApp) | pickup (antigos: motoboy_free | motoboy_paid | sedex | uber99)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_label TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_amount NUMERIC(12,2) NOT NULL DEFAULT 0;  -- já somado em amount
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_cep TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_street TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_complement TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_neighborhood TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_city TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_state TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepts_marketing INTEGER NOT NULL DEFAULT 0;
