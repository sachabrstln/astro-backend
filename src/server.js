// Entrée serveur Fastify — charge tous les plugins + routes
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import authRoutes from './routes-auth.js';
import stripeRoutes from './routes-stripe.js';
import aiRoutes from './routes-ai.js';

const app = Fastify({
  logger: process.env.NODE_ENV === 'production' ? true : { transport: { target: 'pino-pretty' } },
  bodyLimit: 15 * 1024 * 1024 // 15MB (pour photos base64)
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
      'http://localhost:5173'
    ].filter(Boolean);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS bloqué pour ' + origin), false);
  },
  credentials: true
});

// JWT
await app.register(jwt, { secret: process.env.JWT_SECRET });
app.decorate('authenticate', async (req, reply) => {
  try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'non authentifié' }); }
});

// Rate limit — 60 req/min par IP par défaut
await app.register(rateLimit, {
  max: 60, timeWindow: '1 minute',
  errorResponseBuilder: () => ({ error: 'trop de requêtes, ralentis' })
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
