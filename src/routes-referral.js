// ──────────────────────────────────────────────────────────────
// Programme de parrainage Astro v1.3.1
//
// Filleul (qui s'inscrit avec un code) :
//   → 7 jours d'essai Ultra gratuits (déjà inclus dans signup standard)
//   → 20% de réduction sur le 1er mois payant
//
// Parrain (à chaque filleul converti) :
//   → 15 jours Ultra crédités sur son abo (cumulables)
//   → 30% de commission cash sur les paiements du filleul pendant 4 mois
//   → Auto-stop dès que le filleul résilie
// ──────────────────────────────────────────────────────────────

import { query, queryOne } from './db.js';


// Génère un code parrainage court et lisible (8 chars alphanumériques)
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export async function ensureUserHasReferralCode(userId) {
  const u = await queryOne(`SELECT referral_code FROM users WHERE id = $1`, [userId]);
  if (u && u.referral_code) return u.referral_code;
  // Génère un code unique (max 5 essais en cas de collision)
  for (let i = 0; i < 5; i++) {
    const code = generateReferralCode();
    try {
      await query(`UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL`, [code, userId]);
      const check = await queryOne(`SELECT referral_code FROM users WHERE id = $1`, [userId]);
      if (check && check.referral_code === code) return code;
    } catch (e) { /* collision UNIQUE → retry */ }
  }
  throw new Error('referral_code_generation_failed');
}

// Crée un lien filleul → parrain au signup (si referred_by_code fourni)
export async function linkReferralAtSignup(refereeUserId, referrerCode) {
  if (!referrerCode) return null;
  const referrer = await queryOne(`SELECT id FROM users WHERE referral_code = $1`, [referrerCode]);
  if (!referrer) return null; // code inconnu, ignore silencieusement
  if (referrer.id === refereeUserId) return null; // anti-fraude : pas son propre code

  await query(
    `INSERT INTO referrals (referrer_user_id, referee_user_id, referrer_code, status, filleul_first_month_discount_pct)
     VALUES ($1, $2, $3, 'pending', 20)
     ON CONFLICT (referee_user_id) DO NOTHING`,
    [referrer.id, refereeUserId, referrerCode]
  );

  // Marque l'user comme référé pour Stripe coupon
  await query(`UPDATE users SET referred_by_code = $1 WHERE id = $2`, [referrerCode, refereeUserId]);
  return referrer.id;
}

// Active la récompense parrain dès que le filleul paie (Stripe webhook subscription.created)
export async function activateReferralOnFirstPayment(refereeUserId) {
  const ref = await queryOne(
    `SELECT id, referrer_user_id, status FROM referrals WHERE referee_user_id = $1`,
    [refereeUserId]
  );
  if (!ref || ref.status !== 'pending') return;

  const now = new Date();
  const commissionEnd = new Date(now.getTime() + 4 * 30 * 24 * 3600 * 1000); // 4 mois

  await query(
    `UPDATE referrals SET
       status = 'active',
       referee_paid_at = $1,
       parrain_ultra_days_credited = 15,
       parrain_commission_active = TRUE,
       parrain_commission_starts_at = $1,
       parrain_commission_ends_at = $2
     WHERE id = $3`,
    [now, commissionEnd, ref.id]
  );

  // Crédite 15 jours Ultra au parrain (extend trial_ultra_until OU plan_period_end)
  await query(
    `UPDATE users
     SET trial_ultra_until = COALESCE(trial_ultra_until, NOW()) + INTERVAL '15 days'
     WHERE id = $1`,
    [ref.referrer_user_id]
  );
}

// Auto-stop : appelé via Stripe webhook subscription.deleted
export async function stopReferralOnCancellation(refereeUserId) {
  await query(
    `UPDATE referrals SET status = 'cancelled', parrain_commission_active = FALSE
     WHERE referee_user_id = $1 AND status = 'active'`,
    [refereeUserId]
  );
}

// Calcule la commission cumulée d'un parrain (pour affichage dashboard / payouts mensuels)
export async function getReferrerStats(referrerUserId) {
  const stats = await queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active') AS active_filleuls,
       COUNT(*) FILTER (WHERE status = 'pending') AS pending_filleuls,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_filleuls,
       COALESCE(SUM(parrain_commission_total_eur), 0) AS total_commission_eur,
       COALESCE(SUM(parrain_ultra_days_credited), 0) AS total_ultra_days_credited
     FROM referrals
     WHERE referrer_user_id = $1`,
    [referrerUserId]
  );
  return stats || {};
}

// Routes Fastify
export default async function referralRoutes(app) {
  // GET /referral/me — code + stats
  app.get('/referral/me', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const code = await ensureUserHasReferralCode(userId);
    const stats = await getReferrerStats(userId);
    return {
      code,
      shareUrl: `https://astropro.app/?ref=${code}`,
      stats: {
        active: parseInt(stats.active_filleuls || 0),
        pending: parseInt(stats.pending_filleuls || 0),
        cancelled: parseInt(stats.cancelled_filleuls || 0),
        totalCommissionEur: parseFloat(stats.total_commission_eur || 0),
        totalUltraDaysCredited: parseInt(stats.total_ultra_days_credited || 0)
      }
    };
  });

  // GET /referral/list — liste détaillée des filleuls (pour le dashboard parrain)
  app.get('/referral/list', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const rows = await query(
      `SELECT r.id, r.status, r.referee_signup_at, r.referee_paid_at,
              r.parrain_commission_total_eur, r.parrain_commission_ends_at,
              u.email AS filleul_email
       FROM referrals r
       LEFT JOIN users u ON u.id = r.referee_user_id
       WHERE r.referrer_user_id = $1
       ORDER BY r.referee_signup_at DESC`,
      [userId]
    );
    return { referrals: rows || [] };
  });

  // POST /referral/validate-code — vérifie qu'un code est valide (pour le widget signup)
  app.post('/referral/validate-code', async (req, reply) => {
    const { code } = req.body || {};
    if (!code) return reply.code(400).send({ error: 'code requis' });
    const referrer = await queryOne(`SELECT email FROM users WHERE referral_code = $1`, [code]);
    return { valid: !!referrer };
  });
}
