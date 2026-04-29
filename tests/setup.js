// Fixtures + helpers communs pour les tests backend.
// Utilisé par : tests/auth.test.js, tests/*.test.js
//
// PRÉREQUIS pour faire tourner les tests :
//   - DATABASE_URL pointant vers une DB de test (PAS la prod !)
//   - JWT_SECRET ≥ 32 chars (ex: openssl rand -hex 32)
//   - Migrations à jour : `npm run migrate`
//
// Lancer : `npm test`
import 'dotenv/config';

// Validation minimale env avant de toucher la DB
export function ensureTestEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL manquant — copie .env.test depuis .env et fournis une DB de test');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET manquant ou trop court');
  }
  // Sanity check : on refuse de tourner contre une DB prod (heuristique)
  if (/prod|production/i.test(process.env.DATABASE_URL || '')) {
    throw new Error('DATABASE_URL semble pointer vers la prod — ABORT (renomme ta DB de test)');
  }
}

// Génère un email unique pour éviter les collisions inter-tests
export function uniqueEmail(prefix = 'test') {
  return `${prefix}+${Date.now()}-${Math.floor(Math.random() * 1e6)}@astro-tests.local`;
}

// Mot de passe valide selon les règles de signup (10+ chars, complexité)
export const VALID_PASSWORD = 'TestPwd!2026Astro';

// Construit l'app Fastify exactement comme server.js mais en mode test
// (logger silencieux, pas de listen). Utilisable via app.inject().
export async function buildTestApp() {
  ensureTestEnv();

  const Fastify = (await import('fastify')).default;
  const cors = (await import('@fastify/cors')).default;
  const helmet = (await import('@fastify/helmet')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  const authRoutes = (await import('../src/routes-auth.js')).default;
  const adminRoutes = (await import('../src/routes-admin.js')).default;
  const { queryOne } = await import('../src/db.js');

  const app = Fastify({ logger: false });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET });

  // v1.3.4 (#3) : authenticate aligné sur server.js — defense in depth
  // (check user_id mismatch + invalidation par jti).
  // Pas de cache LRU en test (on veut que les tests voient les changements DB immédiatement).
  const sessionCacheStub = {
    get: () => null,
    set: () => {},
    invalidate: () => {},
    invalidateUser: () => {},
  };
  app.decorate('sessionCache', sessionCacheStub);

  app.decorate('authenticate', async (req, reply) => {
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'non authentifié' }); }
    const jti = req.user?.jti;
    const userId = req.user?.sub;
    if (!jti) return; // legacy JWT (pas de session DB associée) — accepté en grace period
    const session = await queryOne(
      `SELECT user_id, revoked_at, expires_at FROM sessions WHERE jti = $1`, [jti]
    );
    if (!session) return reply.code(401).send({ error: 'session invalide' });
    if (session.user_id !== userId) return reply.code(401).send({ error: 'session invalide' });
    if (session.revoked_at) return reply.code(401).send({ error: 'session révoquée' });
    if (new Date(session.expires_at) < new Date()) return reply.code(401).send({ error: 'session expirée' });
  });

  // Rate-limit DÉSACTIVÉ en tests (sinon les répétitions échouent)
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });

  await app.register(authRoutes);
  await app.register(adminRoutes);

  return app;
}

// Cleanup d'un user créé pendant un test (par email)
export async function cleanupUser(email) {
  if (!email) return;
  const { query } = await import('../src/db.js');
  try {
    // ON DELETE CASCADE devrait nettoyer sessions + email_verifs + password_resets
    await query(`DELETE FROM users WHERE email = $1`, [email.toLowerCase()]);
  } catch (err) {
    // Ne pas faire crasher le test si cleanup foire (DB peut être en read-only en tests)
    console.warn('[cleanupUser] failed:', err.message);
  }
}
