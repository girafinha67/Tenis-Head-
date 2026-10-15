-- Mercado Pago (PIX) — migração aditiva e idempotente (pode ser executada mais de uma vez).
-- Também é aplicada automaticamente por netlify/functions/lib/db.js na primeira requisição.
-- Se o banco já tinha as colunas promisse_* (provedor anterior), elas são renomeadas sem perder dados.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='promisse_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='mp_id') THEN
    ALTER TABLE orders RENAME COLUMN promisse_id TO mp_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='promisse_status')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='mp_status') THEN
    ALTER TABLE orders RENAME COLUMN promisse_status TO mp_status;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='promisse_fee')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='mp_fee') THEN
    ALTER TABLE orders RENAME COLUMN promisse_fee TO mp_fee;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='promisse_checked_at')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='mp_checked_at') THEN
    ALTER TABLE orders RENAME COLUMN promisse_checked_at TO mp_checked_at;
  END IF;
END $$;

DROP INDEX IF EXISTS uq_orders_promisse_id;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_id TEXT;             -- id do pagamento no Mercado Pago
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_status TEXT;         -- último status visto no gateway
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_fee INTEGER;         -- taxa (centavos), quando informada
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_checked_at TIMESTAMPTZ;  -- throttle da consulta ao gateway
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_mp_id ON orders(mp_id) WHERE mp_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_checkout_token ON orders(checkout_token) WHERE checkout_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_provider_status ON orders(payment_provider, status);
