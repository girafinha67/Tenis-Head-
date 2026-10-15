-- Cupons de desconto — migração aditiva e idempotente. O app já aplica isto sozinho (db.init);
-- use só se preferir rodar manualmente no SQL Editor do Supabase. Não altera dados existentes.

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL,                       -- só letras e números, guardado em MAIÚSCULAS
  description TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percent',   -- percent | fixed
  discount_value NUMERIC(12,2) NOT NULL,
  max_discount NUMERIC(12,2),               -- teto do desconto (cupom percentual)
  min_order NUMERIC(12,2) NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  usage_limit INTEGER,                      -- usos totais (NULL = ilimitado)
  per_customer_limit INTEGER,               -- usos por cliente (CPF/e-mail)
  used_count INTEGER NOT NULL DEFAULT 0,
  first_purchase_only INTEGER NOT NULL DEFAULT 0,
  allow_on_promo INTEGER NOT NULL DEFAULT 1,
  applies_to TEXT NOT NULL DEFAULT 'all',   -- all | products | categories
  product_ids TEXT NOT NULL DEFAULT '[]',
  category_slugs TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupons_code ON coupons(UPPER(code));

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id SERIAL PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  customer_cpf TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  discount_amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'RESERVED',  -- RESERVED | REDEEMED | RELEASED
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_redemptions_order ON coupon_redemptions(order_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id, status);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(12,2);
