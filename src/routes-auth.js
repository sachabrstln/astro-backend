// Routes auth : signup, login, me, logout, password-reset, email-verification
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
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
// v1.3.49 (SECURITY P1-2) : 30d → 7d. Réduit la fenêtre d'exploit d'un token volé.
// Un user qui se logge depuis Chrome reste connecté tant qu'il utilise l'extension
// (refresh implicite via re-login auto), 7j inactif = re-login (acceptable UX).
const JWT_EXPIRES = '7d';
const JWT_EXPIRES_DAYS = 7;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MIN = 30;
const RESET_EXPIRES_MIN = 60;
const VERIFY_EXPIRES_H = 48;
const FRONTEND = (process.env.FRONTEND_URL || 'https://astro-pro.app').replace(/\/$/, '');

// v1.3.7 — Anti-fraude C : domaines email jetables (extrait des plus utilisés)
// Liste maintenue manuellement, à étendre via https://github.com/disposable-email-domains
// Bloque les inscriptions multi-trial qui réutilisent le même device avec
// des adresses temporaires (mailinator, tempmail, guerrillamail, ...).
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  // Top 30 fournisseurs jetables connus (couvre ~95% du trafic abusif)
  '0-mail.com','027168.com','10minutemail.com','10minutemail.net','20minutemail.com',
  '33mail.com','dispostable.com','dropmail.me','emailondeck.com','fakemail.net',
  'fakeinbox.com','getairmail.com','getnada.com','grr.la','guerrillamail.com',
  'guerrillamail.net','guerrillamail.org','guerrillamailblock.com','harakirimail.com',
  'inboxbear.com','jetable.org','mail-temporaire.fr','mail7.io','mailcatch.com',
  'maildrop.cc','mailinator.com','mailinator.net','mailmoat.com','mailnesia.com',
  'mailnull.com','mintemail.com','mohmal.com','moot.es','mt2014.com','mt2015.com',
  'mvrht.com','nada.email','noclickemail.com','nwldx.com','outlawspam.com',
  'pookmail.com','sharklasers.com','spam4.me','spambox.us','spamfree24.org',
  'spamgourmet.com','spammotel.com','spamthisplease.com','tempemail.com',
  'tempinbox.com','tempmail.de','tempmail.it','tempmail.lol','tempmail.net',
  'tempmail.us','tempmailo.com','tempr.email','throwawaymail.com','trashmail.com',
  'trashmail.de','trashmail.fr','trashmail.io','trashmail.net','vomoto.com',
  'wegwerfmail.de','wegwerfmail.net','wegwerfmail.org','yopmail.com','yopmail.fr',
  'yopmail.net','zetmail.com','zilch.com','tmpmail.org','tmpmail.net','minutemail.com',
  'fakeemail.com','fake-email.com','tempinbox.xyz','disposable.email','tempmailaddress.com',
  'mailonaut.com','mailtothis.com','clipmails.com','clrmail.com','crymail.com',
  'easytrashmail.com','emailisvalid.com','emaillox.com','emaisl.com','emltmp.com',
  'getmaildrop.com','goemailgo.com','hide.biz.st','hmamail.com','jetable.com',
  'kasmail.com','linshiyou.com','mailcdn.io','mailcuk.com','maileater.com',
  'mailguard.me','mailimate.com','mailspeed.ru','migmail.pl','mosk.io',
  'nepwk.com','rejectmail.com','sendingstmail.com','tabamail.com','temptami.com',
]);

function validateEmail(email) {
  if (typeof email !== 'string') return 'email requis';
  const e = email.trim().toLowerCase();
  if (!e || e.length > EMAIL_MAX) return 'email invalide';
  if (!EMAIL_RE.test(e)) return 'format email invalide';
  // v1.3.7 : block disposable emails (anti-fraude trial multi)
  const domain = e.split('@')[1] || '';
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return 'merci d\'utiliser une adresse email permanente (les emails jetables ne sont pas acceptés)';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'password requis';
  if (password.length < PWD_MIN) return `mot de passe trop court (min ${PWD_MIN})`;
  if (password.length > PWD_MAX) return `mot de passe trop long (max ${PWD_MAX})`;
  // v1.3.2 : complexité renforcée — uppercase + lowercase + digit + symbole
  if (!/[A-Z]/.test(password)) return 'le mot de passe doit contenir au moins une majuscule';
  if (!/[a-z]/.test(password)) return 'le mot de passe doit contenir au moins une minuscule';
  if (!/[0-9]/.test(password)) return 'le mot de passe doit contenir au moins un chiffre';
  if (!/[^A-Za-z0-9]/.test(password)) return 'le mot de passe doit contenir au moins un caractère spécial';
  // Anti-trivial
  if (/^(password|motdepasse|123456|qwerty|azerty)/i.test(password)) {
    return 'mot de passe trop trivial, choisis-en un autre';
  }
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
  const expiresAt = new Date(Date.now() + JWT_EXPIRES_DAYS * 86400 * 1000);
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

  // v1.3.7 — Anti-fraude I : rate limit signup par IP
  // Max 2 inscriptions / 24h depuis la même IP, pour empêcher la création de
  // comptes en boucle pour cumuler les essais 7j gratuits.
  const signupIpLimit = {
    config: {
      rateLimit: {
        max: 2,
        timeWindow: '24 hours',
        keyGenerator: (req) => 'signup-ip:' + (req.ip || ''),
        errorResponseBuilder: () => ({
          error: 'limite d\'inscriptions atteinte pour ton réseau (2 par jour). Réessaye demain ou contacte le support si tu penses qu\'il y a une erreur.',
        }),
      },
    },
  };

  // ── POST /auth/signup ──────────────────────────────
  // Anti-fraude I : rate limit IP 2 signups / 24h. Plus strict que bruteforceLimit
  // (qui était 5/15min IP+email) — celui-ci empêche le multi-trial sur la même IP
  // même avec différents emails.
  app.post('/auth/signup', signupIpLimit, async (req, reply) => {
    const {
      email, password, captchaToken,
      acceptedTerms, acceptedTermsAt,
      waivedRightOfWithdrawal, waivedRightOfWithdrawalAt, termsVersion,
      referralCode,
    } = req.body || {};

    // v1.3.2 : acceptation explicite des CGU obligatoire (RGPD, traçabilité)
    if (acceptedTerms !== true) {
      return reply.code(400).send({ error: 'tu dois accepter les CGU et la politique de confidentialité' });
    }
    // v1.3.51 : renonciation expresse au droit de rétractation L221-28 13° C. conso
    // obligatoire pour démarrer le service immédiatement (sans délai 14 jours).
    if (waivedRightOfWithdrawal !== true) {
      return reply.code(400).send({ error: 'tu dois confirmer la renonciation au droit de rétractation pour activer le service' });
    }

    // Turnstile (avec bypass extension trustée via header X-Astro-Client + secret)
    const cap = await verifyTurnstile(captchaToken, req.ip, req);
    if (!cap.ok) {
      await audit(req, 'signup_captcha_fail', { reason: cap.reason });
      return reply.code(400).send({ error: 'captcha invalide' });
    }

    // Validation email + password
    const eErr = validateEmail(email);
    if (eErr) return reply.code(400).send({ error: eErr });
    const pErr = validatePassword(password);
    if (pErr) return reply.code(400).send({ error: pErr });

    // v1.3.8 : code parrainage 4-12 chars (custom user-chosen)
    let validReferralCode = null;
    if (referralCode && typeof referralCode === 'string') {
      const cleanRef = referralCode.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(cleanRef)) {
        return reply.code(400).send({ error: 'code de parrainage invalide' });
      }
      validReferralCode = cleanRef;
    }

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
    // v1.3.2 : politique "no pay = no service".
    // L'utilisateur est créé en plan='none' / status='inactive'. Aucun accès produit.
    // À l'étape suivante (POST /stripe/start-trial), il devra fournir une CB via Stripe Checkout
    // en mode subscription avec trial_period_days=7. À J+7, charge automatique du plan Ultra
    // sauf s'il a résilié dans son espace abonnement avant.
    const [user] = await query(
      `INSERT INTO users (email, password_hash, plan, plan_status, email_verified)
       VALUES ($1, $2, 'none', 'inactive', FALSE)
       RETURNING id, email, plan, plan_status, email_verified`,
      [cleanEmail, hash]
    );

    // v1.3.51 : traçabilité légale acceptation CGU + renonciation rétractation.
    // Stocké via audit_log (table existante, robuste, indexée user_id). Permet de
    // produire une preuve en cas de litige client (chargeback < 14j, demande CNIL).
    // Si tu veux migrer vers des colonnes dédiées dans users plus tard, faire
    // un job qui rapatrie les events 'signup_consent' vers users.consent_*.
    try {
      await audit(
        { user: { sub: user.id }, ip: req.ip || null, headers: req.headers || {} },
        'signup_consent',
        {
          acceptedTerms: true,
          acceptedTermsAt: acceptedTermsAt || new Date().toISOString(),
          waivedRightOfWithdrawal: true,
          waivedRightOfWithdrawalAt: waivedRightOfWithdrawalAt || new Date().toISOString(),
          termsVersion: termsVersion || 'unspecified',
        }
      );
    } catch (e) {
      // Pas bloquant — l'user est créé. On log juste l'incident.
      req.log.warn({ err: e.message, user_id: user.id }, 'audit signup_consent failed');
    }

    // v1.3.8 : si code parrainage valide fourni, link filleul ← parrain
    if (validReferralCode) {
      try {
        const ref = await import('./routes-referral.js');
        if (ref.linkReferralAtSignup) {
          await ref.linkReferralAtSignup(user.id, validReferralCode);
        }
      } catch (e) {
        // Échec du link (code invalide, self-referral, etc.) — on n'échoue PAS le signup
        // L'user est créé même sans lien parrainage
        req.log.warn({ err: e.message, code: validReferralCode }, 'linkReferralAtSignup failed');
      }
    }

    // v1.3.9 : code à 6 chiffres au lieu d'un lien (UX plus simple, anti-bot meilleure)
    // Le code expire dans 30 min. On stocke le hash du code en DB (anti-fuite).
    // v1.3.49 (SECURITY) : crypto.randomInt (CSPRNG) au lieu de Math.random() (prédictible)
    const verifCode = String(crypto.randomInt(100000, 1000000)); // 100000-999999
    const verifExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, hashToken(verifCode), verifExpires]
    );
    await sendEmail({
      to: user.email,
      subject: 'Ton code de vérification Astro : ' + verifCode,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#7F77DD;">Bienvenue sur Astro !</h2>
          <p>Merci d'avoir créé ton compte. Voici ton code de vérification :</p>
          <div style="margin:24px 0;padding:24px;background:#F7F6FF;border-radius:12px;text-align:center;">
            <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#5C54B8;font-family:'Courier New',monospace;">${verifCode}</div>
          </div>
          <p style="font-size:14px;color:#444;">Entre ce code dans la page d'inscription pour confirmer ton compte.</p>
          <p style="color:#888;font-size:12px;margin-top:24px;">Ce code expire dans <strong>30 minutes</strong>. Si tu n'es pas à l'origine de cette inscription, ignore simplement ce message — aucun compte n'est créé tant que le code n'est pas validé.</p>
        </div>`,
      text: `Ton code de vérification Astro : ${verifCode}\n\nCe code expire dans 30 minutes.`,
    });

    await audit(req, 'signup_success', { user_id: user.id });
    const token = await issueSession(app, user, req);
    return { token, user, emailVerificationSent: true };
  });

  // ── POST /auth/login ───────────────────────────────
  app.post('/auth/login', bruteforceLimit, async (req, reply) => {
    const { email, password, captchaToken } = req.body || {};
    const cap = await verifyTurnstile(captchaToken, req.ip, req);
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
      `SELECT id, email, plan, plan_billing, plan_status, plan_expires_at,
              email_verified, stripe_customer_id, created_at,
              trial_ultra_until, cancel_at, stripe_subscription_id
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    // v1.3.7 : alias UI-friendly pour la page Mon abonnement
    user.startedAt = user.created_at;
    user.currentPeriodEnd = user.plan_expires_at;
    user.cancelAtPeriodEnd = user.plan_status === 'active_cancelling' || !!user.cancel_at;
    user.billingCycle = user.plan_billing;
    return { user };
  });

  // ── POST /auth/logout ──────────────────────────────
  app.post('/auth/logout', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.jti) {
      await query(
        `UPDATE sessions SET revoked_at = NOW() WHERE jti = $1`,
        [req.user.jti]
      );
      // v1.3.4 (#3) : invalide le cache sessions pour que la révocation soit effective immédiatement
      try { app.sessionCache?.invalidate(req.user.jti); } catch (e) {}
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
    // v1.3.4 (#3) : purge tous les jti en cache pour ce user (immédiat)
    try { app.sessionCache?.invalidateUser(req.user.sub); } catch (e) {}
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
    // Révoque toutes les sessions existantes par sécurité (forcée — anti-account-takeover)
    await query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [reset.user_id]
    );
    // v1.3.4 (#3) : purge cache sessions pour ce user — invalidation immédiate
    try { app.sessionCache?.invalidateUser(reset.user_id); } catch (e) {}
    await audit(req, 'password_reset_completed', { user_id: reset.user_id });
    return { ok: true, message: 'Mot de passe mis à jour. Connecte-toi avec ton nouveau mot de passe.' };
  });

  // ── POST /auth/verify-email ────────────────────────
  // v1.3.9 : accepte SOIT un token long (legacy, compat liens email anciens)
  // SOIT un code à 6 chiffres (nouveau flow). Hash identique des deux côtés.
  app.post('/auth/verify-email', {
    config: {
      rateLimit: {
        max: 10, timeWindow: '15 minutes',
        keyGenerator: (req) => 'verify-email:' + (req.ip || ''),
        errorResponseBuilder: () => ({ error: 'trop d\'essais, attends 15 min' }),
      },
    },
  }, async (req, reply) => {
    const { token, code, email } = req.body || {};
    const value = String(token || code || '').trim();
    if (!value) return reply.code(400).send({ error: 'code ou token requis' });
    // Normalise code 6 chiffres (espaces, tirets autorisés à la saisie)
    const normalized = /^[0-9\s\-]+$/.test(value)
      ? value.replace(/[^0-9]/g, '')
      : value;
    if (normalized.length === 0) return reply.code(400).send({ error: 'code invalide' });

    const tokenHash = hashToken(normalized);
    // v1.3.9 : si email fourni, on filtre par user_id pour éviter qu'un mauvais code
    // matche par hasard un autre user (edge case mais propre).
    let verif;
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const u = await queryOne(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase().trim()]);
      if (u) {
        verif = await queryOne(
          `SELECT id, user_id, expires_at, used_at FROM email_verifications
           WHERE token_hash = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`,
          [tokenHash, u.id]
        );
      }
    } else {
      verif = await queryOne(
        `SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = $1 ORDER BY id DESC LIMIT 1`,
        [tokenHash]
      );
    }
    if (!verif || verif.used_at || new Date(verif.expires_at) < new Date()) {
      return reply.code(400).send({ error: 'code invalide ou expiré' });
    }
    await query(`UPDATE users SET email_verified = TRUE WHERE id = $1`, [verif.user_id]);
    await query(`UPDATE email_verifications SET used_at = NOW() WHERE id = $1`, [verif.id]);
    await audit(req, 'email_verified', { user_id: verif.user_id });
    return { ok: true, message: 'Email vérifié !' };
  });

  // ── POST /auth/resend-verification ─────────────────
  // v1.3.9 : renvoie un nouveau code 6 chiffres (au lieu d'un lien).
  app.post('/auth/resend-verification', {
    onRequest: [app.authenticate],
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const user = await queryOne(`SELECT id, email, email_verified FROM users WHERE id = $1`, [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    if (user.email_verified) return { ok: true, alreadyVerified: true };

    // v1.3.49 (SECURITY) : crypto.randomInt (CSPRNG)
    const verifCode = String(crypto.randomInt(100000, 1000000));
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, hashToken(verifCode), expires]
    );
    await sendEmail({
      to: user.email,
      subject: 'Nouveau code de vérification Astro : ' + verifCode,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#7F77DD;">Nouveau code de vérification</h2>
        <div style="margin:24px 0;padding:24px;background:#F7F6FF;border-radius:12px;text-align:center;">
          <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#5C54B8;font-family:'Courier New',monospace;">${verifCode}</div>
        </div>
        <p style="font-size:14px;color:#444;">Entre ce code dans Astro pour confirmer ton compte.</p>
        <p style="color:#888;font-size:12px;margin-top:16px;">Ce code expire dans <strong>30 minutes</strong>.</p>
      </div>`,
      text: `Ton code de vérification Astro : ${verifCode}\n\nCe code expire dans 30 minutes.`
    });
    return { ok: true };
  });
}
