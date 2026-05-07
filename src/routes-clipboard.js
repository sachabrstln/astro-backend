// ════════════════════════════════════════════════════════════════
// Astro — Routes "Clipboard" (Copier-Coller multi-comptes Vinted)
// ════════════════════════════════════════════════════════════════
// Feature : l'user sélectionne des annonces sur compte A, l'IA
// détoure les photos, l'extension recompose avec un nouveau fond
// + transforms anti-pHash, puis l'user les colle sur compte B.
//
// Ce fichier expose les endpoints AI nécessaires à la pipeline :
//  - POST /api/ai/bg-swap        → détoure une photo via Replicate
//  - GET  /api/ai/bg-swap/quota  → renvoie quota courant pour l'UI
//
// Le compositing avec le nouveau fond + les transforms anti-pHash
// (zoom, rotation, JPEG re-encode, EXIF strip) sont faits côté
// extension (Canvas API). Le backend ne fait QUE l'appel IA coûteux.
//
// Stockage des photos : chrome.storage.local (permission unlimitedStorage).
// Le backend ne stocke aucune photo — uniquement la trace usage en DB.
//
// Provider : Replicate (par défaut modèle "851-labs/background-remover",
// override via env REPLICATE_BG_MODEL pour migrer vers bria/rmbg-2.0).
// ════════════════════════════════════════════════════════════════

import { query, queryOne } from './db.js';
import { PLANS } from './plans.js';
import { audit } from './security.js';

const IS_PROD = process.env.NODE_ENV === 'production';
const REPLICATE_API_BASE = 'https://api.replicate.com/v1';

// Modèle par défaut : 851-labs/background-remover (bon ratio qualité/prix
// sur Replicate, ~$0.0015/run). Pour passer en premium (Bria 2.0, ~$0.05/run)
// override via REPLICATE_BG_MODEL=bria/rmbg-2.0 sur Render.
const DEFAULT_MODEL = process.env.REPLICATE_BG_MODEL || '851-labs/background-remover';

// Coût estimé par appel pour la trace usage (centimes USD).
const COST_PER_CALL_USD = parseFloat(process.env.REPLICATE_BG_COST_USD || '0.05');

// Limites taille input (base64). 8 MB de base64 ≈ 6 MB binaire — large pour
// une photo Vinted 4K compressée JPEG.
const MAX_INPUT_B64_SIZE = 8 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────
// Replicate helper : crée une prédiction en mode "wait synchrone",
// fallback en polling si le sync timeout. Renvoie l'image traitée
// en base64 + mediaType + taille.
// ─────────────────────────────────────────────────────────────
async function removeBackgroundReplicate(imageBase64, mediaType, log) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    const err = new Error('REPLICATE_API_TOKEN_MISSING');
    err.code = 'config';
    throw err;
  }

  const dataUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;
  const startedAt = Date.now();

  // Étape 0 : récupérer la latest version du modèle. Le endpoint
  // /v1/models/{owner}/{name}/predictions retourne 404 si le modèle
  // n'a pas de "default version" publiée — c'est le cas pour 851-labs.
  // On résout en faisant un GET /v1/models/{owner}/{name} → on récupère
  // latest_version.id, puis POST /v1/predictions avec version explicite.
  let latestVersion;
  try {
    const modelInfoRes = await fetch(`${REPLICATE_API_BASE}/models/${DEFAULT_MODEL}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!modelInfoRes.ok) {
      const errText = await modelInfoRes.text().catch(() => '');
      const err = new Error(`replicate_${modelInfoRes.status}`);
      err.detail = 'model_info: ' + errText.slice(0, 200);
      err.statusCode = modelInfoRes.status;
      throw err;
    }
    const modelInfo = await modelInfoRes.json();
    latestVersion = modelInfo.latest_version && modelInfo.latest_version.id;
    if (!latestVersion) {
      const err = new Error('replicate_no_version');
      err.detail = 'model has no latest_version';
      throw err;
    }
  } catch (e) {
    if (e.message && e.message.startsWith('replicate_')) throw e;
    const err = new Error('replicate_network');
    err.detail = e.message;
    throw err;
  }

  // Étape 1 : créer la prédiction avec version EXPLICITE.
  // /v1/predictions accepte n'importe quel modèle public/privé via version.
  const createUrl = `${REPLICATE_API_BASE}/predictions`;
  let createRes;
  try {
    createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=60',
      },
      body: JSON.stringify({ version: latestVersion, input: { image: dataUrl } }),
    });
  } catch (e) {
    const err = new Error('replicate_network');
    err.detail = e.message;
    throw err;
  }

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    const err = new Error(`replicate_${createRes.status}`);
    err.detail = errText.slice(0, 300);
    err.statusCode = createRes.status;
    throw err;
  }

  let prediction;
  try {
    prediction = await createRes.json();
  } catch (e) {
    throw new Error('replicate_bad_json');
  }

  // Étape 2 : si Prefer:wait n'a pas eu le temps, polling jusqu'à 60s total
  const POLL_INTERVAL_MS = 1500;
  const MAX_TOTAL_MS = 60000;
  while (
    prediction.status !== 'succeeded' &&
    prediction.status !== 'failed' &&
    prediction.status !== 'canceled' &&
    (Date.now() - startedAt) < MAX_TOTAL_MS
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollUrl = prediction?.urls?.get;
    if (!pollUrl) break;
    try {
      const pollRes = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (pollRes.ok) prediction = await pollRes.json();
    } catch (_) { /* on retente au prochain tick */ }
  }

  if (prediction.status !== 'succeeded') {
    const err = new Error('replicate_failed');
    err.detail = prediction.error || prediction.status || 'unknown';
    throw err;
  }

  // Étape 3 : output Replicate = URL ou Array(URL) selon le modèle.
  // On télécharge l'image et on la renvoie au client en base64.
  const out = prediction.output;
  const outputUrl = Array.isArray(out) ? out[0] : (typeof out === 'string' ? out : null);
  if (!outputUrl) {
    throw new Error('replicate_no_output');
  }

  let imgRes;
  try {
    imgRes = await fetch(outputUrl);
  } catch (e) {
    const err = new Error('replicate_output_fetch');
    err.detail = e.message;
    throw err;
  }
  if (!imgRes.ok) throw new Error(`output_fetch_${imgRes.status}`);

  const arrayBuf = await imgRes.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  log?.info?.({
    sizeBytes: buf.length,
    tookMs: Date.now() - startedAt,
    model: DEFAULT_MODEL,
  }, 'bg-swap success');

  return {
    base64: buf.toString('base64'),
    mediaType: imgRes.headers.get('content-type') || 'image/png',
    sizeBytes: buf.length,
    tookMs: Date.now() - startedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// Helper : compte les bg-swap consommés par l'user dans le mois
// courant (TZ Europe/Paris implicite — date_trunc Postgres en UTC,
// suffisant pour l'usage métier).
// ─────────────────────────────────────────────────────────────
async function getMonthlyUsage(userId) {
  const rows = await query(
    `SELECT COUNT(*)::int AS count FROM ai_usage
     WHERE user_id = $1 AND kind = 'bg-swap'
       AND created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  return rows?.[0]?.count || 0;
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
export default async function clipboardRoutes(app) {
  // ─────── POST /api/ai/bg-swap ──────────────────────────────
  // Body : { image_b64: string, mediaType?: 'image/jpeg'|'image/png'|'image/webp' }
  // Réponse : { ok, image_b64 (PNG transparent), mediaType, sizeBytes, tookMs }
  app.post('/api/ai/bg-swap', {
    onRequest: [app.authenticate],
    bodyLimit: 10 * 1024 * 1024, // un peu de marge au-dessus de MAX_INPUT_B64_SIZE
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (req) => 'bg-swap:' + (req.user?.sub || req.ip),
        errorResponseBuilder: () => ({ error: 'trop de détourages, attends 1 minute' }),
      },
    },
  }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'auth requis' });

    // 1. Vérif user
    const user = await queryOne(
      'SELECT id, plan, plan_status FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    // v1.3.7 : strategie quota = packs d'abord, abo ensuite.
    //  - Si l'user a des credits packs valides → on consomme 1 credit pack (FIFO)
    //  - Sinon si abo Ultra actif → on consomme 1 du quota mensuel
    //  - Sinon → 402/403 avec hint vers achat pack
    const planDef = PLANS[user.plan] || {};
    const monthlyLimit = planDef.bgSwapMonthly || 0;
    const subActive = user.plan_status === 'active' || user.plan_status === 'trialing';

    // Récupère le pack le plus vieux non-expiré (FIFO consommation)
    const packRow = await queryOne(
      `SELECT id, remaining FROM pack_credits
       WHERE user_id = $1 AND expires_at > NOW() AND remaining > 0
       ORDER BY expires_at ASC LIMIT 1`,
      [user.id]
    );

    let consumeFrom = null; // 'pack' | 'subscription'
    let packIdToDebit = null;

    if (packRow) {
      consumeFrom = 'pack';
      packIdToDebit = packRow.id;
    } else if (subActive && monthlyLimit > 0) {
      // Pas de pack → fallback sur quota mensuel (Ultra)
      if (monthlyLimit !== Infinity) {
        const used = await getMonthlyUsage(user.id);
        if (used >= monthlyLimit) {
          return reply.code(429).send({
            error: 'quota mensuel atteint',
            used,
            limit: monthlyLimit,
            hint: 'Achète un pack Multipost IA pour continuer ce mois-ci',
          });
        }
      }
      consumeFrom = 'subscription';
    } else {
      // Ni pack ni abo Ultra actif → bloque + suggère achat pack
      return reply.code(402).send({
        error: 'aucun crédit Multipost IA disponible',
        plan: user.plan,
        plan_status: user.plan_status,
        hint: 'Achète un pack Multipost IA dans ton dashboard ou passe à Ultra',
      });
    }

    // 4. Validation body
    const { image_b64, mediaType } = req.body || {};
    if (!image_b64 || typeof image_b64 !== 'string') {
      return reply.code(400).send({ error: 'image_b64 requis' });
    }
    if (image_b64.length > MAX_INPUT_B64_SIZE) {
      return reply.code(400).send({ error: 'image > 6 MB' });
    }
    if (mediaType && !/^image\/(jpeg|jpg|png|webp)$/i.test(mediaType)) {
      return reply.code(400).send({ error: 'mediaType non supporté' });
    }
    // Vérif sommaire que c'est bien du base64 propre
    if (/[^A-Za-z0-9+/=]/.test(image_b64.slice(0, 200))) {
      return reply.code(400).send({ error: 'image_b64 invalide' });
    }

    // 5. Appel Replicate
    try {
      const result = await removeBackgroundReplicate(image_b64, mediaType, app.log);

      // 6. Track usage : double bookkeeping
      //    - ai_usage : compteur global (cost_usd pour admin dashboard)
      //    - pack_credit_usage + decrement remaining (si on consomme un pack)
      try {
        await query(
          `INSERT INTO ai_usage (user_id, kind, tokens_input, tokens_output, cost_usd)
           VALUES ($1, 'bg-swap', 0, 0, $2)`,
          [user.id, COST_PER_CALL_USD]
        );
      } catch (e) {
        app.log.warn({ err: e }, 'ai_usage insert failed (non-fatal)');
      }
      if (consumeFrom === 'pack' && packIdToDebit) {
        try {
          // Decrement atomique (pas de race : remaining > 0 garanti par WHERE)
          const upd = await queryOne(
            `UPDATE pack_credits SET remaining = remaining - 1
             WHERE id = $1 AND remaining > 0
             RETURNING id, remaining`,
            [packIdToDebit]
          );
          if (upd) {
            await query(
              `INSERT INTO pack_credit_usage (user_id, pack_credit_id, feature)
               VALUES ($1, $2, 'bg-swap')`,
              [user.id, upd.id]
            );
          }
        } catch (e) {
          app.log.warn({ err: e }, 'pack_credit decrement failed (non-fatal)');
        }
      }

      return {
        ok: true,
        image_b64: result.base64,
        mediaType: result.mediaType,
        sizeBytes: result.sizeBytes,
        tookMs: result.tookMs,
      };
    } catch (e) {
      app.log.error(
        { err: e, userId: user.id, code: e.code, detail: e.detail },
        'bg-swap failed'
      );
      try {
        await audit(req, 'bg-swap-failed', {
          userId: user.id,
          code: e.code,
          message: (e.message || '').slice(0, 100),
        });
      } catch (_) {}

      if (e.code === 'config') {
        return reply.code(503).send({ error: 'service indisponible (config)' });
      }
      const safeCode = (e.message || 'unknown').match(/^[a-z_0-9]+/i);
      return reply.code(502).send({
        error: 'erreur API détourage',
        code: safeCode ? safeCode[0] : 'unknown',
        detail: IS_PROD ? undefined : (e.detail || e.message),
      });
    }
  });

  // ─────── GET /api/ai/bg-swap/quota ─────────────────────────
  app.get('/api/ai/bg-swap/quota', {
    onRequest: [app.authenticate],
  }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'auth requis' });

    const user = await queryOne(
      'SELECT id, plan, plan_status FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    const planDef = PLANS[user.plan] || {};
    const monthlyLimit = planDef.bgSwapMonthly || 0;
    const limitOut = monthlyLimit === Infinity ? null : monthlyLimit;

    let used = 0;
    if (monthlyLimit > 0) {
      used = await getMonthlyUsage(user.id);
    }

    // v1.3.7 : expose le solde de packs Multipost IA pour la modal Copier
    const packRow = await queryOne(
      `SELECT COALESCE(SUM(remaining), 0)::int AS total
       FROM pack_credits
       WHERE user_id = $1 AND expires_at > NOW() AND remaining > 0`,
      [user.id]
    );
    const packCredits = packRow?.total || 0;

    return {
      ok: true,
      plan: user.plan,
      plan_status: user.plan_status,
      limit: limitOut,
      used,
      remaining: limitOut == null ? null : Math.max(0, limitOut - used),
      packCredits,
    };
  });
}
