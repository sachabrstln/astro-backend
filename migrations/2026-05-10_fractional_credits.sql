-- ════════════════════════════════════════════════════════════════
-- v1.3.10 — Crédits fractionnaires pour Mode Studio
-- ════════════════════════════════════════════════════════════════
-- Le Mode Studio (relight IC-Light) coûte 1.5 crédit par annonce
-- au lieu de 1 pour le mode Standard.
-- On migre `pack_credits.remaining` de INTEGER vers NUMERIC(10,2)
-- pour permettre les décréments fractionnaires.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE pack_credits
  ALTER COLUMN remaining TYPE NUMERIC(10, 2) USING remaining::NUMERIC(10, 2);

-- pack_size reste INTEGER (toujours un nombre entier d'annonces à l'achat)
-- Les remaining peuvent partir de 10.00, 25.00, etc et descendre par paliers
-- de 1.00 (Standard) ou 1.50 (Studio).

-- Vérification : la requête WHERE remaining > 0 fonctionne toujours sur NUMERIC.
-- Les UPDATE remaining = remaining - $cost passent aussi (cost = 1 ou 1.5).

-- Optionnel : index sur (user_id, expires_at) pour la query FIFO du claim
-- (déjà couvert par les index existants normalement).

-- Note : aucune perte de données. Tous les remaining existants (10, 25, 75)
-- seront castés en 10.00, 25.00, 75.00.
