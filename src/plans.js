// ──────────────────────────────────────────────────────────────
// Définition des 3 plans Astro + quotas + mapping Stripe
// Chaque plan actif a 2 prices Stripe : monthly + annual (-10%)
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

  // TIER 1 : Astro Starter — entrée, vendeur occasionnel (decoy faible)
  // v1.3.1 : volontairement frustrant pour pousser vers Ultra
  starter: {
    name: 'Astro Starter',
    price: 17,
    priceAnnualMonthly: 15.30,
    priceAnnualTotal: 183.60,
    priceEnvMonthly: 'STRIPE_PRICE_STARTER_MONTHLY',
    priceEnvAnnual:  'STRIPE_PRICE_STARTER_ANNUAL',
    maxAccounts: 1,
    seoMonthly: 0,
    bgSwapMonthly: 0, // Clipboard copier-coller multi-comptes : Ultra-only
    features: {
      republish: true, republishDaily: 10,
      messagesDaily: 20,
      bordereaux: true,
      sync: true,
      simulator: false,         // ✗ pas de simulateur ROI
      roi: false,               // ✗ pas de Profits & ROI
      compta: false,            // ✗ pas de Compta URSSAF
      analyticsLevel: 'simple', // analyse basique uniquement
      bundle: false, modif: false, pricingIntel: false, sellerScore: false, winners: false, dormant: false,
      granularity: false,
      seo: false, nego: false, repauto: false
    }
  },

  // TIER 2 : Astro Pro — decoy moyen (volontairement frustrant pour pousser vers Ultra)
  // v1.3.1 : pas d'IA, pas de Compta URSSAF, pas de Profits & ROI, pas de multi-comptes
  pro: {
    name: 'Astro Pro',
    price: 35,
    priceAnnualMonthly: 31.50,
    priceAnnualTotal: 378,
    priceEnvMonthly: 'STRIPE_PRICE_PRO_MONTHLY',
    priceEnvAnnual:  'STRIPE_PRICE_PRO_ANNUAL',
    maxAccounts: 1,
    seoMonthly: 0,
    bgSwapMonthly: 0, // Clipboard copier-coller multi-comptes : Ultra-only
    features: {
      republish: true, republishDaily: 25,    // 25 republications/jour (limité)
      messagesDaily: 250,                     // 250 relances favoris/jour
      bordereaux: true,
      sync: true,
      simulator: false,        // ✗ pas de simulateur ROI
      roi: false,              // ✗ pas de Profits & ROI
      compta: false,           // ✗ pas de Compta URSSAF
      analyticsLevel: 'simple',// analyse simple uniquement (pas de granularité)
      modif: true,             // modification en masse OK
      bundle: false,           // ✗ pas de bundle intelligent (Ultra)
      pricingIntel: false,     // ✗ Ultra
      sellerScore: false,      // ✗ Ultra
      winners: false,          // ✗ Ultra
      dormant: false,          // ✗ Ultra
      granularity: false,      // ✗ Ultra
      seo: false, nego: false, repauto: false
    }
  },

  // DEPRECATED : conservé pour les users existants avant migration (ancien tier Max)
  max: {
    name: 'Max (déprécié)',
    price: 45.99,
    deprecated: true,
    priceEnvMonthly: 'STRIPE_PRICE_MAX',
    maxAccounts: 5,
    seoMonthly: 200,
    features: {
      republish: true, republishDaily: Infinity,
      messagesDaily: Infinity,
      bordereaux: true, sync: true, simulator: true, roi: true,
      bundle: true, modif: true, pricingIntel: true, sellerScore: true, winners: true, dormant: true, granularity: true,
      seo: true, nego: false, repauto: false
    }
  },

  // TIER 3 : Astro Ultra — LE plan recommandé (4/5 des power sellers)
  // v1.3.1 : positionné comme évident upgrade, ARPU principal
  ultra: {
    name: 'Astro Ultra',
    price: 69,
    priceAnnualMonthly: 62.10,
    priceAnnualTotal: 745.20,
    priceEnvMonthly: 'STRIPE_PRICE_ULTRA_MONTHLY',
    priceEnvAnnual:  'STRIPE_PRICE_ULTRA_ANNUAL',
    maxAccounts: 10,             // multi-comptes Ultra-only
    seoMonthly: Infinity,
    // Clipboard : copier-coller multi-comptes avec détourage IA des photos.
    // 150 swaps/mois = ~30 annonces × 5 photos. Au-delà → upsell pay-as-you-go.
    bgSwapMonthly: 150,
    popular: true,               // badge "Recommandé" déplacé sur Ultra
    socialProof: '4 vendeurs sur 5 le choisissent',
    features: {
      // Volumes : tout illimité
      republish: true, republishDaily: Infinity,
      messagesDaily: Infinity,
      bordereaux: true,
      sync: true,

      // Analytics & business : tout débloqué
      simulator: true, roi: true,
      compta: true,             // Compta URSSAF Ultra-only
      analyticsLevel: 'pro',    // analyse complète + granularité
      granularity: true,

      // Optimisation produit
      bundle: true,
      modif: true,
      pricingIntel: true,
      sellerScore: true,
      winners: true,
      dormant: true,

      // IA premium (Ultra-only, le gros différenciateur)
      seo: true, seoDaily: Infinity,
      nego: true,
      repauto: true,
      iaModel: 'sonnet',        // Sonnet 4.6 (vs Haiku sur les rares features Pro IA)

      // Support & exclusivités
      alerts: true,
      prioritySupport: true,
      multiCompte: true,
      earlyAccess: true         // accès aux nouvelles features avant les autres
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

// Les 3 tiers ACTIFS (affichés sur la page Abonnement / landing)
export const ACTIVE_PLAN_KEYS = ['starter', 'pro', 'ultra'];

// Billing cycles supportés
export const BILLING_CYCLES = ['monthly', 'annual'];

export function hasFeature(plan, feature) {
  return !!(PLANS[plan]?.features?.[feature]);
}

// ───────────────────────────────────────────────────────────────
// Helpers Stripe price mapping
// ───────────────────────────────────────────────────────────────

/**
 * Map Stripe price ID → { plan, billing }.
 * billing = 'monthly' | 'annual'
 * Fallback : { plan: 'free', billing: 'monthly' } si aucune correspondance.
 */
export function priceIdToPlan(priceId) {
  if (!priceId) return { plan: 'free', billing: 'monthly' };
  for (const [key, p] of Object.entries(PLANS)) {
    if (p.priceEnvMonthly && process.env[p.priceEnvMonthly] === priceId) {
      return { plan: key, billing: 'monthly' };
    }
    if (p.priceEnvAnnual && process.env[p.priceEnvAnnual] === priceId) {
      return { plan: key, billing: 'annual' };
    }
  }
  return { plan: 'free', billing: 'monthly' };
}

/**
 * Map (plan, billing) -> Stripe price ID depuis les env vars.
 * billing = 'monthly' (defaut) | 'annual'. Retourne null si non configure.
 */
export function planToPriceId(plan, billing) {
  if (billing == null) billing = 'monthly';
  const p = PLANS[plan];
  if (!p) return null;
  const envKey = (billing === 'annual') ? p.priceEnvAnnual : p.priceEnvMonthly;
  if (!envKey) return null;
  return process.env[envKey] || null;
}

/**
 * Retourne le prix affichable (nombre) pour un (plan, billing) donne.
 */
export function planDisplayPrice(plan, billing) {
  if (billing == null) billing = 'monthly';
  const p = PLANS[plan];
  if (!p) return 0;
  if (billing === 'annual' && p.priceAnnualMonthly != null) return p.priceAnnualMonthly;
  return p.price;
}
