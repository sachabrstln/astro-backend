-- ════════════════════════════════════════════════════════════════
-- Multipost IA — packs de crédits one-time (v1.3.7)
-- ════════════════════════════════════════════════════════════════
-- Le user achète des packs (10 / 25 / 75 copies) via Stripe Checkout.
-- À chaque utilisation Multipost (POST /api/ai/bg-swap pour la 1ère
-- photo d'un copier), on décompte 1 crédit.
-- Les crédits du plus vieux pack non-expiré sont consommés en priorité
-- (FIFO), pour éviter qu'un pack périme avec des crédits restants alors
-- qu'un pack récent est entamé.
-- Les packs expirent à granted_at + 12 mois.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pack_credits (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stripe checkout session qui a créé ce pack (anti-double-grant)
  stripe_session_id TEXT UNIQUE,
  stripe_price_id TEXT NOT NULL,
  -- Taille du pack (10, 25, 75) — valeur initiale
  pack_size INTEGER NOT NULL CHECK (pack_size > 0),
  -- Crédits restants (décrémenté à chaque copier Multipost utilisé)
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  -- Prix payé en centimes EUR (pour analytics / refund)
  amount_paid_cents INTEGER NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Crédits valables 12 mois après l'achat (si pas tout consommé, perdu)
  expires_at TIMESTAMPTZ NOT NULL,
  -- Pour audit / debug
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index : la requête principale est "donne-moi le pack le plus vieux
-- non-expiré avec remaining > 0 pour cet user", donc index composite.
CREATE INDEX IF NOT EXISTS idx_pack_credits_user_active
  ON pack_credits (user_id, expires_at)
  WHERE remaining > 0;

-- Anti-double-grant : si Stripe renvoie 2x le même webhook, on grant
-- 1 seule fois (UNIQUE constraint sur stripe_session_id).

-- Audit : toutes les consommations de crédits packs (pour analytics)
CREATE TABLE IF NOT EXISTS pack_credit_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_credit_id BIGINT NOT NULL REFERENCES pack_credits(id) ON DELETE CASCADE,
  -- 'bg-swap' pour l'instant, prévu pour d'autres features futures
  feature TEXT NOT NULL DEFAULT 'bg-swap',
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pack_credit_usage_user_at
  ON pack_credit_usage (user_id, used_at DESC);
