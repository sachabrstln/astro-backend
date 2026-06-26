// Entrée serveur Fastify — charge tous les plugins + routes
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import authRoutes from './routes-auth.js';
import stripeRoutes from './routes-stripe.js';
import aiRoutes from './routes-ai.js';
import clipboardRoutes from './routes-clipboard.js';
import referralRoutes from './routes-referral.js';
import adminRoutes from './routes-admin.js';
import supportRoutes from './routes-support.js';
import { queryOne } from './db.js';

const IS_PROD = process.env.NODE_ENV === 'production';

// ── Sentry (optionnel) ─────────────────────────────────────
// v1.3.4 (#2) : init conditionnel via SENTRY_DSN. Si la var n'est pas set,
// on skip silencieusement. Dynamic import pour ne pas planter si la dep
// n'est pas installée localement.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
      // Ne pas leak les bodies / headers sensibles
      sendDefaultPii: false,
    });
    console.log('[Sentry] initialisé (env:', process.env.NODE_ENV || 'development', ')');
  } catch (err) {
    console.warn('[Sentry] init failed (dep manquante ?) :', err?.message || err);
    Sentry = null;
  }
}

const app = Fastify({
  logger: IS_PROD ? true : { transport: { target: 'pino-pretty' } },
  // Body limit 1 MB par défaut ; la route SEO override à 15 MB.
  bodyLimit: 1 * 1024 * 1024,
  // Masque les stack traces en prod
  disableRequestLogging: !IS_PROD,
});

// SÉCURITÉ : headers HTTP (HSTS, X-Frame-Options, etc.)
await app.register(helmet, {
  contentSecurityPolicy: false, // API JSON, pas de CSP spécifique
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // autorise lecture cross-origin pour l'extension
});

// CORS — autorise extension Chrome + site public.
// v1.3.49 (SECURITY) : localhost retiré en prod (fuite CSRF possible si user visite
// localhost malveillant). Restreint aussi chrome-extension:// à un allowlist d'IDs si
// CHROME_EXTENSION_IDS est défini.
const ALLOWED_EXTENSION_IDS = (process.env.CHROME_EXTENSION_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.startsWith('chrome-extension://')) {
      // Si on a un allowlist d'IDs publiés → on filtre. Sinon (dev), on accepte tout chrome-ext.
      if (ALLOWED_EXTENSION_IDS.length === 0) return cb(null, true);
      const extId = origin.replace('chrome-extension://', '').replace(/\/$/, '');
      if (ALLOWED_EXTENSION_IDS.includes(extId)) return cb(null, true);
      return cb(new Error('CORS extension ID non autorisé : ' + extId), false);
    }
    const allowed = [
      process.env.FRONTEND_URL,
      'https://astro-pro.app',
      'https://www.astro-pro.app',
    ];
    if (!IS_PROD) {
      allowed.push('http://localhost:3000', 'http://localhost:5173');
    }
    const list = allowed.filter(Boolean);
    if (list.includes(origin)) return cb(null, true);
    return cb(new Error('CORS bloqué pour ' + origin), false);
  },
  credentials: true,
});

// JWT
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET manquant ou trop court (min 32 chars)');
}
// M2 (pré-lancement) : on vérifie au DÉMARRAGE la présence des variables d'env critiques,
// pour repérer une mauvaise config Render AVANT qu'un client tombe sur un 500 ou un downgrade
// silencieux. WARN fort (pas de crash, sauf DATABASE_URL qui est vital pour éviter une panne).
{
  const REQUIRED = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY'];
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('⚠️  CONFIG INCOMPLÈTE — variables d\'env MANQUANTES sur Render : ' + missing.join(', ')
      + ' → paiements / IA / activation de plan risquent de CASSER. Vérifie aussi les 6 STRIPE_PRICE_*_MONTHLY/_ANNUAL.');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquant — démarrage impossible.');
  }
}
await app.register(jwt, { secret: process.env.JWT_SECRET });

// ── Cache de sessions valides (in-memory LRU, TTL 5 min) ────────────
// v1.3.4 (#3) : évite ~99% des hits DB sur authenticate. Pour 50 req/min/user
// on passe de ~250 SELECT/min à ~10/min. Invalidation par eviction TTL ou manuelle
// (logout / password reset) via sessionCache.invalidate(jti).
const SESSION_CACHE_MAX = 5000;     // ~50 KB RAM, suffisant pour SaaS early
const SESSION_CACHE_TTL_MS = 300000; // 5 minutes
const sessionCache = (() => {
  const map = new Map();
  return {
    get(jti) {
      const e = map.get(jti);
      if (!e) return null;
      if (Date.now() > e.exp) { map.delete(jti); return null; }
      // LRU touch : delete + set pour remettre en tête
      map.delete(jti); map.set(jti, e);
      return e.data;
    },
    set(jti, data) {
      // Eviction LRU si plein
      if (map.size >= SESSION_CACHE_MAX) {
        const oldest = map.keys().next().value;
        if (oldest) map.delete(oldest);
      }
      map.set(jti, { data, exp: Date.now() + SESSION_CACHE_TTL_MS });
    },
    invalidate(jti) { map.delete(jti); },
    invalidateUser(userId) {
      // Invalide tous les jti d'un user (utile sur logout-all / password reset)
      for (const [jti, e] of map.entries()) {
        if (e.data?.user_id === userId) map.delete(jti);
      }
    },
    size() { return map.size; },
  };
})();
app.decorate('sessionCache', sessionCache); // exposé aux routes pour invalidation explicite

// v1.3.4 (#3) : date à partir de laquelle les JWT sans jti sont rejetés.
// Permet de forcer la migration sans casser les sessions actives au moment du déploiement.
// 14 jours de grace après deploy (= max âge token légitime sans jti).
const LEGACY_JWT_CUTOFF = Date.parse(process.env.LEGACY_JWT_CUTOFF || '2026-05-15T00:00:00Z');

app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'non authentifié' });
  }

  const jti = req.user?.jti;
  const userId = req.user?.sub;

  // SÉCURITÉ : rejeter les JWT sans jti après la cutoff date.
  // Avant cette date : warn dans les logs mais accepter (transition).
  if (!jti) {
    if (Date.now() > LEGACY_JWT_CUTOFF) {
      return reply.code(401).send({ error: 'token obsolète, reconnecte-toi' });
    }
    req.log.warn({ user: userId, ua: req.headers['user-agent'] }, 'legacy JWT sans jti — accepté en grace period');
    return; // accept legacy
  }

  // Cache hit ? On évite l'aller-retour DB.
  let session = sessionCache.get(jti);
  if (!session) {
    session = await queryOne(
      `SELECT user_id, revoked_at, expires_at FROM sessions WHERE jti = $1`,
      [jti]
    );
    if (!session) return reply.code(401).send({ error: 'session invalide' });
    sessionCache.set(jti, session);
  }

  // SÉCURITÉ defense-in-depth : le user_id du JWT DOIT matcher celui de la session.
  // Empêche un attaquant qui forge un JWT avec un user_id différent mais un jti volé.
  if (session.user_id !== userId) {
    sessionCache.invalidate(jti);
    req.log.warn({ jwt_user: userId, db_user: session.user_id, jti }, 'JWT user_id mismatch session');
    return reply.code(401).send({ error: 'session invalide' });
  }
  if (session.revoked_at) {
    sessionCache.invalidate(jti);
    return reply.code(401).send({ error: 'session révoquée' });
  }
  // v1.3.7 : refus paiement = no access (sauf routes Stripe pour payer)
  // v1.3.49 (SECURITY P1-1) : refus email non vérifié pour les routes payantes/IA
  //   sur les comptes < 7 jours. Empêche un attaquant qui signup avec victim@gmail.com
  //   de consommer la quota IA / lancer un trial sans pouvoir accéder à l'email.
  if (req.url && !req.url.startsWith('/stripe/') && !req.url.startsWith('/api/stripe/') && !req.url.startsWith('/auth/')) {
    const u = await queryOne(
      'SELECT plan_status, email_verified, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (u && u.plan_status === 'past_due') {
      return reply.code(402).send({
        error: 'paiement_requis',
        reason: 'past_due',
        message: 'Ton dernier paiement a échoué. Va dans Support → Mon abonnement → Factures pour mettre à jour ta carte.'
      });
    }
    // Email gating : routes critiques bloquées si email pas vérifié sur compte récent
    if (u && u.email_verified === false) {
      const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
      if (ageDays < 7) {
        const critical = /^\/api\/(ai|clipboard)\//.test(req.url) || req.url.startsWith('/referral/');
        if (critical) {
          return reply.code(403).send({
            error: 'email_non_verifie',
            reason: 'verify_email_required',
            message: 'Vérifie ton email pour utiliser cette fonctionnalité. Code envoyé à ton adresse.'
          });
        }
      }
    }
  }
  // Stripe trial gating : email obligatoire avant de pouvoir start un trial 7j
  if (req.url && (req.url === '/stripe/start-trial' || req.url === '/stripe/create-checkout-session')) {
    const u = await queryOne(
      'SELECT email_verified, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (u && u.email_verified === false) {
      const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
      if (ageDays < 7) {
        return reply.code(403).send({
          error: 'email_non_verifie',
          reason: 'verify_email_required',
          message: 'Vérifie d\'abord ton email pour activer ton abonnement.'
        });
      }
    }
  }
  if (new Date(session.expires_at) < new Date()) {
    sessionCache.invalidate(jti);
    return reply.code(401).send({ error: 'session expirée' });
  }

  // Update last_activity_at en arrière-plan (non-bloquant, best-effort).
  // Throttle : on update au max 1x / 5 min par session (suffit pour analytics).
  if (!session._lastTouchAt || Date.now() - session._lastTouchAt > 300000) {
    session._lastTouchAt = Date.now();
    sessionCache.set(jti, session);
    setImmediate(() => {
      queryOne(`UPDATE sessions SET last_activity_at = NOW() WHERE jti = $1 RETURNING 1`, [jti])
        .catch(() => { /* silent : la colonne peut ne pas exister sur anciennes DB */ });
    });
  }
});

// Rate limit global — 60 req/min par IP par défaut
await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({ error: 'trop de requêtes, ralentis' }),
});

// Stripe webhook a besoin du body brut (signature)
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    if (req.routeOptions?.config?.rawBody) {
      req.rawBody = body;
      return done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    }
    return done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
  } catch (err) {
    err.statusCode = 400;
    done(err);
  }
});

// Global error handler — pas de leak de stack en prod
app.setErrorHandler((err, req, reply) => {
  req.log.error({ err, url: req.url }, 'request error');
  const status = err.statusCode || 500;
  // v1.3.4 (#2) : reporter à Sentry uniquement les vraies 5xx (pas les 4xx attendues)
  if (Sentry && status >= 500) {
    try {
      Sentry.captureException(err, {
        tags: { route: req.url, method: req.method },
        extra: { status, ip: req.ip },
      });
    } catch (e) { /* fail silently — pas casser la response */ }
  }
  const safeMessage = IS_PROD && status >= 500 ? 'Internal Server Error' : (err.message || 'error');
  reply.code(status).send({ error: safeMessage });
});

// Health check — utilisé par Render pour ping
// v1.3.4 (#2) : ajout uptime + version pour debug rapide
app.get('/', async () => ({ ok: true, service: 'astro-backend', version: '1.0.0' }));
app.get('/health', async () => ({
  ok: true,
  service: 'astro-backend',
  version: '1.0.0',
  uptime_s: Math.round(process.uptime()),
  sentry: !!Sentry,
  ts: new Date().toISOString(),
}));

// Routes
await app.register(authRoutes);
await app.register(stripeRoutes);
await app.register(aiRoutes);
await app.register(clipboardRoutes);
await app.register(referralRoutes);
// v1.3.4 (#9) : routes admin (auth + email check)
await app.register(adminRoutes);
await app.register(supportRoutes);

// Start
const port = parseInt(process.env.PORT || '8787', 10);
try {
  await app.listen({ host: '0.0.0.0', port });
  console.log(`🚀 Astro backend running on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
