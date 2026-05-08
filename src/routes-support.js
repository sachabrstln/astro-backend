// ═══════════════════════════════════════════════════════════════
// Routes Support v1.3.7
// - POST /api/support/contact : ticket contact
// - POST /api/support/bug : rapport de bug
// ═══════════════════════════════════════════════════════════════
import { query, queryOne } from './db.js';

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 5000;
const MAX_BUG_TITLE = 200;
const MAX_BUG_DESC = 5000;

// Sanitize : enlève les caractères de contrôle, limite la taille
function sanitize(s, maxLen) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

export default async function supportRoutes(app) {
  // ── POST /api/support/contact — ticket contact (auth requise) ───
  app.post('/api/support/contact', {
    onRequest: [app.authenticate],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => 'support-contact:' + (req.user?.sub || req.ip),
      },
    },
  }, async (req, reply) => {
    const subject = sanitize(req.body?.subject, MAX_SUBJECT);
    const message = sanitize(req.body?.message, MAX_MESSAGE);
    const replyEmail = sanitize(req.body?.replyEmail, 254);
    if (subject.length < 3 || message.length < 10) {
      return reply.code(400).send({ error: 'subject et message requis (min 3/10 chars)' });
    }
    if (!replyEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) {
      return reply.code(400).send({ error: 'email de réponse valide requis' });
    }
    const user = await queryOne('SELECT id, email FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    const ua = (req.headers['user-agent'] || '').slice(0, 300);
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

    // v1.3.7 : on stocke le replyEmail (pour pouvoir répondre directement) dans la colonne email
    // Le user.email reste accessible via user_id JOIN si besoin.
    await query(
      `INSERT INTO support_messages (user_id, email, subject, message, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, replyEmail, subject, message, ip, ua]
    );
    app.log.info({ userId: user.id, subject: subject.slice(0, 50) }, 'support contact');
    return { ok: true };
  });

  // ── POST /api/support/bug — rapport de bug (auth requise) ────────
  app.post('/api/support/bug', {
    onRequest: [app.authenticate],
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req) => 'support-bug:' + (req.user?.sub || req.ip),
      },
    },
  }, async (req, reply) => {
    const title = sanitize(req.body?.title, MAX_BUG_TITLE);
    const description = sanitize(req.body?.description, MAX_BUG_DESC);
    const replyEmail = sanitize(req.body?.replyEmail, 254);
    if (title.length < 3 || description.length < 10) {
      return reply.code(400).send({ error: 'title et description requis (min 3/10 chars)' });
    }
    if (!replyEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) {
      return reply.code(400).send({ error: 'email de réponse valide requis' });
    }
    // Meta : on accepte un objet plat de strings/numbers, on cap la taille totale.
    let meta = req.body?.meta || {};
    if (typeof meta !== 'object' || Array.isArray(meta)) meta = {};
    const cleanMeta = { replyEmail };
    for (const k of Object.keys(meta).slice(0, 20)) {
      const v = meta[k];
      if (typeof v === 'string') cleanMeta[k] = v.slice(0, 500);
      else if (typeof v === 'number' || typeof v === 'boolean') cleanMeta[k] = v;
    }
    const user = await queryOne('SELECT id FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

    // Auto-priorité : si "crash", "broken", "data loss" → high
    const lower = (title + ' ' + description).toLowerCase();
    let priority = 'normal';
    if (/crash|data loss|perdu|cassé|impossible/.test(lower)) priority = 'high';

    await query(
      `INSERT INTO support_bugs (user_id, title, description, meta, ip_address, priority)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, title, description, JSON.stringify(cleanMeta), ip, priority]
    );
    app.log.info({ userId: user.id, title: title.slice(0, 50), priority }, 'bug report');
    return { ok: true };
  });
}
