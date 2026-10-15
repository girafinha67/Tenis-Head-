-- Pagamento com cartão (crédito/débito) — migração aditiva e idempotente.
-- Também é aplicada automaticamente por netlify/functions/lib/db.js na primeira requisição.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;          -- pix | credit_card | debit_card
ALTER TABLE orders ADD COLUMN IF NOT EXISTS installments INTEGER;         -- nº de parcelas (cartão)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS interest_amount NUMERIC(12,2) NOT NULL DEFAULT 0;  -- acréscimo do parcelamento (R$), já somado em amount
ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_brand TEXT;              -- visa, master, elo...
ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_last4 TEXT;              -- final do cartão
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_status_detail TEXT;        -- status_detail do Mercado Pago (motivo da recusa etc.)
