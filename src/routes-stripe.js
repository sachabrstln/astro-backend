// Routes : /stripe/checkout, /stripe/portal, /stripe/webhook
import Stripe from 'stripe';
import crypto from 'crypto';
import { query, queryOne } from './db.js';
import { PLANS, ACTIVE_PLAN_KEYS, BILLING_CYCLES, planToPriceId, priceIdToPlan } from './plans.js';

// Helper : SHA-256 d'un email (anti-PII dans la table trial_history)
function sha256(s) { return crypto.createHash('sha256').update(String(s).toLowerCase().trim()).digest('hex'); }
// Helper : extrait l'IP du request (gère le proxy Render)
function reqIp(req) { return ((req.headers['x-forwarded-for'] || req.ip || '') + '').split(',')[0].trim(); }

// v1.3.757 : .trim() défensif — une clé collée sur Render avec un \n/espace en fin
// casse l'en-tête Authorization (ERR_INVALID_CHAR) → tous les paiements en 500.
const stripe = new Stripe((process.env.STRIPE_SECRET_KEY || '').trim());

export default async function stripeRoutes(app) {
  // POST /stripe/checkout — crée une session Checkout pour un plan + billing donnés
  // Body : { plan: 'starter'|'pro'|'ultra', billing?: 'monthly'|'annual' (défaut monthly) }
  app.post('/stripe/checkout', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { plan } = req.body || {};
    const billing = (req.body?.billing === 'annual') ? 'annual' : 'monthly';

    if (!ACTIVE_PLAN_KEYS.includes(plan)) {
      return reply.code(400).send({ error: 'plan invalide' });
    }
    if (!BILLING_CYCLES.includes(billing)) {
      return reply.code(400).send({ error: 'billing invalide (monthly ou annual)' });
    }
    const priceId = planToPriceId(plan, billing);
    if (!priceId) {
      const envKey = PLANS[plan]?.[billing === 'annual' ? 'priceEnvAnnual' : 'priceEnvMonthly'];
      return reply.code(500).send({ error: `${envKey || 'STRIPE_PRICE_*'} non configuré pour ${plan}/${billing}` });
    }

    const user = await queryOne('SELECT id, email, stripe_customer_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    // Créer le Stripe customer si pas déjà fait
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const c = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: String(user.id) }
      });
      customerId = c.id;
      await query('UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2', [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/#pricing',
      // v1.3.2 : empreinte CB obligatoire (refuse les checkouts sans payment method)
      payment_method_collection: 'always',
      subscription_data: {
        metadata: { user_id: String(user.id), plan, billing }
      }
    });
    return { url: session.url, plan, billing };
  });

  // POST /stripe/start-trial — v1.3.8 : flow signup unifié.
  // L'user choisit son target_plan (starter|pro|ultra) + billing (monthly|annual).
  // On crée la subscription sur le price ULTRA avec trial 7j → tous les users testent
  // les fonctionnalités Ultra pendant 7 jours, peu importe le plan choisi.
  // À J-3 du fin de trial (webhook trial_will_end), on swap le price Stripe vers
  // le target_plan choisi. À J+7, Stripe charge le 1er paiement du plan target.
  // Si referred_by_code est défini, on applique aussi le coupon -20% sur la 1ère facture.
  app.post('/stripe/start-trial', { onRequest: [app.authenticate] }, async (req, reply) => {
    const billing = (req.body?.billing === 'annual') ? 'annual' : 'monthly';
    const targetPlan = ['starter', 'pro', 'ultra'].includes(req.body?.targetPlan)
      ? req.body.targetPlan
      : 'ultra'; // fallback : si pas spécifié, on assume Ultra (ancien comportement)
    const user = await queryOne(
      'SELECT id, email, stripe_customer_id, plan, plan_status FROM users WHERE id = $1',
      [req.user.sub]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    // Stocke le target_plan / target_billing pour le webhook trial_will_end
    await query(
      `UPDATE users SET target_plan = $1, target_billing = $2 WHERE id = $3`,
      [targetPlan, billing, user.id]
    );

    // Anti-double-trial sur le user lui-même
    const prev = await queryOne('SELECT trial_ultra_until FROM users WHERE id = $1', [user.id]);
    if (prev?.trial_ultra_until) {
      return reply.code(400).send({ error: 'trial déjà utilisé' });
    }

    // v1.3.7 : Anti-fraude trial — un user qui a déjà eu un trial sous une autre identité
    // (email/IP/carte) ne peut pas en re-demander un.
    const emailHash = sha256(user.email);
    const ip = reqIp(req);
    const fraudCheck = await queryOne(
      `SELECT id FROM trial_history
       WHERE email_hash = $1 OR (ip_address = $2 AND created_at > NOW() - INTERVAL '30 days')
       LIMIT 1`,
      [emailHash, ip]
    );
    if (fraudCheck) {
      // Log la tentative pour analyse
      await query(
        `INSERT INTO trial_history (user_id, email_hash, ip_address, outcome)
         VALUES ($1, $2, $3, 'fraud_blocked')`,
        [user.id, emailHash, ip]
      );
      app.log.warn({ userId: user.id, email: user.email, ip }, 'trial fraud blocked');
      return reply.code(403).send({ error: 'Une période d\'essai a déjà été utilisée pour cette adresse ou ce navigateur. Souscris directement à un plan.' });
    }
    // Note : la card_fingerprint sera capturée au webhook payment_method.attached
    // (on ne peut pas la connaître avant le checkout). Le check se fait alors.

    // Récupère le price Stripe pour Ultra dans la facturation choisie
    const priceId = process.env[billing === 'annual' ? 'STRIPE_PRICE_ULTRA_ANNUAL' : 'STRIPE_PRICE_ULTRA_MONTHLY'];
    if (!priceId) return reply.code(500).send({ error: 'price Stripe non configuré' });

    // Crée le customer si pas déjà fait
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const c = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: String(user.id) }
      });
      customerId = c.id;
      await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/#signup',
      // CB obligatoire (sinon Stripe refuse le subscription)
      payment_method_collection: 'always',
      subscription_data: {
        // 7 jours d'essai → charge automatique au J+7 sur le target_plan
        trial_period_days: 7,
        // Stripe émet customer.subscription.trial_will_end 3 jours avant la fin du trial
        // → le webhook swap le price vers target_plan + applique coupon -20% si filleul
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' }
        },
        metadata: {
          user_id: String(user.id),
          plan: 'ultra',          // plan ACTIF pendant le trial (toujours Ultra)
          billing,                // billing du target (monthly|annual)
          target_plan: targetPlan, // plan qui s'activera au J+7
          target_billing: billing,
          trial: 'true',
        }
      }
    });

    return { url: session.url, billing, targetPlan };
  });

  // [MULTIPOST IA SUPPRIMÉ 2026-07-02] routes /api/stripe/pack/checkout et
  // /api/pack/balance retirées avec la feature copier-coller multi-comptes.

  // POST /stripe/portal — lien vers le portail client Stripe (gestion abo)
  app.post('/stripe/portal', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user?.stripe_customer_id) return reply.code(400).send({ error: 'aucun abonnement Stripe' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/success'
    });
    return { url: portal.url };
  });

  // ──────────────────────────────────────────────────────────
  // v1.3.7 — Endpoints résiliation / réactivation / retention
  // ──────────────────────────────────────────────────────────

  // POST /api/stripe/cancel-subscription — résilier (cancel_at_period_end)
  app.post('/api/stripe/cancel-subscription', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT id, stripe_subscription_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user?.stripe_subscription_id) {
      return reply.code(400).send({ error: 'aucun abonnement actif' });
    }
    try {
      await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
      await query(`UPDATE users SET plan_status = 'active_cancelling' WHERE id = $1`, [user.id]);
      app.log.info({ userId: user.id, subId: user.stripe_subscription_id }, 'subscription cancelled (period end)');
      return { ok: true };
    } catch (e) {
      app.log.error('Cancel subscription failed: ' + e.message);
      return reply.code(500).send({ error: 'cancel failed', detail: process.env.NODE_ENV === 'production' ? undefined : e.message });
    }
  });

  // POST /api/stripe/reactivate-subscription — annule la résiliation programmée
  app.post('/api/stripe/reactivate-subscription', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT id, stripe_subscription_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user?.stripe_subscription_id) {
      return reply.code(400).send({ error: 'aucun abonnement à réactiver' });
    }
    try {
      await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: false });
      await query(`UPDATE users SET plan_status = 'active' WHERE id = $1`, [user.id]);
      app.log.info({ userId: user.id }, 'subscription reactivated');
      return { ok: true };
    } catch (e) {
      app.log.error('Reactivate failed: ' + e.message);
      return reply.code(500).send({ error: 'reactivate failed', detail: process.env.NODE_ENV === 'production' ? undefined : e.message });
    }
  });

  // POST /stripe/webhook — traité RAW par Stripe signature
  // H5 FIX : rateLimit:false → le webhook ne doit JAMAIS être 429 (sinon Stripe retry +
  // risque de perte d'event). Le rate-limit global per-IP pourrait throttler les IP Stripe.
  app.post('/stripe/webhook', { config: { rawBody: true, rateLimit: false } }, async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, (process.env.STRIPE_WEBHOOK_SECRET || '').trim());
    } catch (err) {
      app.log.error('Webhook signature fail: ' + err.message);
      return reply.code(400).send('bad signature');
    }
    // v1.3.49 (SECURITY) : idempotency atomique via INSERT ON CONFLICT.
    // Si la DB tombe entre handleStripeEvent et INSERT (anciennement risque double-traitement),
    // on insert AVANT le handler avec ON CONFLICT DO NOTHING. Si l'INSERT retourne 0 rows
    // → event déjà vu → on abort. Sinon on traite. Si le handler échoue, l'event reste marqué
    // comme vu (Stripe retry serait inutile car la DB est probablement la racine) — on retourne
    // 500 et Stripe retentera quand même.
    let inserted;
    try {
      inserted = await query(
        `INSERT INTO webhook_events (stripe_event_id, type, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING id`,
        // v1.3.750 : PAS de .slice() — couper le JSON produisait un JSONB invalide sur les
        // gros events (invoice.*/subscription.* > 10 Ko) → INSERT rejeté → 500 → retry Stripe
        // infini, event jamais traité (plan/commission perdus alors que le paiement est encaissé).
        [event.id, event.type, JSON.stringify(event.data.object)]
      );
    } catch (e) {
      app.log.error('Webhook idempotency INSERT error: ' + e.message);
      // DB indispo → demande à Stripe de retenter
      return reply.code(500).send('db error');
    }
    if (!inserted || inserted.length === 0) {
      // Event déjà traité auparavant (query() renvoie un array de rows, pas un objet pg)
      return { received: true, duplicate: true };
    }
    try {
      await handleStripeEvent(event);
    } catch (e) {
      app.log.error('Webhook handler error: ' + e.message);
      // C1 FIX : le handler a échoué → on RETIRE la marque d'idempotence pour que le retry
      // Stripe RETRAITE l'event. Avant : la ligne webhook_events restait insérée → le retry
      // Stripe était droppé par ON CONFLICT → l'activation d'abonnement / la commission parrain
      // était PERDUE à jamais (argent pris, plan jamais accordé).
      try { await query('DELETE FROM webhook_events WHERE stripe_event_id = $1', [event.id]); } catch (_) {}
      return reply.code(500).send('handler error');
    }
    return { received: true };
  });
}

// [MULTIPOST IA SUPPRIMÉ 2026-07-02] grantPackCredits() retiré avec la feature.

// v1.3.724 : résout l'user à partir d'un objet Stripe (subscription/invoice) même si
// metadata.user_id manque (selon la version d'API Stripe, subscription_details.metadata
// n'est pas toujours propagé). Fallback DB par stripe_subscription_id puis
// stripe_customer_id (tous deux stockés sur users) → la commission parrain est bien
// stoppée à l'annulation et le statut bien mis à jour même sans metadata.
async function resolveStripeUserId(obj) {
  const fromMeta = parseInt(
    (obj && obj.metadata && obj.metadata.user_id) ||
    (obj && obj.subscription_details && obj.subscription_details.metadata && obj.subscription_details.metadata.user_id) ||
    '0', 10
  );
  if (fromMeta) return fromMeta;
  const subId = (obj && typeof obj.id === 'string' && obj.id.startsWith('sub_'))
    ? obj.id
    : (obj && obj.subscription) || null;
  if (subId) {
    const u = await queryOne('SELECT id FROM users WHERE stripe_subscription_id = $1', [subId]);
    if (u) return u.id;
  }
  const custId = (obj && obj.customer) || null;
  if (custId) {
    const u = await queryOne('SELECT id FROM users WHERE stripe_customer_id = $1', [custId]);
    if (u) return u.id;
  }
  return 0;
}

async function handleStripeEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    // [MULTIPOST IA SUPPRIMÉ 2026-07-02] branche 'checkout.session.completed'
    // (grant packs) retirée. Les abonnements passent par customer.subscription.*.
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const userId = await resolveStripeUserId(obj);
      if (!userId) return;
      const priceId = obj.items?.data?.[0]?.price?.id;
      let { plan, billing } = priceIdToPlan(priceId);
      // C2 FIX : si le priceId ne matche AUCUN env var STRIPE_PRICE_*, priceIdToPlan renvoie le
      // fallback 'free' → on downgraderait un client qui vient de PAYER (plan='free' = 0 feature).
      // On ne fait JAMAIS ça : on retombe sur le plan visé au checkout (metadata), sinon on GARDE
      // le plan actuel. Et on loggue une alerte forte pour corriger les env Stripe.
      if (plan === 'free' && priceId) {
        const metaPlan = obj.metadata?.plan || obj.metadata?.target_plan
          || obj.subscription_details?.metadata?.plan || null;
        if (metaPlan && metaPlan !== 'free' && metaPlan !== 'none') {
          console.error('[Stripe] ALERTE PRICE->PLAN MISMATCH priceId=' + priceId + ' user=' + userId + ' → fallback metadata plan=' + metaPlan + ' (VERIFIE LES ENV STRIPE_PRICE_*)');
          plan = metaPlan;
        } else {
          const cur = await queryOne('SELECT plan FROM users WHERE id = $1', [userId]);
          const keep = (cur && cur.plan && cur.plan !== 'free' && cur.plan !== 'none') ? cur.plan : null;
          console.error('[Stripe] ALERTE PRICE->PLAN MISMATCH priceId=' + priceId + ' user=' + userId + ' sans metadata → garde plan=' + (keep || plan) + ' (VERIFIE LES ENV STRIPE_PRICE_*)');
          if (keep) plan = keep;
        }
      }
      const effectiveBilling = billing || (obj.metadata?.billing === 'annual' ? 'annual' : 'monthly');
      // v1.3.755 : depuis l'API Stripe 2025-03-31, current_period_end n'est plus au niveau
      // subscription mais au niveau ITEM (items.data[0].current_period_end). Sur un compte
      // récent, obj.current_period_end est undefined → plan_expires_at tombait à NULL
      // (dashboard "prochain débit / accès jusqu'au" vide). On lit l'item en priorité,
      // fallback sur l'ancien emplacement pour compat.
      const periodEndTs = obj.items?.data?.[0]?.current_period_end || obj.current_period_end || null;
      const expiresAt = periodEndTs ? new Date(periodEndTs * 1000) : null;
      // v1.3.2 : statuses possibles
      // - 'trialing' = CB capturée, encore en trial 7j
      // - 'active' = abonnement payé en cours
      // - 'active_cancelling' = user a résilié, garde l'accès jusqu'à plan_expires_at
      // - 'past_due' = paiement échoué (retry Stripe en cours)
      let status = 'inactive';
      if (obj.status === 'trialing') status = 'trialing';
      else if (obj.status === 'active') {
        // Si user a résilié → garde l'accès jusqu'à fin de période, mais on flag le cancel
        status = obj.cancel_at_period_end ? 'active_cancelling' : 'active';
      }
      else if (obj.status === 'past_due') status = 'past_due';
      const trialEnd = obj.trial_end ? new Date(obj.trial_end * 1000) : null;
      const cancelAt = obj.cancel_at ? new Date(obj.cancel_at * 1000) : null;
      // v1.3.756 (FIX ordering) : Stripe ne garantit PAS l'ordre de livraison des webhooks.
      // Un customer.subscription.updated "trialing" (snapshot d'avant paiement) peut arriver
      // APRÈS invoice.paid → l'ancien UPDATE inconditionnel rétrogradait un client PAYANT en
      // 'trialing' (perte d'accès + expiry ramené au trial_end passé). Un abonnement ne repasse
      // jamais active→trialing chez Stripe : on refuse ce downgrade (statut + expiry conservés).
      await query(
        `UPDATE users SET plan = $1,
                          plan_status = CASE WHEN $2 = 'trialing'
                                              AND plan_status IN ('active','active_cancelling')
                                             THEN plan_status ELSE $2 END,
                          plan_expires_at = CASE WHEN $2 = 'trialing'
                                                  AND plan_status IN ('active','active_cancelling')
                                                 THEN plan_expires_at ELSE $3 END,
                          plan_billing = $4, trial_ultra_until = COALESCE(trial_ultra_until, $5),
                          stripe_subscription_id = $6, cancel_at = $7
         WHERE id = $8`,
        [plan, status, expiresAt, effectiveBilling, trialEnd, obj.id, cancelAt, userId]
      );
      break;
    }
    case 'customer.subscription.deleted': {
      // v1.3.2 : appelé SEULEMENT quand le subscription expire vraiment
      // (à plan_expires_at, après que Stripe ait honoré la période payée).
      // Pas de coupure brutale : si user a résilié il y a 3 jours, il a déjà eu accès jusque là.
      const userId = await resolveStripeUserId(obj);
      if (!userId) return;
      await query(
        `UPDATE users SET plan = 'none', plan_status = 'inactive', plan_expires_at = NULL,
                          cancel_at = NULL, stripe_subscription_id = NULL
         WHERE id = $1`,
        [userId]
      );
      // Stoppe la commission parrain (si filleul)
      try {
        const ref = await import('./routes-referral.js');
        if (ref.stopReferralOnCancellation) await ref.stopReferralOnCancellation(userId);
      } catch (e) {}
      break;
    }
    case 'charge.refunded': {
      // v1.3.725 : un remboursement d'un filleul STOPPE la commission parrain (plus de
      // crédit futur). Le clawback du déjà-crédité reste une décision produit (non
      // automatisé ici). ⚠️ Nécessite que l'event charge.refunded soit activé sur Stripe.
      const userId = await resolveStripeUserId(obj);
      if (!userId) break;
      try {
        const ref = await import('./routes-referral.js');
        if (ref.stopReferralOnCancellation) await ref.stopReferralOnCancellation(userId);
        // v1.3.754 : récupère la commission déjà créditée sur le montant remboursé
        if (ref.clawbackCommissionOnRefund) {
          // v1.3.756 (FIX money) : sur charge.refunded, obj.amount_refunded est le total CUMULÉ
          // remboursé sur la charge (pas le delta de CE remboursement), et Stripe émet un event
          // PAR remboursement. Sur 2 remboursements partiels, l'ancien code reclawait le cumul à
          // chaque event → sur-débit du parrain. On clawback sur le montant du remboursement de
          // CET event (le plus récent = refunds.data[0]) ; fallback cumul si la liste est absente.
          // Cas courant (1 seul remboursement) : refunds.data[0].amount === amount_refunded → idem.
          const thisRefundCents = obj.refunds?.data?.[0]?.amount ?? obj.amount_refunded ?? obj.amount ?? 0;
          await ref.clawbackCommissionOnRefund(userId, thisRefundCents);
        }
      } catch (e) {}
      break;
    }
    case 'payment_method.attached': {
      // v1.3.7 : capture le card.fingerprint pour anti-fraude trial
      // v1.3.7 — Anti-fraude F : bloque les cartes prépayées éphémères
      // (Revolut Lite, Vivid Money, N26 ephemeral, Wise virtual, ...).
      // Stripe expose card.funding : 'credit' | 'debit' | 'prepaid' | 'unknown'.
      // On refuse 'prepaid' → cancel la subscription + flag l'user.
      try {
        const customerId = obj.customer;
        if (!customerId) break;
        const fp = obj.card?.fingerprint;
        const funding = obj.card?.funding;
        if (!fp) break;
        // Find user by stripe_customer_id
        const u = await queryOne('SELECT id, email FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (!u) break;

        // ── BLOCK PREPAID ──
        if (funding === 'prepaid') {
          console.warn(`[FRAUD] User ${u.id} (${u.email}) tente d'utiliser une carte PREPAID — refus`);
          // Cancel la subscription en cours (si elle existe)
          try {
            const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 5 });
            for (const s of subs.data) {
              if (['active', 'trialing', 'past_due'].includes(s.status)) {
                await stripe.subscriptions.cancel(s.id, { invoice_now: false, prorate: false });
              }
            }
          } catch (e) { console.error('[prepaid cancel sub]', e.message); }
          // Flag user pour empêcher tout accès
          await query(
            `UPDATE users SET plan = 'none', plan_status = 'blocked_prepaid', card_fingerprint = $1 WHERE id = $2`,
            [fp, u.id]
          );
          // Audit pour traçabilité (colonne 'metadata' selon schéma actuel)
          try {
            await query(
              `INSERT INTO audit_log (user_id, action, metadata, created_at) VALUES ($1, $2, $3, NOW())`,
              [u.id, 'fraud_prepaid_card_blocked', JSON.stringify({ fp: fp.slice(0, 8), brand: obj.card?.brand, country: obj.card?.country })]
            );
          } catch (e) {}
          break;
        }

        // ── Carte normale : capture fingerprint + check anti-multi-trial ──
        await query(`UPDATE users SET card_fingerprint = $1 WHERE id = $2`, [fp, u.id]);
        await query(
          `INSERT INTO trial_history (user_id, email_hash, card_fingerprint, ip_address)
           SELECT $1, $2, $3, signup_ip FROM users WHERE id = $1
             AND NOT EXISTS (SELECT 1 FROM trial_history WHERE user_id = $1 AND card_fingerprint = $3)`,
          [u.id, sha256(u.email || ''), fp]
        );
        const otherUsage = await queryOne(
          `SELECT user_id FROM trial_history WHERE card_fingerprint = $1 AND user_id != $2 LIMIT 1`,
          [fp, u.id]
        );
        if (otherUsage) {
          console.warn(`[FRAUD] Card ${fp.slice(0, 8)} déjà utilisée par user ${otherUsage.user_id}, maintenant ${u.id}`);
        }
      } catch (e) {
        console.error('[payment_method.attached] error', e.message);
      }
      break;
    }
    case 'invoice.paid': {
      // 1er paiement RÉEL après trial OU renouvellement → user 'active' + commission parrain.
      const userId = await resolveStripeUserId(obj);
      const amountPaidCents = obj.amount_paid || 0;
      const isSubInvoice = obj.billing_reason === 'subscription_cycle' || obj.billing_reason === 'subscription_create';
      // v1.3.754 (FIX PARRAINAGE — money) : on IGNORE la facture $0 de DÉBUT de trial
      // (billing_reason=subscription_create, amount_paid=0, émise à la création de la sub).
      // Avant, elle activait la commission ET incrémentait commission_paid_count pour 0€
      // → le parrain perdait 1 de ses 4 mois. On n'agit QUE sur un vrai encaissement (>0).
      if (userId && isSubInvoice && amountPaidCents > 0) {
        await query(
          `UPDATE users SET plan_status = 'active' WHERE id = $1 AND plan_status IN ('trialing', 'past_due')`,
          [userId]
        );
        try {
          const ref = await import('./routes-referral.js');
          // Idempotent : n'active la commission que si le referral est encore 'pending'
          // (= ce vrai paiement est le 1er). Sûr à appeler à chaque facture payée.
          if (ref.activateReferralOnFirstPayment) await ref.activateReferralOnFirstPayment(userId);
          // Crédite la commission parrain (mois 1→4 du filleul, cap géré côté referral)
          if (ref.creditCommissionForPayment) {
            // v1.3.725 : intervalle de facturation (month/year) → l'annuel crédite les
            // mois de commission restants d'un coup (1 seule facture/an).
            const billingInterval = obj.lines?.data?.[0]?.price?.recurring?.interval
                                 || obj.lines?.data?.[0]?.plan?.interval
                                 || null;
            await ref.creditCommissionForPayment(userId, amountPaidCents, billingInterval);
          }
        } catch (e) {
          // v1.3.756 : la commission parrain est money-critical → on ne l'AVALE PAS. On propage :
          // le handler top-level supprime la marque d'idempotence et renvoie 500 → Stripe RETENTE
          // le même event → le crédit (atomique + garde-fou optimiste) est ré-appliqué sans
          // double-compter. L'activation du plan ci-dessus + activateReferral sont idempotentes.
          console.error('[invoice.paid commission]', e.message);
          throw e;
        }
      }
      break;
    }
    case 'invoice.payment_failed': {
      // H2 FIX : on RESPECTE le dunning Stripe. Un échec transitoire (3DS, plafond ou solde
      // momentané) ne doit PAS résilier un client payant. Tant que Stripe va RETENTER
      // (next_payment_attempt défini), on passe en 'past_due' (accès MAINTENU) + email doux.
      // On ne résilie DÉFINITIVEMENT que quand Stripe a épuisé ses tentatives.
      const userId = await resolveStripeUserId(obj);
      const subId = obj.subscription;
      if (!userId) break;
      if (obj.next_payment_attempt) {
        try { await query("UPDATE users SET plan_status = 'past_due' WHERE id = $1", [userId]); } catch (e) {}
        try {
          const u = await queryOne('SELECT email FROM users WHERE id = $1', [userId]);
          if (u?.email) {
            const { sendEmail } = await import('./security.js');
            const retryDate = new Date(obj.next_payment_attempt * 1000).toLocaleDateString('fr-FR');
            await sendEmail({
              to: u.email,
              subject: 'Astro — paiement à régulariser (accès maintenu)',
              html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;"><h2 style="color:#D97706;">Paiement à régulariser</h2><p>Le paiement de ton renouvellement Astro n'a pas pu aboutir (carte refusée, plafond ou solde insuffisant).</p><p>Pas de panique : ton accès est <strong>maintenu</strong>, on réessaie automatiquement le ${retryDate}. Mets à jour ta carte sur <a href="https://astro-pro.app">astro-pro.app</a> pour éviter toute coupure.</p></div>`,
            });
          }
        } catch (e) {}
        break;
      }
      // v1.3.756 (FIX) : l'absence de next_payment_attempt ne PROUVE pas que Stripe a
      // définitivement abandonné (ça dépend de la config de dunning du compte). Avant l'action
      // DESTRUCTIVE (cancel + effacement de la sub), on vérifie l'état réel chez Stripe. Si la
      // sub est encore récupérable (past_due/active), on se contente de 'past_due' (accès déjà
      // suspendu par les gates) et on laisse customer.subscription.deleted nettoyer plus tard.
      let subTerminal = true;
      if (subId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          subTerminal = ['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status);
        } catch (e) {
          subTerminal = true; // sub introuvable côté Stripe → on la considère terminée
        }
      }
      if (!subTerminal) {
        try { await query("UPDATE users SET plan_status = 'past_due' WHERE id = $1", [userId]); } catch (e) {}
        break;
      }
      try {
        // Cancel immédiat de la sub Stripe (au lieu de la laisser en past_due)
        if (subId) {
          try {
            await stripe.subscriptions.cancel(subId, { invoice_now: false, prorate: false });
          } catch (e) {
            // La sub peut déjà être canceled si Stripe l'a fait avant — on ignore
            console.warn('[invoice.payment_failed] cancel sub error (ignoré):', e.message);
          }
        }
        // Marque l'user comme inactif tout de suite
        await query(
          `UPDATE users SET plan_status = 'inactive', plan = 'none',
                            plan_expires_at = NULL, cancel_at = NULL,
                            stripe_subscription_id = NULL
           WHERE id = $1`,
          [userId]
        );
        // Stoppe la commission parrain si filleul (le parrain ne touche plus de commission
        // sur ce filleul puisqu'il n'est plus client payant)
        try {
          const ref = await import('./routes-referral.js');
          if (ref.stopReferralOnCancellation) await ref.stopReferralOnCancellation(userId);
        } catch (e) {}
        // Audit
        try {
          await query(
            `INSERT INTO audit_log (user_id, action, metadata, created_at) VALUES ($1, $2, $3, NOW())`,
            [userId, 'subscription_canceled_payment_failed', JSON.stringify({
              invoice_id: obj.id,
              amount_due_cents: obj.amount_due || 0,
              attempt_count: obj.attempt_count || 1,
            })]
          );
        } catch (e) {}
        // Email à l'user pour le notifier
        try {
          const u = await queryOne('SELECT email FROM users WHERE id = $1', [userId]);
          if (u?.email) {
            const { sendEmail } = await import('./security.js');
            await sendEmail({
              to: u.email,
              subject: 'Astro — abonnement résilié (paiement échoué)',
              html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
                <h2 style="color:#DC2626;">Abonnement résilié</h2>
                <p>Le paiement de ton renouvellement Astro n'a pas pu être traité par ta banque (carte refusée, plafond atteint, ou solde insuffisant).</p>
                <p>Conformément à nos conditions, ton abonnement a été <strong>résilié immédiatement</strong> et l'accès aux fonctionnalités est suspendu.</p>
                <p>Pour reprendre Astro, refais un signup avec une carte valide sur <a href="https://astro-pro.app">astro-pro.app</a>.</p>
                <p style="color:#888;font-size:12px;margin-top:24px;">Si tu penses que c'est une erreur (carte temporairement bloquée par exemple), contacte-nous à support@astro-pro.app dans les 7 jours et on regardera ton dossier.</p>
              </div>`,
              text: `Astro — Abonnement résilié.\n\nLe paiement de ton renouvellement n'a pas pu être traité. L'abonnement est résilié immédiatement.\n\nPour reprendre, refais un signup sur https://astro-pro.app`,
            });
          }
        } catch (e) { console.warn('[payment_failed email]', e.message); }
      } catch (e) {
        console.error('[invoice.payment_failed] handler error:', e.message);
        // Fallback : au moins marquer past_due si on a échoué quelque part
        try {
          await query(`UPDATE users SET plan_status = 'inactive' WHERE id = $1`, [userId]);
        } catch (e2) {}
      }
      break;
    }
    // v1.3.8 — Stripe Connect Express : track quand le parrain a fini son onboarding KYC
    case 'account.updated': {
      try {
        const acc = obj; // l'objet est un Account (Connect)
        const accountId = acc.id;
        if (!accountId) break;
        // L'onboarding est complet quand : details_submitted + charges_enabled + payouts_enabled
        const complete = !!(acc.details_submitted && acc.payouts_enabled);
        const u = await queryOne(
          `SELECT id FROM users WHERE stripe_connect_account_id = $1`,
          [accountId]
        );
        if (!u) break;
        await query(
          `UPDATE users SET connect_onboarding_complete = $1 WHERE id = $2`,
          [complete, u.id]
        );
      } catch (e) {
        console.error('[account.updated]', e.message);
      }
      break;
    }
    // v1.3.8 — Trial Ultra-pour-tous : à J-3 de la fin du trial, swap le price
    // de la subscription vers le target_plan choisi par l'user au signup.
    case 'customer.subscription.trial_will_end': {
      try {
        const userId = await resolveStripeUserId(obj);
        if (!userId) break;
        const u = await queryOne(
          `SELECT id, target_plan, target_billing, referred_by_code FROM users WHERE id = $1`,
          [userId]
        );
        if (!u) break;
        const targetPlan = u.target_plan || 'starter'; // fallback raisonnable
        const targetBilling = u.target_billing || 'monthly';
        const targetPriceId = priceIdForPlan(targetPlan, targetBilling);
        if (!targetPriceId) {
          console.warn(`[trial_will_end] no price for ${targetPlan}/${targetBilling} (user ${userId})`);
          break;
        }
        // Récupère l'item courant de la subscription
        const sub = await stripe.subscriptions.retrieve(obj.id);
        const currentItem = sub.items.data[0];
        if (!currentItem) break;
        // Si déjà sur le bon price, rien à faire
        if (currentItem.price.id === targetPriceId) break;
        // Swap le price (sans proration, prend effet à la fin du trial). CRITIQUE :
        // doit réussir indépendamment du coupon filleul.
        await stripe.subscriptions.update(obj.id, {
          items: [{ id: currentItem.id, price: targetPriceId }],
          proration_behavior: 'none',
        });
        console.log(`[trial_will_end] swapped user ${userId} to ${targetPlan}/${targetBilling}`);
        // v1.3.725 : coupon filleul -20% sur la 1ère facture (best-effort). Avant : 15%,
        // et un coupon manquant cassait TOUT le swap. Désormais appliqué APRÈS le swap
        // dans son propre try → un coupon absent ne bloque plus l'activation du plan.
        // ⚠️ Créer dans Stripe Dashboard → Coupons un coupon 20% off, duration=once,
        //    d'id STRIPE_REFERRAL_COUPON (défaut 'ASTRO_REFERRAL_20').
        if (u.referred_by_code) {
          const couponId = process.env.STRIPE_REFERRAL_COUPON || 'ASTRO_REFERRAL_20';
          try {
            await stripe.subscriptions.update(obj.id, { discounts: [{ coupon: couponId }] });
            console.log(`[trial_will_end] coupon filleul ${couponId} appliqué (user ${userId})`);
          } catch (e) {
            console.warn(`[trial_will_end] coupon filleul ${couponId} non appliqué: ${e.message}`);
          }
        }
      } catch (e) {
        console.error('[trial_will_end] swap failed', e.message);
      }
      break;
    }
  }
}

// v1.3.8 — Helper inverse de priceIdToPlan : plan + billing → price_id
function priceIdForPlan(plan, billing) {
  const PRICES = {
    'starter:monthly':  process.env.STRIPE_PRICE_STARTER_MONTHLY,
    'starter:annual':   process.env.STRIPE_PRICE_STARTER_ANNUAL,
    'pro:monthly':      process.env.STRIPE_PRICE_PRO_MONTHLY,
    'pro:annual':       process.env.STRIPE_PRICE_PRO_ANNUAL,
    'ultra:monthly':    process.env.STRIPE_PRICE_ULTRA_MONTHLY,
    'ultra:annual':     process.env.STRIPE_PRICE_ULTRA_ANNUAL,
  };
  return PRICES[`${plan}:${billing}`] || null;
}
