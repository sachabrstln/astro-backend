// Routes : /stripe/checkout, /stripe/portal, /stripe/webhook
import Stripe from 'stripe';
import { query, queryOne } from './db.js';
import { PLANS, ACTIVE_PLAN_KEYS, BILLING_CYCLES, planToPriceId, priceIdToPlan } from './plans.js';

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
      success_url: (process.env.FRONTEND_URL || 'https://astropro.app') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.FRONTEND_URL || 'https://astropro.app') + '/pricing',
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

    // Anti-double-trial : un user qui a déjà eu trial_ultra_until ne peut pas en redemander
    const prev = await queryOne('SELECT trial_ultra_until FROM users WHERE id = $1', [user.id]);
    if (prev?.trial_ultra_until) {
      return reply.code(400).send({ error: 'trial déjà utilisé' });
    }

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
      success_url: (process.env.FRONTEND_URL || 'https://astropro.app') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.FRONTEND_URL || 'https://astropro.app') + '/signup',
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

  // POST /stripe/portal — lien vers le portail client Stripe (gestion abo)
  app.post('/stripe/portal', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user?.stripe_customer_id) return reply.code(400).send({ error: 'aucun abonnement Stripe' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: (process.env.FRONTEND_URL || 'https://astropro.app') + '/dashboard'
    });
    return { url: portal.url };
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

async function handleStripeEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
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
