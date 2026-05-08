-- ═══════════════════════════════════════════════════════════
-- v1.3.7 — Sécurité paiement + Support
-- - trial_history : anti-fraude carte (1 seul trial par carte/email/IP)
-- - support_messages : tickets contact
-- - support_bugs : rapports de bug
-- - users.card_fingerprint : empreinte carte Stripe (pour matching)
-- ═══════════════════════════════════════════════════════════

-- 1. Empreinte CB sur users (alimentée au 1er payment_method.attached)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS card_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS signup_ip TEXT;

CREATE INDEX IF NOT EXISTS idx_users_card_fingerprint ON users(card_fingerprint)
  WHERE card_fingerprint IS NOT NULL;

-- 2. trial_history : empêche un user de re-faire un trial via nouvel email
-- On stocke email_hash + card_fingerprint + IP. Tout match = fraude.
CREATE TABLE IF NOT EXISTS trial_history (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email_hash TEXT NOT NULL,           -- sha256 de l'email (anti-PII)
  card_fingerprint TEXT,              -- empreinte stripe pm.card.fingerprint
  ip_address TEXT,
  trial_start TIMESTAMPTZ DEFAULT NOW(),
  trial_end TIMESTAMPTZ,
  outcome TEXT,                        -- 'converted' | 'cancelled' | 'expired' | 'fraud_blocked'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trial_history_email ON trial_history(email_hash);
CREATE INDEX IF NOT EXISTS idx_trial_history_card ON trial_history(card_fingerprint)
  WHERE card_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trial_history_ip ON trial_history(ip_address);

-- 3. support_messages : tickets contact (table simple, on traite manuellement)
CREATE TABLE IF NOT EXISTS support_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',          -- open | replied | closed
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_messages_user ON support_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_status ON support_messages(status);

-- 4. support_bugs : rapports de bug (avec metadata debug)
CREATE TABLE IF NOT EXISTS support_bugs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  meta JSONB DEFAULT '{}',             -- { userAgent, extVersion, plan, url, ... }
  status TEXT DEFAULT 'new',           -- new | investigating | fixed | wontfix
  priority TEXT DEFAULT 'normal',      -- low | normal | high | critical
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_bugs_status ON support_bugs(status);
CREATE INDEX IF NOT EXISTS idx_support_bugs_user ON support_bugs(user_id);
