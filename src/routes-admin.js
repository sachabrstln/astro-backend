// Routes admin — endpoints internes pour le dashboard ops d'Astro.
// v1.3.4 (#9) : MVP minimaliste. Auth requise + check email admin.
// Stripe est optionnel — si la lib n'est pas dispo, on retourne stripe:'unavailable'.
import { query, queryOne, pool } from './db.js';

// Liste blanche des emails admin. Hardcoded — pas dans la DB pour éviter
// qu'un compromis de la DB n'élève quelqu'un en admin sans déploiement.
// v1.3.7 : email pro Astro + perso (double accès admin)
const ADMIN_EMAILS = ['astrodashapp@gmail.com', 'sachabruas@gmail.com'];

function isAdmin(req) {
  const email = (req.user?.email || '').toLowerCase().trim();
  return !!email && ADMIN_EMAILS.includes(email);
}

export default async function adminRoutes(app) {
  // Préchecker : auth + admin
  const adminGuard = {
    onRequest: [app.authenticate, async (req, reply) => {
      if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    }],
  };

  // ── GET /admin/stats ──────────────────────────────────────
  // Vue d'ensemble business : MRR, signups, churn, abonnés actifs.
  app.get('/admin/stats', adminGuard, async (req, reply) => {
    try {
      const totalUsersRow = await queryOne(`SELECT COUNT(*)::int AS n FROM users`);
      const activeRow = await queryOne(
        `SELECT COUNT(*)::int AS n
         FROM users
         WHERE plan_status = 'active' AND plan IN ('starter','pro','ultra')`
      );
      // MRR estimé : somme des prix mensuels. On lit les abonnements actifs
      // et on map plan → prix mensuel (€). Pas le plus précis (annuels comptés mensualisés)
      // mais suffisant pour un MVP.
      const mrrRow = await queryOne(`
        SELECT
          COALESCE(SUM(CASE
            WHEN plan = 'starter' THEN 9
            WHEN plan = 'pro'     THEN 17
            WHEN plan = 'ultra'   THEN 35
            ELSE 0
          END), 0)::numeric(10,2) AS mrr
        FROM users
        WHERE plan_status = 'active'
      `);
      // Churn 30j : nb users qui ont status != active alors qu'ils étaient actifs
      // dans les 30 derniers jours. Approximé via plan_expires_at < NOW() AND > NOW() - 30j.
      const churnRow = await queryOne(`
        SELECT COUNT(*)::int AS n
        FROM users
        WHERE plan_status != 'active'
          AND plan_expires_at IS NOT NULL
          AND plan_expires_at > NOW() - INTERVAL '30 days'
          AND plan_expires_at < NOW()
      `);
      // Signups today (00h00 → maintenant)
      const signupsRow = await queryOne(`
        SELECT COUNT(*)::int AS n
        FROM users
        WHERE created_at >= date_trunc('day', NOW())
      `);

      return {
        totalUsers: totalUsersRow?.n || 0,
        activeSubscribers: activeRow?.n || 0,
        mrr: parseFloat(mrrRow?.mrr || 0),
        churn30d: churnRow?.n || 0,
        signupsToday: signupsRow?.n || 0,
        ts: new Date().toISOString(),
      };
    } catch (err) {
      req.log.error({ err }, 'admin/stats failed');
      return reply.code(500).send({ error: 'stats failed', detail: err.message });
    }
  });

  // ── GET /admin/users?limit=50&offset=0 ────────────────────
  // Liste paginée des users avec leur plan + dernier login.
  app.get('/admin/users', adminGuard, async (req, reply) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50', 10) || 50));
    const offset = Math.max(0, parseInt(req.query?.offset || '0', 10) || 0);
    try {
      const totalRow = await queryOne(`SELECT COUNT(*)::int AS n FROM users`);
      const rows = await query(
        `SELECT id, email, plan, plan_status, plan_billing, plan_expires_at,
                email_verified, created_at, stripe_customer_id
         FROM users
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const users = rows.map(u => ({
        ...u,
        // MRR estimé par user (mensuel)
        mrr: u.plan_status === 'active'
          ? (u.plan === 'starter' ? 9 : u.plan === 'pro' ? 17 : u.plan === 'ultra' ? 35 : 0)
          : 0,
      }));
      return { users, total: totalRow?.n || 0, limit, offset };
    } catch (err) {
      req.log.error({ err }, 'admin/users failed');
      return reply.code(500).send({ error: 'users failed', detail: err.message });
    }
  });

  // ── GET /admin/health ─────────────────────────────────────
  // Health check étendu : DB ping + stripe presence + node memory.
  app.get('/admin/health', adminGuard, async (req, reply) => {
    const out = {
      ts: new Date().toISOString(),
      uptime_s: Math.round(process.uptime()),
    };

    // DB ping
    try {
      const r = await queryOne(`SELECT 1 AS ok`);
      out.db = r?.ok === 1 ? 'ok' : 'unexpected';
      // Pool stats si dispo
      out.dbPool = {
        total: pool?.totalCount || 0,
        idle: pool?.idleCount || 0,
        waiting: pool?.waitingCount || 0,
      };
    } catch (err) {
      out.db = 'error';
      out.dbError = err.message;
    }

    // Stripe — check qu'on a une clé configurée (on ne fait pas un appel
    // pour économiser la latence + éviter rate-limit).
    out.stripe = process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing';

    // Node memory
    const m = process.memoryUsage();
    out.memory = {
      rss_mb: Math.round(m.rss / 1024 / 1024),
      heap_used_mb: Math.round(m.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(m.heapTotal / 1024 / 1024),
    };

    out.sentry = !!process.env.SENTRY_DSN;
    return out;
  });
}
