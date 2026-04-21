// Routes : /auth/signup, /auth/login, /auth/me
import bcrypt from 'bcryptjs';
import { query, queryOne } from './db.js';

export default async function authRoutes(app) {
  // POST /auth/signup
  app.post('/auth/signup', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return reply.code(400).send({ error: 'email et password (8 chars min) requis' });
    }
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing) return reply.code(409).send({ error: 'email déjà utilisé' });

    const hash = await bcrypt.hash(password, 10);
    const [user] = await query(
      `INSERT INTO users (email, password_hash, plan, plan_status)
       VALUES ($1, $2, 'free', 'inactive')
       RETURNING id, email, plan, plan_status`,
      [email.toLowerCase().trim(), hash]
    );

    const token = app.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: '30d' });
    return { token, user };
  });

  // POST /auth/login
  app.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: 'email et password requis' });

    const user = await queryOne('SELECT id, email, password_hash, plan, plan_status, plan_expires_at FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (!user) return reply.code(401).send({ error: 'identifiants invalides' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return reply.code(401).send({ error: 'identifiants invalides' });

    const token = app.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: '30d' });
    delete user.password_hash;
    return { token, user };
  });

  // GET /auth/me — protégé
  app.get('/auth/me', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne(
      `SELECT id, email, plan, plan_status, plan_expires_at, stripe_customer_id, created_at
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    return { user };
  });
}
