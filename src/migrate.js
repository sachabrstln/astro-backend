// Migration : crée les tables de la DB (idempotent)
import 'dotenv/config';
import { pool } from './db.js';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'none',
  plan_status TEXT NOT NULL DEFAULT 'inactive',
  plan_expires_at TIMESTAMPTZ,
  trial_ultra_until TIMESTAMPTZ,
  trial_emails_sent JSONB DEFAULT '{}'::jsonb,
  referral_code TEXT UNIQUE,
  referred_by_code TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Ajouts idempotents pour anciennes installations
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_billing TEXT NOT NULL DEFAULT 'monthly';
-- v1.3.2 : trial Ultra 7 jours + parrainage
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ultra_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_emails_sent JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code TEXT;
CREATE INDEX IF NOT EXISTS idx_users_trial_ultra ON users(trial_ultra_until) WHERE trial_ultra_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- Table referrals : parrainage v1.3.2
CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referrer_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  referee_signup_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  referee_paid_at TIMESTAMPTZ,
  parrain_ultra_days_credited INTEGER DEFAULT 0,
  parrain_commission_active BOOLEAN DEFAULT FALSE,
  parrain_commission_starts_at TIMESTAMPTZ,
  parrain_commission_ends_at TIMESTAMPTZ,
  parrain_commission_total_eur NUMERIC(10,2) DEFAULT 0,
  filleul_trial_used BOOLEAN DEFAULT FALSE,
  filleul_first_month_discount_pct INTEGER DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(referee_user_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- Table cancellation_feedback : analytics churn
CREATE TABLE IF NOT EXISTS cancellation_feedback (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  comment TEXT,
  accepted_offer TEXT,
  plan TEXT,
  compte_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cancel_reason ON cancellation_feedback(reason);

-- Table trial_events : tracking lifecycle trial
CREATE TABLE IF NOT EXISTS trial_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS ai_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  cost_usd NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_month ON ai_usage(user_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id SERIAL PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessions (JWT jti + révocation)
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti TEXT UNIQUE NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_jti ON sessions(jti);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- v1.3.4 (#3) : sessions actives uniquement (perf + cleanup)
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(jti) WHERE revoked_at IS NULL;
-- Idempotent ALTER pour DBs déjà migrées
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- Vérification email
CREATE TABLE IF NOT EXISTS email_verifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id);

-- Reset de mot de passe
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pwd_reset_user ON password_resets(user_id);

-- Audit log (sensitive actions)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Products : inventaire des articles du vendeur (ce qu'il possède physiquement)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vinted_account_id TEXT,              -- rattachement compte Vinted si multi-comptes
  title TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  size TEXT,
  condition TEXT,                       -- très bon état / neuf / etc.
  buy_price DECIMAL(10,2),              -- prix d'achat initial
  buy_date DATE,
  buy_source TEXT,                      -- friperie / vide-grenier / particulier
  notes TEXT,
  photos JSONB,                         -- array d'URLs
  status TEXT DEFAULT 'inventory',      -- inventory / listed / sold / archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_account ON products(vinted_account_id);

-- Listings : annonces actives sur Vinted (liées à un product si suivi)
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  vinted_account_id TEXT,
  vinted_item_id TEXT NOT NULL,         -- ID de l'annonce Vinted
  title TEXT,
  sell_price DECIMAL(10,2),
  views_count INTEGER DEFAULT 0,
  likes_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',         -- active / republished / sold / deleted
  posted_at TIMESTAMPTZ,
  last_republished_at TIMESTAMPTZ,
  sold_at TIMESTAMPTZ,
  raw JSONB,                            -- dump complet de l'API Vinted pour référence
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, vinted_item_id)
);
CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_product ON listings(product_id);
CREATE INDEX IF NOT EXISTS idx_listings_vinted ON listings(vinted_item_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);

-- Sales : ventes finalisées (utilisé pour analytics, ROI, compta)
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  vinted_account_id TEXT,
  vinted_item_id TEXT,
  vinted_transaction_id TEXT,
  article_title TEXT,
  brand TEXT,
  category TEXT,
  sale_price DECIMAL(10,2) NOT NULL,
  buy_price DECIMAL(10,2),
  fees_vinted DECIMAL(10,2),
  fees_shipping DECIMAL(10,2),
  net_margin_eur DECIMAL(10,2),         -- bénéfice net en €
  net_margin_pct DECIMAL(5,2),          -- marge en %
  country TEXT,                          -- ISO country code (FR, BE, etc.)
  buyer_login TEXT,
  sold_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, vinted_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_soldat ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_category ON sales(category);

-- Market snapshots : stats marché Vinted (trending détection, pricing intelligent)
-- Snapshotted périodiquement par un cron backend
CREATE TABLE IF NOT EXISTS market_snapshots (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  brand TEXT,
  size TEXT,
  condition TEXT,
  price_median DECIMAL(10,2),
  price_p25 DECIMAL(10,2),
  price_p75 DECIMAL(10,2),
  sample_count INTEGER,                 -- nombre d'items analysés pour ce snapshot
  trending_score DECIMAL(5,2),          -- score de trending 0-100 basé sur vélocité
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_market_cat ON market_snapshots(category);
CREATE INDEX IF NOT EXISTS idx_market_captured ON market_snapshots(captured_at);
`;

async function migrate() {
  try {
    await pool.query(SQL);
    console.log('✓ Schéma de base OK');

    // v1.3.750 FIX LANCEMENT : applique aussi les migrations/*.sql (dans l'ordre trié).
    // Avant, migrate.js n'exécutait QUE le SQL inline ci-dessus → les tables/colonnes
    // ajoutées après coup (pack_credits, trial_history, target_plan/target_billing,
    // card_fingerprint, colonnes Stripe Connect, crédits fractionnaires) n'existaient
    // JAMAIS sur une DB fraîche → trial/packs/parrainage/Connect crashaient en 500.
    // Tous ces fichiers sont idempotents (IF NOT EXISTS), donc rejouables sur la prod.
    let files = [];
    try {
      files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    } catch (e) {
      console.warn('⚠ Dossier migrations/ introuvable (' + e.message + ') — SQL inline seul appliqué');
    }
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      try {
        await pool.query(sql);
        console.log('✓ migration ' + f);
      } catch (e) {
        console.error('✗ migration ' + f + ' échouée: ' + e.message);
        process.exit(1);
      }
    }

    console.log('✓ Migration terminée (' + files.length + ' fichier(s) migrations/ appliqué(s))');
    process.exit(0);
  } catch (e) {
    console.error('✗ Migration échouée:', e.message);
    process.exit(1);
  }
}

migrate();
