// ──────────────────────────────────────────────────────────────
// Programme parrainage v2 (v1.3.8) — Stripe Connect Express
//
// Filleul (signup avec code) :
//   → Réduction -20% sur le 1er mois payant après les 7 jours d'essai
//
// Parrain :
//   → Choisit son propre code (4-12 caractères alphanumériques, IMMUTABLE)
//   → 20% de commission cash sur les paiements du filleul pendant 4 mois MAX
//   → Cagnotte cumulée payable via Stripe Connect Express (KYC + virement IBAN auto)
//   → Auto-stop dès que le filleul résilie / est remboursé (commission stoppée au même moment)
// ──────────────────────────────────────────────────────────────

import { query, queryOne } from './db.js';
import Stripe from 'stripe';
import { audit } from './security.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' })
  : null;

// Config — v1.3.754 : commission 20% (règle produit confirmée), filleul -20% (coupon ASTRO_REFERRAL_20)
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const COMMISSION_PCT = 20;     // 20% du montant payé par le filleul
const COMMISSION_MONTHS = 4;   // 4 premiers mois MAX du filleul (stop si résiliation avant)
const FILLEUL_DISCOUNT_PCT = 20; // -20% sur le 1er mois payant (coupon Stripe ASTRO_REFERRAL_20)
const MIN_PAYOUT_CENTS = 1000; // 10€ minimum pour retrait

// ── HELPERS ────────────────────────────────────────────────
// Linke filleul ← parrain au signup (si referred_by_code fourni)
export async function linkReferralAtSignup(refereeUserId, referrerCode) {
  if (!referrerCode) return null;
  const cleanCode = String(referrerCode).trim().toUpperCase();
  if (!CODE_RE.test(cleanCode)) return null;

  const referrer = await queryOne(`SELECT id FROM users WHERE referral_code = $1`, [cleanCode]);
  if (!referrer) return null; // code inconnu, ignore silencieusement
  if (String(referrer.id) === String(refereeUserId)) return null; // anti-self-referral

  await query(
    `INSERT INTO referrals (referrer_user_id, referee_user_id, referrer_code, status, filleul_first_month_discount_pct)
     VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (referee_user_id) DO NOTHING`,
    [referrer.id, refereeUserId, cleanCode, FILLEUL_DISCOUNT_PCT]
  );
  await query(`UPDATE users SET referred_by_code = $1 WHERE id = $2`, [cleanCode, refereeUserId]);
  return referrer.id;
}

// Active la commission parrain au 1er paiement du filleul (après trial 7j Ultra)
export async function activateReferralOnFirstPayment(refereeUserId) {
  const ref = await queryOne(
    `SELECT id, referrer_user_id, status FROM referrals WHERE referee_user_id = $1`,
    [refereeUserId]
  );
  if (!ref || ref.status !== 'pending') return;

  const now = new Date();
  const commissionEnd = new Date(now.getTime() + COMMISSION_MONTHS * 30 * 24 * 3600 * 1000);

  await query(
    `UPDATE referrals SET
       status = 'active',
       referee_paid_at = $1,
       parrain_commission_active = TRUE,
       parrain_commission_starts_at = $1,
       parrain_commission_ends_at = $2
     WHERE id = $3`,
    [now, commissionEnd, ref.id]
  );
}

// Calcule + crédite la commission au parrain pour un paiement filleul
// Appelé depuis webhook invoice.paid (mois 1, 2, 3, 4 du filleul).
export async function creditCommissionForPayment(refereeUserId, amountPaidCents, billingInterval) {
  const ref = await queryOne(
    `SELECT id, referrer_user_id, commission_paid_count, status
     FROM referrals WHERE referee_user_id = $1 AND status = 'active'`,
    [refereeUserId]
  );
  if (!ref) return null;
  const currentCount = ref.commission_paid_count || 0;
  const remaining = COMMISSION_MONTHS - currentCount;
  if (remaining <= 0) return null; // déjà 4 mois payés

  // v1.3.754 (FIX money) :
  // - MENSUEL : 1 facture = 1 mois → crédite 30% d'1 mois, +1 au compteur.
  // - ANNUEL : 1 facture = 12 mois payés d'avance, et il n'y aura pas d'autre facture
  //   avant 1 an (fenêtre de 4 mois expirée d'ici là). Avant, on ne créditait qu'1 mois
  //   → le parrain perdait 3 des 4 mois pour un filleul annuel. On crédite donc d'un coup
  //   les mois de commission RESTANTS (max 4).
  const isAnnual = (billingInterval === 'year' || billingInterval === 'annual');
  const monthsToCredit = isAnnual ? remaining : 1;
  const monthlyEquivCents = isAnnual ? Math.round(amountPaidCents / 12) : amountPaidCents;
  const commissionCents = Math.round(monthlyEquivCents * COMMISSION_PCT / 100) * monthsToCredit;

  // Concurrence optimiste : ne crédite que si le compteur n'a pas bougé depuis le SELECT
  // (WHERE commission_paid_count = currentCount). Deux invoice.paid concurrents → un seul
  // passe. Incrémente de monthsToCredit (1 mensuel, jusqu'à 4 annuel).
  //
  // v1.3.756 (FIX money — atomicité) : l'incrément du compteur ET le crédit cagnotte doivent
  // s'appliquer ATOMIQUEMENT. Avant : 2 UPDATE auto-commit séparés → si le process/DB tombait
  // entre les deux, le compteur consommait 1 mois SANS créditer la cagnotte = perte sèche pour
  // le parrain (et un retry Stripe ne réparait pas car le garde-fou optimiste bloquait alors).
  // On fait tout dans UN SEUL statement (une seule transaction implicite) via CTE modifiante :
  // l'UPDATE users ne s'exécute QUE si l'UPDATE referrals a passé le garde-fou (sinon 0 ligne).
  const upd = await queryOne(
    `WITH bump AS (
       UPDATE referrals SET
         commission_paid_count = commission_paid_count + $4,
         parrain_commission_total_cents = parrain_commission_total_cents + $1,
         parrain_commission_total_eur = (parrain_commission_total_cents + $1) / 100.0
       WHERE id = $2 AND commission_paid_count = $3
       RETURNING referrer_user_id
     )
     UPDATE users SET
       cagnotte_balance_cents = cagnotte_balance_cents + $1,
       cagnotte_lifetime_cents = cagnotte_lifetime_cents + $1
     FROM bump
     WHERE users.id = bump.referrer_user_id
     RETURNING users.id`,
    [commissionCents, ref.id, currentCount, monthsToCredit]
  );
  if (!upd) return null; // garde-fou optimiste non passé (compteur bougé) → pas de double crédit
  return { referrerUserId: ref.referrer_user_id, commissionCents };
}

// Auto-stop : appelé via webhook subscription.deleted (filleul résilie)
export async function stopReferralOnCancellation(refereeUserId) {
  await query(
    `UPDATE referrals SET status = 'cancelled', parrain_commission_active = FALSE
     WHERE referee_user_id = $1 AND status IN ('active', 'pending')`,
    [refereeUserId]
  );
}

// v1.3.754 : clawback sur remboursement — récupère la commission déjà créditée quand un
// filleul est remboursé (appelé via webhook charge.refunded). Plafonné à ce qui a été
// crédité pour CE filleul, et la cagnotte du parrain ne descend JAMAIS sous 0 (s'il a déjà
// retiré, le trop-perçu n'est pas récupérable automatiquement — décision manuelle).
export async function clawbackCommissionOnRefund(refereeUserId, amountRefundedCents) {
  if (!amountRefundedCents || amountRefundedCents <= 0) return null;
  const ref = await queryOne(
    `SELECT id, referrer_user_id, parrain_commission_total_cents
     FROM referrals WHERE referee_user_id = $1`,
    [refereeUserId]
  );
  if (!ref) return null;
  const credited = ref.parrain_commission_total_cents || 0;
  if (credited <= 0) return null;
  // Clawback = COMMISSION_PCT% du montant remboursé, plafonné au total crédité pour ce filleul.
  const clawback = Math.min(Math.round(amountRefundedCents * COMMISSION_PCT / 100), credited);
  if (clawback <= 0) return null;
  await query(
    `UPDATE referrals SET
       parrain_commission_total_cents = GREATEST(0, parrain_commission_total_cents - $1),
       parrain_commission_total_eur = GREATEST(0, parrain_commission_total_cents - $1) / 100.0
     WHERE id = $2`,
    [clawback, ref.id]
  );
  const debited = await queryOne(
    `UPDATE users SET cagnotte_balance_cents = GREATEST(0, cagnotte_balance_cents - $1)
     WHERE id = $2 RETURNING cagnotte_balance_cents`,
    [clawback, ref.referrer_user_id]
  );
  return { referrerUserId: ref.referrer_user_id, clawbackCents: clawback, newBalanceCents: debited?.cagnotte_balance_cents };
}

// Stats agrégées d'un parrain — défensif (fallback eur si la colonne cents n'existe pas)
async function getReferrerStats(referrerUserId) {
  try {
    const stats = await queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active_filleuls,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_filleuls,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_filleuls,
         COALESCE(SUM(parrain_commission_total_cents), 0) AS total_commission_cents
       FROM referrals
       WHERE referrer_user_id = $1`,
      [referrerUserId]
    );
    return stats || {};
  } catch (e) {
    // Migration v2 pas encore appliquée → fallback sur la colonne legacy parrain_commission_total_eur
    try {
      const stats = await queryOne(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active') AS active_filleuls,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending_filleuls,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_filleuls,
           COALESCE(SUM(parrain_commission_total_eur * 100), 0) AS total_commission_cents
         FROM referrals
         WHERE referrer_user_id = $1`,
        [referrerUserId]
      );
      return stats || {};
    } catch (e2) {
      // Pas de table referrals du tout → renvoie zéros
      return { active_filleuls: 0, pending_filleuls: 0, cancelled_filleuls: 0, total_commission_cents: 0 };
    }
  }
}

// ── ROUTES ─────────────────────────────────────────────────
export default async function referralRoutes(app) {

  // GET /referral/me — code + cagnotte + onboarding status + stats
  // v1.3.9 : SELECT * pour résilience si la migration parrainage_v2 n'a pas
  // encore été appliquée en DB. On lit les colonnes optionnelles avec fallback.
  app.get('/referral/me', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    let u;
    try {
      u = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
    } catch (e) {
      app.log.error({ err: e }, '[referral/me] users SELECT failed');
      return reply.code(500).send({ error: 'erreur DB users' });
    }
    if (!u) return reply.code(404).send({ error: 'user introuvable' });

    const stats = await getReferrerStats(userId);
    return {
      userEmail: u.email,                       // pour préremplir le template mailto
      code: u.referral_code || null,           // null si pas encore choisi
      codeChosenAt: u.referral_code_chosen_at, // si défini, le code est immutable
      shareUrl: u.referral_code ? `https://astro-pro.app/?ref=${u.referral_code}` : null,
      cagnotte: {
        balanceCents: u.cagnotte_balance_cents || 0,
        balanceEur: (u.cagnotte_balance_cents || 0) / 100,
        lifetimeCents: u.cagnotte_lifetime_cents || 0,
        lifetimeEur: (u.cagnotte_lifetime_cents || 0) / 100,
        minPayoutCents: MIN_PAYOUT_CENTS,
        minPayoutEur: MIN_PAYOUT_CENTS / 100,
      },
      connect: {
        accountId: u.stripe_connect_account_id || null,
        onboardingComplete: !!u.connect_onboarding_complete,
        canPayout: !!u.connect_onboarding_complete && (u.cagnotte_balance_cents || 0) >= MIN_PAYOUT_CENTS,
      },
      stats: {
        active: parseInt(stats.active_filleuls || 0),
        pending: parseInt(stats.pending_filleuls || 0),
        cancelled: parseInt(stats.cancelled_filleuls || 0),
        totalCommissionCents: parseInt(stats.total_commission_cents || 0),
        totalCommissionEur: parseInt(stats.total_commission_cents || 0) / 100,
      },
      config: {
        commissionPct: COMMISSION_PCT,
        commissionMonths: COMMISSION_MONTHS,
        filleulDiscountPct: FILLEUL_DISCOUNT_PCT,
      },
    };
  });

  // v1.3.9 : programme parrainage sur candidature manuelle.
  // /set-code reste exposé mais accessible UNIQUEMENT aux admins (validation manuelle
  // après réception du mail de candidature à support@astro-pro.app).
  // L'admin appelle l'endpoint avec { userId, code } pour attribuer le code après revue.
  const ADMIN_EMAILS = ['astrodashapp@gmail.com', 'sachabruas@gmail.com'];
  function isAdminReq(req) {
    const e = (req.user?.email || '').toLowerCase().trim();
    return !!e && ADMIN_EMAILS.includes(e);
  }

  // POST /referral/admin/grant-code — Admin uniquement : attribue un code à un user
  // Body : { userId: number, code: string }
  app.post('/referral/admin/grant-code', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!isAdminReq(req)) return reply.code(403).send({ error: 'admin only' });
    const targetUserId = parseInt(req.body?.userId, 10);
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!targetUserId) return reply.code(400).send({ error: 'userId requis' });
    if (!CODE_RE.test(code)) {
      return reply.code(400).send({ error: 'code invalide (4-12 caractères A-Z/0-9)' });
    }
    const RESERVED = ['ASTRO', 'ADMIN', 'STAFF', 'TEST', 'NULL', 'NONE', 'SUPPORT', 'ASTROPRO', 'OFFICIAL'];
    if (RESERVED.includes(code)) {
      return reply.code(400).send({ error: 'ce code est réservé' });
    }
    const me = await queryOne(`SELECT referral_code FROM users WHERE id = $1`, [targetUserId]);
    if (!me) return reply.code(404).send({ error: 'user introuvable' });
    if (me.referral_code) {
      return reply.code(409).send({ error: 'cet user a déjà un code : ' + me.referral_code });
    }
    const taken = await queryOne(`SELECT id FROM users WHERE referral_code = $1`, [code]);
    if (taken) return reply.code(409).send({ error: 'code déjà pris par user ' + taken.id });

    try {
      await query(
        `UPDATE users SET referral_code = $1, referral_code_chosen_at = NOW() WHERE id = $2`,
        [code, targetUserId]
      );
      await audit(req, 'referral_code_granted_admin', { target_user_id: targetUserId, code });
    } catch (e) {
      return reply.code(409).send({ error: 'race condition, retry' });
    }
    return { ok: true, code, userId: targetUserId, shareUrl: `https://astro-pro.app/?ref=${code}` };
  });

  // POST /referral/set-code — DÉSACTIVÉ pour les users (programme sur candidature)
  // L'endpoint répond 403 avec message d'orientation.
  app.post('/referral/set-code', { onRequest: [app.authenticate] }, async (req, reply) => {
    return reply.code(403).send({
      error: 'Le programme parrainage est sur candidature manuelle. Envoie un mail à support@astro-pro.app avec ta présentation pour recevoir un code.'
    });
  });

  // POST /referral/validate-code — vérifie qu'un code est valide (signup form)
  app.post('/referral/validate-code', async (req, reply) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return { valid: false };
    const referrer = await queryOne(`SELECT email FROM users WHERE referral_code = $1`, [code]);
    return { valid: !!referrer };
  });

  // GET /referral/list — détail filleuls (anonymisé)
  app.get('/referral/list', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const rows = await query(
      `SELECT r.id, r.status, r.referee_signup_at, r.referee_paid_at,
              r.parrain_commission_total_cents, r.commission_paid_count,
              r.parrain_commission_ends_at,
              u.email AS filleul_email
       FROM referrals r
       LEFT JOIN users u ON u.id = r.referee_user_id
       WHERE r.referrer_user_id = $1
       ORDER BY r.referee_signup_at DESC`,
      [userId]
    );
    // Anonymise email : s***@gmail.com
    const anon = (rows || []).map(r => ({
      ...r,
      filleul_email: r.filleul_email
        ? r.filleul_email[0] + '***@' + r.filleul_email.split('@')[1]
        : null,
      parrain_commission_total_eur: (r.parrain_commission_total_cents || 0) / 100,
      months_remaining: Math.max(0, 4 - (r.commission_paid_count || 0)),
    }));
    return { referrals: anon };
  });

  // POST /referral/connect/onboarding — crée le compte Stripe Connect Express
  // et retourne une URL d'onboarding hostée par Stripe (KYC + IBAN).
  app.post('/referral/connect/onboarding', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!stripe) return reply.code(503).send({ error: 'stripe indisponible' });
    const userId = req.user.sub;
    const u = await queryOne(
      `SELECT id, email, stripe_connect_account_id FROM users WHERE id = $1`,
      [userId]
    );
    if (!u) return reply.code(404).send({ error: 'user introuvable' });

    let accountId = u.stripe_connect_account_id;
    // Crée un compte Connect Express si pas déjà fait
    if (!accountId) {
      const acc = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: u.email,
        capabilities: {
          transfers: { requested: true },
        },
        metadata: { astro_user_id: String(userId) },
      });
      accountId = acc.id;
      await query(
        `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
        [accountId, userId]
      );
      await audit(req, 'connect_account_created', { account_id: accountId });
    }

    // Génère un Account Link pour l'onboarding KYC + IBAN
    const FRONTEND = (process.env.FRONTEND_URL || 'https://astro-pro.app').replace(/\/$/, '');
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FRONTEND}/parrainage?onboarding=refresh`,
      return_url: `${FRONTEND}/parrainage?onboarding=done`,
      type: 'account_onboarding',
    });

    return { ok: true, onboardingUrl: link.url, accountId };
  });

  // POST /referral/withdraw — déclenche un Stripe Transfer + Payout vers IBAN du parrain
  app.post('/referral/withdraw', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!stripe) return reply.code(503).send({ error: 'stripe indisponible' });
    const userId = req.user.sub;
    const u = await queryOne(
      `SELECT id, email, stripe_connect_account_id, connect_onboarding_complete,
              cagnotte_balance_cents
       FROM users WHERE id = $1`,
      [userId]
    );
    if (!u) return reply.code(404).send({ error: 'user introuvable' });
    if (!u.stripe_connect_account_id) {
      return reply.code(400).send({ error: 'configure d\'abord ton compte de paiement (Stripe Connect)' });
    }
    // v1.3.754 : si le flag n'est pas posé (webhook Connect account.updated non reçu/configuré),
    // on vérifie le statut du compte EN DIRECT chez Stripe et on répare le flag. Évite qu'un
    // payout soit bloqué à jamais à cause d'un webhook Connect manquant.
    let onboardingOk = !!u.connect_onboarding_complete;
    if (!onboardingOk) {
      try {
        const acc = await stripe.accounts.retrieve(u.stripe_connect_account_id);
        onboardingOk = !!(acc.details_submitted && acc.payouts_enabled);
        if (onboardingOk) {
          await query(`UPDATE users SET connect_onboarding_complete = TRUE WHERE id = $1`, [userId]);
        }
      } catch (e) {
        console.warn('[withdraw] accounts.retrieve failed:', e.message);
      }
    }
    if (!onboardingOk) {
      return reply.code(400).send({ error: 'finalise d\'abord ton onboarding Stripe Connect (KYC + IBAN)' });
    }
    const balance = u.cagnotte_balance_cents || 0;
    if (balance < MIN_PAYOUT_CENTS) {
      return reply.code(400).send({
        error: `montant minimum pour un retrait : ${MIN_PAYOUT_CENTS / 100}€ (cagnotte actuelle : ${(balance / 100).toFixed(2)}€)`,
      });
    }

    // v1.3.724 : débit ATOMIQUE et conditionnel AVANT toute opération Stripe.
    // WHERE cagnotte >= balance empêche deux retraits concurrents de payer 2×
    // (le 2e ne débite rien → 409). SET = cagnotte - balance (et pas "= 0") préserve
    // une commission créditée entre la lecture du solde et le débit.
    const debited = await queryOne(
      `UPDATE users SET cagnotte_balance_cents = cagnotte_balance_cents - $2
       WHERE id = $1 AND cagnotte_balance_cents >= $2
       RETURNING id`,
      [userId, balance]
    );
    if (!debited) {
      return reply.code(409).send({ error: 'retrait déjà en cours ou solde modifié — réessaie' });
    }

    // Débit acté → on enregistre le payout, puis on tente le transfer Stripe.
    // Si Stripe échoue, la cagnotte est re-créditée (rollback dans le catch).
    const payoutRow = await queryOne(
      `INSERT INTO payouts (user_id, amount_cents, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [userId, balance]
    );

    try {
      const transfer = await stripe.transfers.create({
        amount: balance,
        currency: 'eur',
        destination: u.stripe_connect_account_id,
        description: `Cagnotte parrainage Astro — user ${userId}`,
        metadata: { astro_user_id: String(userId), payout_id: payoutRow.id },
      });
      await query(
        `UPDATE payouts SET stripe_transfer_id = $1, status = 'succeeded', succeeded_at = NOW() WHERE id = $2`,
        [transfer.id, payoutRow.id]
      );
      await audit(req, 'referral_payout_succeeded', {
        payout_id: payoutRow.id,
        amount_cents: balance,
        transfer_id: transfer.id,
      });
      return { ok: true, amountCents: balance, amountEur: balance / 100, transferId: transfer.id };
    } catch (e) {
      // Rollback cagnotte
      await query(
        `UPDATE users SET cagnotte_balance_cents = cagnotte_balance_cents + $1 WHERE id = $2`,
        [balance, userId]
      );
      await query(
        `UPDATE payouts SET status = 'failed', failed_reason = $1 WHERE id = $2`,
        [e.message?.slice(0, 500) || 'unknown', payoutRow.id]
      );
      await audit(req, 'referral_payout_failed', {
        payout_id: payoutRow.id,
        error: e.message,
      });
      return reply.code(500).send({ error: 'transfert échoué : ' + (e.message || 'erreur inconnue') });
    }
  });

  // GET /referral/payouts — historique retraits
  app.get('/referral/payouts', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const rows = await query(
      `SELECT id, amount_cents, status, created_at, succeeded_at, failed_reason
       FROM payouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    return {
      payouts: (rows || []).map(p => ({
        ...p,
        amount_eur: (p.amount_cents || 0) / 100,
      })),
    };
  });
}
