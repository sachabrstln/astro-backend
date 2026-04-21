// Routes auth : signup, login, me, logout, password-reset, email-verification
import bcrypt from 'bcryptjs';
import { query, queryOne } from './db.js';
import {
  verifyTurnstile, isPasswordPwned, generateToken, hashToken,
  generateJti, sendEmail, audit,
} from './security.js';

// ── Config ─────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const PWD_MIN = 10; // renforcé pour prod publique
const PWD_MAX = 128;
const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES = '30d';
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MIN = 30;
const RESET_EXPIRES_MIN = 60;
const VERIFY_EXPIRES_H = 48;
const FRONTEND = (process.env.FRONTEND_URL || 'https://astro-vinted.com').replace(/\/$/, '');

function validateEmail(email) {
  if (typeof email !== 'string') return 'email requis';
  const e = email.trim().toLowerCase();
  if (!e || e.length > EMAIL_MAX) return 'email invalide';
  if (!EMAIL_RE.test(e)) return 'format email invalide';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'password requis';
  if (password.length < PWD_MIN) return `mot de passe trop court (min ${PWD_MIN})`;
  if (password.length > PWD_MAX) return `mot de passe trop long (max ${PWD_MAX})`;
  // Complexité : au moins 1 lettre + 1 chiffre
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'le mot de passe doit contenir au moins une lettre et un chiffre';
  }
  return null;
}

// Issue JWT + enregistre la session
async function issueSession(app, user, req) {
  const jti = generateJti();
  const token = app.jwt.sign(
    { sub: user.id, email: user.email, jti },
    { expiresIn: JWT_EXPIRES }
  );
  // 30 jours
  const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);
  await query(
    `INSERT INTO sessions (user_id, jti, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [user.id, jti, req.ip || null, (req.headers?.['user-agent'] || '').slice(0, 500), expiresAt]
  );
  return token;
}

export default async function authRoutes(app) {
  // Rate-limit anti-bruteforce : 5 essais / 15 min / (IP+email)
  const bruteforceLimit = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => {
          const email = (req.body?.email || '').toLowerCase().trim();
          return (req.ip || '') + ':' + email;
        },
        errorResponseBuilder: () => ({ error: 'trop de tentatives, réessaye dans 15 min' }),
      },
    },
  };

  // ── POST /auth/signup ──────────────────────────────
  app.post('/auth/signup', bruteforceLimit, async (req, reply) => {
    const { email, password, captchaToken } = req.body || {};

    // Turnstile
    const cap = await verifyTurnstile(captchaToken, req.ip);
    if (!cap.ok) {
      await audit(req, 'signup_captcha_fail', { reason: cap.reason });
      return reply.code(400).send({ error: 'captcha invalide' });
    }

    // Validation email + password
    const eErr = validateEmail(email);
    if (eErr) return reply.code(400).send({ error: eErr });
    const pErr = validatePassword(password);
    if (pErr) return reply.code(400).send({ error: pErr });

    // Check HIBP (mot de passe fuité)
    if (await isPasswordPwned(password)) {
      return reply.code(400).send({
        error: 'ce mot de passe apparaît dans une fuite de données connue, choisis-en un autre',
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing) {
      // Ne pas révéler que l'email existe — message générique
      await audit(req, 'signup_email_taken', { email: cleanEmail });
      return reply.code(409).send({ error: 'impossible de créer ce compte' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [user] = await query(
      `INSERT INTO users (email, password_hash, plan, plan_status, email_verified)
       VALUES ($1, $2, 'free', 'inactive', FALSE)
       RETURNING id, email, plan, plan_status, email_verified`,
      [cleanEmail, hash]
    );

    // Token de vérif email
    const verifToken = generateToken();
    const verifExpires = new Date(Date.now() + VERIFY_EXPIRES_H * 3600 * 1000);
    await query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, hashToken(verifToken), verifExpires]
    );
    const verifUrl = `${FRONTEND}/verify-email?token=${verifToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Confirme ton email — Astro',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#7F77DD;">Bienvenue sur Astro !</h2>
          <p>Merci d'avoir créé ton compte. Clique sur le lien ci-dessous pour confirmer ton email :</p>
          <p><a href="${verifUrl}" style="display:inline-block;padding:12px 24px;background:#7F77DD;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Confirmer mon email</a></p>
          <p style="color:#666;font-size:13px;">Ce lien expire dans ${VERIFY_EXPIRES_H}h. Si tu n'es pas à l'origine de cette inscription, ignore simplement ce message.</p>
        </div>`,
      text: `Bienvenue sur Astro. Confirme ton email : ${verifUrl}`,
    });

    await audit(req, 'signup_success', { user_id: user.id });
    const token = await issueSession(app, user, req);
    return { token, user, emailVerificationSent: true };
  });

  // ── POST /auth/login ───────────────────────────────
  app.post('/auth/login', bruteforceLimit, async (req, reply) => {
    const { email, password, captchaToken } = req.body || {};
    const cap = await verifyTurnstile(captchaToken, req.ip);
    if (!cap.ok) return reply.code(400).send({ error: 'captcha invalide' });

    const eErr = validateEmail(email);
    if (eErr) return reply.code(400).send({ error: 'identifiants invalides' });
    if (typeof password !== 'string' || !password) {
      return reply.code(400).send({ error: 'identifiants invalides' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await queryOne(
      `SELECT id, email, password_hash, plan, plan_status, plan_expires_at, email_verified,
              failed_login_count, locked_until
       FROM users WHERE email = $1`,
      [cleanEmail]
    );

    // Vérifier lockout
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      await audit(req, 'login_locked', { user_id: user.id });
      return reply.code(423).send({ error: 'compte temporairement verrouillé, réessaye plus tard' });
    }

    // Toujours hasher même si user absent (timing-attack)
    const dummyHash = '$2a$12$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTUV';
    const ok = await bcrypt.compare(password, user?.password_hash || dummyHash);

    if (!user || !ok) {
      // Incrémenter compteur + lockout si seuil atteint
      if (user) {
        const newCount = user.failed_login_count + 1;
        const lockUntil = newCount >= LOCKOUT_THRESHOLD
          ? new Date(Date.now() + LOCKOUT_DURATION_MIN * 60 * 1000)
          : null;
        await query(
          `UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
          [newCount, lockUntil, user.id]
        );
        if (lockUntil) await audit(req, 'login_lockout_triggered', { user_id: user.id });
      }
      await audit(req, 'login_fail', { email: cleanEmail });
      return reply.code(401).send({ error: 'identifiants invalides' });
    }

    // Succès : reset compteur + issue JWT
    await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await audit(req, 'login_success', { user_id: user.id });

    const token = await issueSession(app, user, req);
    delete user.password_hash;
    delete user.failed_login_count;
    delete user.locked_until;
    return { token, user };
  });

  // ── GET /auth/me ───────────────────────────────────
  app.get('/auth/me', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne(
      `SELECT id, email, plan, plan_status, plan_expires_at, email_verified, stripe_customer_id, created_at
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    return { user };
  });

  // ── POST /auth/logout ──────────────────────────────
  app.post('/auth/logout', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.jti) {
      await query(
        `UPDATE sessions SET revoked_at = NOW() WHERE jti = $1`,
        [req.user.jti]
      );
    }
    await audit(req, 'logout', { user_id: req.user.sub });
    return { ok: true };
  });

  // ── POST /auth/logout-all ──────────────────────────
  app.post('/auth/logout-all', { onRequest: [app.authenticate] }, async (req, reply) => {
    await query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.user.sub]
    );
    await audit(req, 'logout_all', { user_id: req.user.sub });
    return { ok: true };
  });

  // ── POST /auth/password-reset/request ──────────────
  app.post('/auth/password-reset/request', {
    config: {
      rateLimit: { max: 3, timeWindow: '15 minutes' },
    },
  }, async (req, reply) => {
    const { email, captchaToken } = req.body || {};
    const cap = await verifyTurnstile(captchaToken, req.ip);
    if (!cap.ok) return reply.code(400).send({ error: 'captcha invalide' });

    const eErr = validateEmail(email);
    if (eErr) return reply.code(400).send({ error: eErr });

    const cleanEmail = email.trim().toLowerCase();
    const user = await queryOne(`SELECT id, email FROM users WHERE email = $1`, [cleanEmail]);

    // Réponse TOUJOURS OK pour éviter l'énumération d'emails
    if (user) {
      const resetToken = generateToken();
      const expires = new Date(Date.now() + RESET_EXPIRES_MIN * 60 * 1000);
      await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES ($1, $2, $3, $4)`,
        [user.id, hashToken(resetToken), expires, req.ip || null]
      );
      const resetUrl = `${FRONTEND}/reset-password?token=${resetToken}`;
      await sendEmail({
        to: user.email,
        subject: 'Réinitialisation de ton mot de passe — Astro',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
            <h2 style="color:#7F77DD;">Réinitialisation de mot de passe</h2>
            <p>Tu as demandé à réinitialiser ton mot de passe. Clique sur le lien ci-dessous :</p>
            <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#7F77DD;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Choisir un nouveau mot de passe</a></p>
            <p style="color:#666;font-size:13px;">Ce lien expire dans ${RESET_EXPIRES_MIN} minutes. Si tu n'as pas fait cette demande, ignore ce message.</p>
          </div>`,
        text: `Réinitialisation de mot de passe Astro : ${resetUrl}`,
      });
      await audit(req, 'password_reset_requested', { user_id: user.id });
    }
    return { ok: true, message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.' };
  });

  // ── POST /auth/password-reset/confirm ──────────────
  app.post('/auth/password-reset/confirm', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const { token, newPassword } = req.body || {};
    if (!token || typeof token !== 'string') return reply.code(400).send({ error: 'token requis' });
    const pErr = validatePassword(newPassword);
    if (pErr) return reply.code(400).send({ error: pErr });
    if (await isPasswordPwned(newPassword)) {
      return reply.code(400).send({ error: 'ce mot de passe a été exposé dans une fuite de données' });
    }

    const tokenHash = hashToken(token);
    const reset = await queryOne(
      `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1`,
      [tokenHash]
    );
    if (!reset || reset.used_at || new Date(reset.expires_at) < new Date()) {
      return reply.code(400).send({ error: 'token invalide ou expiré' });
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(),
                         failed_login_count = 0, locked_until = NULL WHERE id = $2`,
      [hash, reset.user_id]
    );
    await query(`UPDATE password_resets SET used_at = NOW() WHERE id = $1`, [reset.id]);
    // Révoque toutes les sessions existantes par sécurité
    await query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [reset.user_id]
    );
    await audit(req, 'password_reset_completed', { user_id: reset.user_id });
    return { ok: true, message: 'Mot de passe mis à jour. Connecte-toi avec ton nouveau mot de passe.' };
  });

  // ── POST /auth/verify-email ────────────────────────
  app.post('/auth/verify-email', async (req, reply) => {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') return reply.code(400).send({ error: 'token requis' });
    const tokenHash = hashToken(token);
    const verif = await queryOne(
      `SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = $1`,
      [tokenHash]
    );
    if (!verif || verif.used_at || new Date(verif.expires_at) < new Date()) {
      return reply.code(400).send({ error: 'token invalide ou expiré' });
    }
    await query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [verif.user_id]);
    await query(`UPDATE email_verifications SET used_at = NOW() WHERE id = $1`, [verif.id]);
    await audit(req, 'email_verified', { user_id: verif.user_id });
    return { ok: true, message: 'Email vérifié !' };
  });

  // ── POST /auth/resend-verification ─────────────────
  app.post('/auth/resend-verification', {
    onRequest: [app.authenticate],
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const user = await queryOne(`SELECT id, email, email_verified FROM users WHERE id = $1`, [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    if (user.email_verified) return { ok: true, alreadyVerified: true };

    const verifToken = generateToken();
    const expires = new Date(Date.now() + VERIFY_EXPIRES_H * 3600 * 1000);
    await query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, hashToken(verifToken), expires]
    );
    const verifUrl = `${FRONTEND}/verify-email?token=${verifToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Confirme ton email — Astro',
      html: `<p>Clique pour confirmer : <a href="${verifUrl}">${verifUrl}</a></p>`,
      text: `Confirme : ${verifUrl}`,
    });
    await audit(req, 'email_verification_resent', { user_id: user.id });
    return { ok: true };
  });
}
