-- v1.3.8 — Parrainage v2 + Trial Ultra-pour-tous + Stripe Connect Express
-- À runner sur Supabase Production avant déploiement backend v1.3.8.
--
-- Ce qui change :
-- 1. users.target_plan/target_billing : le plan qui s'active après les 7j de trial Ultra
-- 2. users.stripe_connect_account_id + connect_onboarding_complete : pour payouts auto
-- 3. users.cagnotte_balance_cents + cagnotte_lifetime_cents : montant disponible/total gagné
-- 4. referrals.commission_paid_count : combien de mois de commission ont déjà été payés (0-4)
-- 5. referrals.parrain_commission_total_cents : commission cumulée (en centimes pour éviter les floats)
-- 6. table payouts : traçabilité des retraits Stripe Transfer
-- 7. referrals.filleul_first_month_discount_pct → default 15 (avant : 20)
-- 8. users.referral_code : on lève la contrainte auto-génération, l'user choisit son code

-- ── 1. USERS : trial flow + Connect + cagnotte ────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS target_plan VARCHAR(20),
  ADD COLUMN IF NOT EXISTS target_billing VARCHAR(20) DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS connect_onboarding_complete BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cagnotte_balance_cents INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cagnotte_lifetime_cents INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referral_code_chosen_at TIMESTAMPTZ;

-- Index pour lookup Connect
CREATE INDEX IF NOT EXISTS idx_users_connect_account ON users(stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- ── 2. REFERRALS : tracking précis des commissions payées ─────
ALTER TABLE referrals
  ADD COLUMN IF NOT EXISTS commission_paid_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parrain_commission_total_cents INT DEFAULT 0;

-- Mise à jour du discount par défaut (15% au lieu de 20% pour préserver la marge)
ALTER TABLE referrals
  ALTER COLUMN filleul_first_month_discount_pct SET DEFAULT 15;

-- ── 3. PAYOUTS : retraits Stripe Connect ─────────────────────
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  stripe_transfer_id VARCHAR(80),
  stripe_payout_id VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | succeeded | failed | reversed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at TIMESTAMPTZ,
  failed_reason TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts(user_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_transfer ON payouts(stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;

-- ── 4. AUDIT_LOG (si pas déjà créée) pour traçabilité parrainage ─
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
