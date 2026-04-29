-- v1.3.1 — Trial Ultra 7 jours auto + Programme parrainage
-- À runner sur Supabase Production avant déploiement backend

-- 1. Trial Ultra 7 jours pour les nouveaux signups
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trial_ultra_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_emails_sent JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_users_trial_ultra ON users(trial_ultra_until)
  WHERE trial_ultra_until IS NOT NULL;

-- 2. Programme parrainage
-- Filleul : 7 jours gratuits + 20% réduc 1er mois
-- Parrain : 15 jours Ultra gratuits par filleul actif + 30% commission pendant 4 premiers mois
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referrer_code VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | active | cancelled | expired
  referee_signup_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  referee_paid_at TIMESTAMPTZ,
  -- Récompenses parrain (auto-stop si filleul résilie)
  parrain_ultra_days_credited INT DEFAULT 0,    -- 15 jours par filleul actif
  parrain_commission_active BOOLEAN DEFAULT FALSE,
  parrain_commission_starts_at TIMESTAMPTZ,
  parrain_commission_ends_at TIMESTAMPTZ,        -- 4 mois après début abo filleul
  parrain_commission_total_eur NUMERIC(10,2) DEFAULT 0,
  -- Récompense filleul
  filleul_trial_used BOOLEAN DEFAULT FALSE,
  filleul_first_month_discount_pct INT DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(referee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_code     ON referrals(referrer_code);

-- 3. Code parrain unique par user (généré au signup)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- 4. Feedback résiliation (table pour analytics churn)
CREATE TABLE IF NOT EXISTS cancellation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(50) NOT NULL,
  comment TEXT,
  accepted_offer VARCHAR(50),
  plan VARCHAR(20),
  compte_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_reason ON cancellation_feedback(reason);
CREATE INDEX IF NOT EXISTS idx_cancellation_created ON cancellation_feedback(created_at);

-- 5. Logs trial Ultra (pour reminder emails J+5/J+6)
CREATE TABLE IF NOT EXISTS trial_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event VARCHAR(50) NOT NULL,    -- trial_started | reminder_d5 | reminder_d6 | converted | expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
