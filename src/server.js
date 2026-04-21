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
import { queryOne } from './db.js';

const IS_PROD = process.env.NODE_ENV === 'production';

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

// CORS — autorise extension Chrome + site public
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.startsWith('chrome-extension://')) return cb(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      'https://astro-vinted.com',
      'https://www.astro-vinted.com',
      'http://localhost:3000',
      'http://localhost:5173',
    ].filter(Boolean);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS bloqué pour ' + origin), false);
  },
  credentials: true,
});

// JWT
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET manquant ou trop court (min 32 chars)');
}
await app.register(jwt, { secret: process.env.JWT_SECRET });
app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'non authentifié' });
  }
  // SÉCURITÉ : vérifier que la session n'a pas été révoquée (logout, password reset, etc.)
  const jti = req.user?.jti;
  if (jti) {
    const session = await queryOne(
      `SELECT revoked_at, expires_at FROM sessions WHERE jti = $1`,
      [jti]
    );
    if (!session) return reply.code(401).send({ error: 'session invalide' });
    if (session.revoked_at) return reply.code(401).send({ error: 'session révoquée' });
    if (new Date(session.expires_at) < new Date()) return reply.code(401).send({ error: 'session expirée' });
  }
  // Note : les anciens JWT sans jti (emis avant cette migration) restent valides jusqu'à leur exp naturelle
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
  const safeMessage = IS_PROD && status >= 500 ? 'Internal Server Error' : (err.message || 'error');
  reply.code(status).send({ error: safeMessage });
});

// Health check
app.get('/', async () => ({ ok: true, service: 'astro-backend', version: '1.0.0' }));
app.get('/health', async () => ({ ok: true }));

// Routes
await app.register(authRoutes);
await app.register(stripeRoutes);
await app.register(aiRoutes);

// Start
const port = parseInt(process.env.PORT || '8787', 10);
try {
  await app.listen({ host: '0.0.0.0', port });
  console.log(`🚀 Astro backend running on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
