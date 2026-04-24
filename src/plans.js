// ──────────────────────────────────────────────────────────────
// Définition des 3 plans Astro + quotas + mapping Stripe
// Migration : free/max/elite sont dépréciés (backward compat uniquement)
// ──────────────────────────────────────────────────────────────
export const PLANS = {
  // DEPRECATED : conservé pour les users existants avant migration
  free: {
    name: 'Gratuit (déprécié)',
    price: 0,
    deprecated: true,
    maxAccounts: 1,
    seoMonthly: 0,
    features: { seo: false, nego: false, repauto: false, republish: false, bundle: false, modif: false, bordereaux: false }
  },

  // TIER 1 : Astro Starter (14.99€) — entrée, vendeur occasionnel
  starter: {
    name: 'Astro Starter',
    price: 14.99,
    priceEnv: 'STRIPE_PRICE_STARTER',
    maxAccounts: 1,
    seoMonthly: 0,
    features: {
      republish: true, republishDaily: 10,
      messagesDaily: 20,
      bordereaux: true,
      sync: true,
      simulator: true, roi: true,
      bundle: false, modif: false, pricingIntel: false, sellerScore: false, winners: false, dormant: false,
      seo: false, nego: false, repauto: false
    }
  },

  // TIER 2 : Astro Pro (32.99€) ⭐ — sweet spot, vendeur régulier
  pro: {
    name: 'Astro Pro',
    price: 32.99,
    priceEnv: 'STRIPE_PRICE_PRO',
    maxAccounts: 3,
    seoMonthly: 0,
    popular: true,
    features: {
      republish: true, republishDaily: Infinity,
      messagesDaily: Infinity,
      bordereaux: true,
      sync: true,
      simulator: true, roi: true,
      bundle: true,                  // dédup intelligente
      modif: true,                   // modification en masse
      pricingIntel: true,            // 3 prix suggérés
      sellerScore: true,             // Score Vendeur /100
      winners: true,                 // Articles Gagnants
      dormant: true,                 // Alerte articles dormants
      granularity: true,             // Analytics jour/semaine/mois/année
      seo: false, nego: false, repauto: false
    }
  },

  // DEPRECATED : conservé pour les users existants avant migration
  max: {
    name: 'Max (déprécié)',
    price: 45.99,
    deprecated: true,
    priceEnv: 'STRIPE_PRICE_MAX',
    maxAccounts: 5,
    seoMonthly: 200,
    // On mappe Max sur les features de Pro + SEO (pour compat user existant)
    features: {
      republish: true, republishDaily: Infinity,
      messagesDaily: Infinity,
      bordereaux: true, sync: true, simulator: true, roi: true,
      bundle: true, modif: true, pricingIntel: true, sellerScore: true, winners: true, dormant: true, granularity: true,
      seo: true, nego: false, repauto: false
    }
  },

  // TIER 3 : Astro Ultra (65.99€) — premium, power sellers
  ultra: {
    name: 'Astro Ultra',
    price: 65.99,
    priceEnv: 'STRIPE_PRICE_ULTRA',
    maxAccounts: 10,
    seoMonthly: Infinity,
    features: {
      republish: true, republishDaily: Infinity,
      messagesDaily: Infinity,
      bordereaux: true,
      sync: true,
      simulator: true, roi: true,
      bundle: true, modif: true, pricingIntel: true, sellerScore: true, winners: true, dormant: true,
      granularity: true,
      seo: true, seoDaily: Infinity,  // SEO IA illimité
      nego: true,                      // Négociation auto
      repauto: true,                   // Réponses auto IA
      alerts: true,                    // Alertes temps réel
      prioritySupport: true
    }
  },

  // DEPRECATED : alias de Ultra pour les anciens comptes "elite"
  elite: {
    name: 'Elite (déprécié)',
    price: 62.99,
    deprecated: true,
    maxAccounts: 10,
    seoMonthly: Infinity,
    features: { seo: true, nego: true, repauto: true, republish: true, republishDaily: Infinity, messagesDaily: Infinity, bundle: true, modif: true, pricingIntel: true, sellerScore: true, winners: true, dormant: true, granularity: true, alerts: true, prioritySupport: true }
  }
};

// Les 3 tiers ACTIFS (affichés sur la page Abonnement)
export const ACTIVE_PLAN_KEYS = ['starter', 'pro', 'ultra'];

export function hasFeature(plan, feature) {
  return !!(PLANS[plan]?.features?.[feature]);
}

// Map Stripe price ID → plan key
export function priceIdToPlan(priceId) {
  for (const [key, p] of Object.entries(PLANS)) {
    if (p.priceEnv && process.env[p.priceEnv] === priceId) return key;
  }
  return 'free';
}

// Map plan → Stripe price ID
export function planToPriceId(plan) {
  const p = PLANS[plan];
  if (!p?.priceEnv) return null;
  return process.env[p.priceEnv] || null;
}
