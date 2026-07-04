-- ─────────────────────────────────────────────────────────────────────────
-- SÉCURITÉ (critique) — RLS + lockdown des rôles publics sur le schema public.
--
-- Contexte : le RLS était désactivé sur les 20 tables de public ET les rôles
-- anon/authenticated (joignables via l'API PostgREST de Supabase + la clé anon,
-- considérée "publiable") avaient TOUS les droits (SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE) sur users, sessions, password_resets, email_verifications, payouts,
-- referrals, etc. → lecture de tous les comptes, vol de sessions/tokens de reset
-- (prise de compte), altération des paiements. Corrigé le 2026-07-04.
--
-- Pourquoi ça n'impacte pas le backend : il se connecte en rôle `postgres`
-- (rolbypassrls = true) et n'utilise JAMAIS l'API Data (PostgREST). Le deny-all
-- ne s'applique qu'à anon/authenticated. Idempotent & rejouable.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Active le RLS sur toutes les tables du schema public (aucune policy = deny-all
--    pour anon/authenticated ; postgres/service_role bypassent le RLS).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
  END LOOP;
END $$;

-- 2) Défense en profondeur : retire tout privilège aux rôles publics (couvre aussi
--    TRUNCATE, qui n'est PAS filtré par le RLS). Rien dans Astro n'utilise ces rôles.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- 3) Empêche les GRANT automatiques sur les futurs objets créés dans public.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
