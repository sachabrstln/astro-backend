// Routes : /stripe/checkout, /stripe/portal, /stripe/webhook
import Stripe from 'stripe';
import { query, queryOne } from './db.js';
import { PLANS, planToPriceId, priceIdToPlan } from './plans.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function stripeRoutes(app) {
  // POST /stripe/checkout — crée une session Checkout pour un plan donné
  app.post('/stripe/checkout', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { plan } = req.body || {};
    if (!PLANS[plan] || plan === 'free') {
      return reply.code(400).send({ error: 'plan invalide' });
    }
    const priceId = planToPriceId(plan);
    if (!priceId) return reply.code(500).send({ error: 'STRIPE_PRICE_* non configuré pour ' + plan });

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
      success_url: (process.env.FRONTEND_URL || 'https://astro-vinted.com') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.FRONTEND_URL || 'https://astro-vinted.com') + '/pricing',
      subscription_data: {
        metadata: { user_id: String(user.id), plan }
      }
    });
    return { url: session.url };
  });

  // POST /stripe/portal — lien vers le portail client Stripe (gestion abo)
  app.post('/stripe/portal', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.sub]);
    if (!user?.stripe_customer_id) return reply.code(400).send({ error: 'aucun abonnement Stripe' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: (process.env.FRONTEND_URL || 'https://astro-vinted.com') + '/dashboard'
    });
    return { url: portal.url };
  });

  // POST /stripe/webhook — traité RAW par Stripe signature
  app.post('/stripe/webhook', {
    config: { rawBody: true }
  }, async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      app.log.error('Webhook signature fail: ' + err.message);
      return reply.code(400).send('bad signature');
    }

    // Idempotence
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
      const plan = priceIdToPlan(priceId);
      const expiresAt = obj.current_period_end ? new Date(obj.current_period_end * 1000) : null;
      const status = obj.status === 'active' || obj.status === 'trialing' ? 'active' : 'inactive';
      await query(
        `UPDATE users SET plan = $1, plan_status = $2, plan_expires_at = $3, updated_at = NOW() WHERE id = $4`,
        [status === 'active' ? plan : 'free', status, expiresAt, userId]
      );
      break;
    }
    case 'customer.subscription.deleted': {
      const userId = parseInt(obj.metadata?.user_id || '0', 10);
      if (!userId) return;
      await query(
        `UPDATE users SET plan = 'free', plan_status = 'inactive', updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      break;
    }
  }
}
