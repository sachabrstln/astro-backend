// Définition des plans + quotas + mapping Stripe
export const PLANS = {
  free: {
    name: 'Gratuit',
    price: 0,
    maxAccounts: 1,
    seoMonthly: 0,
    features: { seo: false, nego: false, repauto: false, republish: false }
  },
  starter: {
    name: 'Starter',
    price: 12.99,
    priceEnv: 'STRIPE_PRICE_STARTER',
    maxAccounts: 1,
    seoMonthly: 0,
    features: { seo: false, nego: false, repauto: false, republish: true, republishDaily: 10, messagesDaily: 20 }
  },
  pro: {
    name: 'Pro',
    price: 30,
    priceEnv: 'STRIPE_PRICE_PRO',
    maxAccounts: 3,
    seoMonthly: 0,
    features: { seo: false, nego: false, repauto: false, republish: true, republishDaily: 20, messagesDaily: Infinity }
  },
  max: {
    name: 'Max',
    price: 45.99,
    priceEnv: 'STRIPE_PRICE_MAX',
    maxAccounts: 5,
    seoMonthly: 200, // 200 générations SEO / mois
    features: { seo: true, nego: false, repauto: false, republish: true, republishDaily: Infinity, messagesDaily: Infinity }
  },
  ultra: {
    name: 'Ultra',
    price: 62.99,
    priceEnv: 'STRIPE_PRICE_ULTRA',
    maxAccounts: 10,
    seoMonthly: Infinity,
    features: { seo: true, nego: true, repauto: true, republish: true, republishDaily: Infinity, messagesDaily: Infinity }
  }
};

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
