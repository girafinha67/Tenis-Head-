-- Categoria Puma (bolinha da home e filtro do catálogo) — migração aditiva e idempotente.
-- Também é aplicada automaticamente por netlify/functions/lib/db.js na primeira requisição.
INSERT INTO categories (name, slug, image, description, order_index, active)
SELECT 'Puma', 'puma', '/assets/categories/puma.jpg', 'Performance e estilo de rua.',
       COALESCE((SELECT MAX(order_index) FROM categories), 0) + 1, 1
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'puma');
