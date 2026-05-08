// Routes : /stripe/checkout, /stripe/portal, /stripe/webhook
import Stripe from 'stripe';
import crypto from 'crypto';
import { query, queryOne } from './db.js';
import { PLANS, ACTIVE_PLAN_KEYS, BILLING_CYCLES, planToPriceId, priceIdToPlan } from './plans.js';

// Helper : SHA-256 d'un email (anti-PII dans la table trial_history)
function sha256(s) { return crypto.createHash('sha256').update(String(s).toLowerCase().trim()).digest('hex'); }
// Helper : extrait l'IP du request (gère le proxy Render)
function reqIp(req) { return ((req.headers['x-forwarded-for'] || req.ip || '') + '').split(',')[0].trim(); }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
      cancel_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/pricing',
      // v1.3.2 : empreinte CB obligatoire (refuse les checkouts sans payment method)
      payment_method_collection: 'always',
      subscription_data: {
        metadata: { user_id: String(user.id), plan, billing }
      }
    });
    return { url: session.url, plan, billing };
  });

  // POST /stripe/start-trial — flow signup : 7 jours gratuits Ultra avec CB obligatoire.
  // Au J+7 si l'user n'a pas annulé via /stripe/portal, Stripe charge automatiquement
  // le 1er mois d'Ultra (selon le billing choisi). Aucun service avant cette étape.
  app.post('/stripe/start-trial', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { billing = 'monthly' } = req.body || {};
    const user = await queryOne('SELECT id, email, stripe_customer_id, plan, plan_status FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

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
      cancel_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/signup',
      // CB obligatoire (sinon Stripe refuse le subscription)
      payment_method_collection: 'always',
      subscription_data: {
        // 7 jours d'essai → charge automatique au J+7
        trial_period_days: 7,
        // Si l'user n'a pas de payment method valide à J+7, Stripe annule le subscription
        // au lieu de laisser sans payer. Politique "no pay = no service".
        trial_settings: {
          end_behavior: { missing_payment_method: 'cancel' }
        },
        metadata: { user_id: String(user.id), plan: 'ultra', billing, trial: 'true' }
      }
    });

    return { url: session.url, billing };
  });

  // ── POST /api/stripe/pack/checkout — achat d'un pack Multipost IA (v1.3.7)
  // Body : { pack: 'multipost-10' | 'multipost-25' | 'multipost-75' }
  // Crée une Stripe Checkout Session en mode 'payment' (one-time, pas subscription).
  // Le webhook checkout.session.completed grant les crédits dans pack_credits.
  app.post('/api/stripe/pack/checkout', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { pack } = req.body || {};
    const PACK_MAP = {
      'multipost-10': { priceId: process.env.STRIPE_PACK_PRICE_10, size: 10 },
      'multipost-25': { priceId: process.env.STRIPE_PACK_PRICE_25, size: 25 },
      'multipost-75': { priceId: process.env.STRIPE_PACK_PRICE_75, size: 75 },
    };
    const def = PACK_MAP[pack];
    if (!def) return reply.code(400).send({ error: 'pack invalide' });
    if (!def.priceId) {
      return reply.code(500).send({ error: 'STRIPE_PACK_PRICE_' + def.size + ' non configuré sur Render' });
    }

    const user = await queryOne('SELECT id, email, stripe_customer_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    // Crée le Stripe customer si pas déjà fait (pour relier le paiement à l'user)
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
      mode: 'payment', // one-time purchase, pas subscription
      line_items: [{ price: def.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/dashboard?pack_purchased=' + pack,
      cancel_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/dashboard#abonnement',
      // Metadata propagé au webhook pour grant les crédits
      payment_intent_data: {
        metadata: { user_id: String(user.id), pack, pack_size: String(def.size) }
      },
      metadata: { user_id: String(user.id), pack, pack_size: String(def.size), feature: 'multipost' }
    });
    return { url: session.url, pack, size: def.size };
  });

  // ── GET /api/pack/balance — solde de crédits Multipost IA restants
  // Utilisé par le dashboard et l'extension pour afficher le nombre de copies.
  app.get('/api/pack/balance', { onRequest: [app.authenticate] }, async (req, reply) => {
    const userId = req.user.sub;
    const rows = await query(
      `SELECT COALESCE(SUM(remaining), 0)::int AS total
       FROM pack_credits
       WHERE user_id = $1 AND expires_at > NOW() AND remaining > 0`,
      [userId]
    );
    const total = rows?.[0]?.total || 0;
    // Détail des packs actifs (pour transparence dans le dashboard)
    const detail = await query(
      `SELECT id, pack_size, remaining, granted_at, expires_at
       FROM pack_credits
       WHERE user_id = $1 AND expires_at > NOW() AND remaining > 0
       ORDER BY expires_at ASC`,
      [userId]
    );
    return { ok: true, total, packs: detail || [] };
  });

  // POST /stripe/portal — lien vers le portail client Stripe (gestion abo)
  app.post('/stripe/portal', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user?.stripe_customer_id) return reply.code(400).send({ error: 'aucun abonnement Stripe' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: (process.env.FRONTEND_URL || 'https://astro-pro.app') + '/dashboard'
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
      return reply.code(500).send({ error: 'cancel failed', detail: e.message });
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
      return reply.code(500).send({ error: 'reactivate failed', detail: e.message });
    }
  });

  // POST /stripe/webhook — traité RAW par Stripe signature
  app.post('/stripe/webhook', { config: { rawBody: true } }, async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      app.log.error('Webhook signature fail: ' + err.message);
      return reply.code(400).send('bad signature');
    }
    const seen = await queryOne('SELECT id FROM webhook_events WHERE stripe_event_id = $1', [event.id]);
    if (seen) return { received: true, duplicate: true };
    try {
      await handleStripeEvent(event);
      await query(
        'INSERT INTO webhook_events (stripe_event_id, type, payload) VALUES ($1, $2, $3)',
        [event.id, event.type, JSON.stringify(event.data.object).slice(0, 10000)]
      );
    } catch (e) {
      app.log.error('Webhook handler error: ' + e.message);
      return reply.code(500).send('handler error');
    }
    return { received: true };
  });
}

// v1.3.7 : grant des crédits Multipost IA après un achat one-time (pack).
// Idempotent grâce à UNIQUE constraint sur stripe_session_id.
async function grantPackCredits(session) {
  const userId = parseInt(session.metadata?.user_id || '0', 10);
  const pack = session.metadata?.pack;
  const packSize = parseInt(session.metadata?.pack_size || '0', 10);
  if (!userId || !pack || !packSize) {
    console.warn('[Pack] checkout.session.completed sans metadata pack', session.id);
    return;
  }
  // Récupère le price_id depuis line_items (pas dans session.metadata par défaut)
  let priceId = null;
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    priceId = items?.data?.[0]?.price?.id || null;
  } catch (e) {
    console.warn('[Pack] listLineItems failed', e.message);
  }
  const amountPaidCents = session.amount_total || 0;
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 12); // 12 mois validité

  // INSERT idempotent : ON CONFLICT DO NOTHING grâce a UNIQUE(stripe_session_id)
  await query(
    `INSERT INTO pack_credits (user_id, stripe_session_id, stripe_price_id, pack_size, remaining, amount_paid_cents, expires_at)
     VALUES ($1, $2, $3, $4, $4, $5, $6)
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    [userId, session.id, priceId || 'unknown', packSize, amountPaidCents, expiresAt]
  );
}

async function handleStripeEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      // v1.3.7 : pack Multipost IA (mode 'payment'). Les abos sont gérés
      // via customer.subscription.created/updated, donc on filtre.
      if (obj.mode === 'payment' && obj.metadata?.feature === 'multipost') {
        await grantPackCredits(obj);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const userId = parseInt(obj.metadata?.user_id || '0', 10);
      if (!userId) return;
      const priceId = obj.items?.data?.[0]?.price?.id;
      const { plan, billing } = priceIdToPlan(priceId);
      const effectiveBilling = billing || (obj.metadata?.billing === 'annual' ? 'annual' : 'monthly');
      const expiresAt = obj.current_period_end ? new Date(obj.current_period_end * 1000) : null;
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
      await query(
        `UPDATE users SET plan = $1, plan_status = $2, plan_expires_at = $3,
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
      const userId = parseInt(obj.metadata?.user_id || '0', 10);
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
    case 'payment_method.attached': {
      // v1.3.7 : capture le card.fingerprint pour anti-fraude trial
      try {
        const customerId = obj.customer;
        if (!customerId) break;
        const fp = obj.card?.fingerprint;
        if (!fp) break;
        // Find user by stripe_customer_id
        const u = await queryOne('SELECT id, email FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (!u) break;
        // Update user
        await query(`UPDATE users SET card_fingerprint = $1 WHERE id = $2`, [fp, u.id]);
        // Insert dans trial_history (si pas déjà là pour ce user)
        await query(
          `INSERT INTO trial_history (user_id, email_hash, card_fingerprint, ip_address)
           SELECT $1, $2, $3, signup_ip FROM users WHERE id = $1
             AND NOT EXISTS (SELECT 1 FROM trial_history WHERE user_id = $1 AND card_fingerprint = $3)`,
          [u.id, sha256(u.email || ''), fp]
        );
        // Si la carte a déjà été utilisée par un AUTRE user, c'est suspect
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
      // 1er paiement après trial OU renouvellement → user devient 'active'
      const userId = parseInt(obj.subscription_details?.metadata?.user_id || '0', 10);
      if (userId && (obj.billing_reason === 'subscription_cycle' || obj.billing_reason === 'subscription_create')) {
        await query(
          `UPDATE users SET plan_status = 'active' WHERE id = $1 AND plan_status IN ('trialing', 'past_due')`,
          [userId]
        );
        // Active la commission parrain si user est filleul
        try {
          const ref = await import('./routes-referral.js');
          if (ref.activateReferralOnFirstPayment) await ref.activateReferralOnFirstPayment(userId);
        } catch (e) {}
      }
      break;
    }
    case 'invoice.payment_failed': {
      const userId = parseInt(obj.subscription_details?.metadata?.user_id || '0', 10);
      if (userId) {
        await query(`UPDATE users SET plan_status = 'past_due' WHERE id = $1`, [userId]);
      }
      break;
    }
  }
}
