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

// v1.3.49 (SECURITY) : timeout obligatoire sur tous les fetch sortants vers Replicate
// pour éviter qu'un Replicate qui hang n'épuise le pool DB du backend.
const REPLICATE_FETCH_TIMEOUT_MS = 45_000; // v1.3.7 : 15s → 45s pour absorber cold start Replicate (création prédiction lente sur 1er run)
const REPLICATE_DOWNLOAD_TIMEOUT_MS = 30_000; // 30s — DL image résultat
function _replicateFetch(url, opts = {}, timeoutMs = REPLICATE_FETCH_TIMEOUT_MS) {
  // AbortSignal.timeout est dispo en Node 18+ (Fastify 4 = Node 18+).
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

// v1.3.701 : SWITCH model — 851-labs/background-remover retourne 422 depuis qq jours
// (probablement deprecated/schema changed). On passe à cjwbw/rembg qui est stable
// depuis 3 ans, même ratio qualité/prix (~$0.001/run). Bria 2.0 reste override possible.
const DEFAULT_MODEL = process.env.REPLICATE_BG_MODEL || 'cjwbw/rembg';

// v1.3.10 : relight model. IC-Light Background (background-conditioned variant)
// re-rend la lumière du sujet pour qu'elle matche celle du fond choisi.
// Coût Replicate officiel : ~$0.033/run sur L40S, ~34s par run.
// Override possible via env REPLICATE_RELIGHT_MODEL.
const RELIGHT_MODEL = process.env.REPLICATE_RELIGHT_MODEL || 'zsxkib/ic-light-background';

// Coût estimé par appel pour la trace usage (centimes USD).
const COST_PER_CALL_USD = parseFloat(process.env.REPLICATE_BG_COST_USD || '0.0015');
const RELIGHT_COST_USD = parseFloat(process.env.REPLICATE_RELIGHT_COST_USD || '0.033');

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
    const modelInfoRes = await _replicateFetch(`${REPLICATE_API_BASE}/models/${DEFAULT_MODEL}`, {
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
    createRes = await _replicateFetch(createUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=90',
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

  // v1.3.7 : si Prefer:wait n'a pas eu le temps, polling jusqu'à 120s total
  // (cold start Replicate peut prendre 60-90s sur le 1er call après inactivité)
  const POLL_INTERVAL_MS = 1500;
  const MAX_TOTAL_MS = 120000;
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
      const pollRes = await _replicateFetch(pollUrl, {
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
    imgRes = await _replicateFetch(outputUrl, {}, REPLICATE_DOWNLOAD_TIMEOUT_MS);
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
// v1.3.10 : RELIGHT helper
// Prend un sujet détouré (PNG transparent) + un fond (JPEG/PNG)
// → renvoie une image finale où la lumière du sujet a été re-rendue
// pour matcher l'éclairage implicite du fond. Modèle : IC-Light v2.
//
// Cette étape est OPTIONNELLE — appelée seulement si l'extension
// envoie `relight: true` ET un `background_b64`.
// ─────────────────────────────────────────────────────────────
async function relightSubjectOnBackground(subjectPngB64, backgroundB64, backgroundMediaType, log) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    const err = new Error('REPLICATE_API_TOKEN_MISSING');
    err.code = 'config';
    throw err;
  }

  const subjectDataUrl = `data:image/png;base64,${subjectPngB64}`;
  const bgDataUrl = `data:${backgroundMediaType || 'image/jpeg'};base64,${backgroundB64}`;
  const startedAt = Date.now();

  // Récup latest version du modèle relight
  let latestVersion;
  try {
    const r = await _replicateFetch(`${REPLICATE_API_BASE}/models/${RELIGHT_MODEL}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const err = new Error(`replicate_${r.status}`);
      err.detail = 'relight_model_info: ' + txt.slice(0, 200);
      err.statusCode = r.status;
      throw err;
    }
    const info = await r.json();
    latestVersion = info.latest_version && info.latest_version.id;
    if (!latestVersion) throw new Error('replicate_relight_no_version');
  } catch (e) {
    if (e.message && e.message.startsWith('replicate_')) throw e;
    const err = new Error('replicate_network');
    err.detail = e.message;
    throw err;
  }

  // IC-Light v2 inputs : `subject_image` (avec alpha) + `background_image`.
  // Le modèle re-rend la lumière du sujet en fonction du fond et compose
  // directement la sortie finale.
  let createRes;
  try {
    createRes = await _replicateFetch(`${REPLICATE_API_BASE}/predictions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=90',
      },
      body: JSON.stringify({
        version: latestVersion,
        input: {
          subject_image: subjectDataUrl,
          background_image: bgDataUrl,
          // Prompt très neutre — on veut juste la lumière, pas re-générer
          // le sujet (sinon l'article change visuellement et c'est pénal pour Vinted).
          prompt: 'product photography, natural lighting, sharp, realistic',
        },
      }),
    });
  } catch (e) {
    const err = new Error('replicate_network');
    err.detail = e.message;
    throw err;
  }

  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => '');
    const err = new Error(`replicate_${createRes.status}`);
    err.detail = txt.slice(0, 300);
    err.statusCode = createRes.status;
    throw err;
  }

  let prediction = await createRes.json();
  const POLL_INTERVAL_MS = 1500;
  const MAX_TOTAL_MS = 90000; // relight peut être plus lent que le bg-remove

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
      const pr = await _replicateFetch(pollUrl, { headers: { 'Authorization': `Bearer ${token}` } });
      if (pr.ok) prediction = await pr.json();
    } catch (_) { /* retry */ }
  }

  if (prediction.status !== 'succeeded') {
    const err = new Error('replicate_relight_failed');
    err.detail = prediction.error || prediction.status || 'unknown';
    throw err;
  }

  const out = prediction.output;
  const url = Array.isArray(out) ? out[0] : (typeof out === 'string' ? out : null);
  if (!url) throw new Error('replicate_relight_no_output');

  const imgRes = await _replicateFetch(url, {}, REPLICATE_DOWNLOAD_TIMEOUT_MS);
  if (!imgRes.ok) throw new Error(`relight_output_fetch_${imgRes.status}`);
  const arrayBuf = await imgRes.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  log?.info?.({
    sizeBytes: buf.length,
    tookMs: Date.now() - startedAt,
    model: RELIGHT_MODEL,
  }, 'relight success');

  return {
    base64: buf.toString('base64'),
    mediaType: imgRes.headers.get('content-type') || 'image/jpeg',
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

    // v1.3.701 : DEV_MODE_BYPASS_PLAN — si la env var ASTRO_DEV_BYPASS_PLAN=1
    // est set sur Render, on bypass la vérif plan et on traite l'user comme Ultra
    // illimité (pour tests internes). NE PAS ACTIVER EN PROD avec users payants.
    const DEV_BYPASS = process.env.ASTRO_DEV_BYPASS_PLAN === '1';

    // v1.3.7 : Multipost IA = upsell pour users abonnés. Pas d'accès sans
    // abonnement actif, même avec un pack en stock (les packs sont un
    // complément, pas un substitut d'abo).
    const planDef = PLANS[user.plan] || {};
    const monthlyLimit = DEV_BYPASS ? Infinity : (planDef.bgSwapMonthly || 0);
    const subActive = DEV_BYPASS || user.plan_status === 'active'
                   || user.plan_status === 'trialing'
                   || user.plan_status === 'active_cancelling';

    if (!subActive) {
      return reply.code(402).send({
        error: 'abonnement actif requis',
        plan: user.plan,
        plan_status: user.plan_status,
        hint: 'Choisis un plan dans ton dashboard pour accéder à Multipost IA',
      });
    }

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
    // v1.3.10 : nouveaux champs optionnels { background_b64, backgroundMediaType, relight }
    // permettent de chaîner un relight IA après le détourage.
    const { image_b64, mediaType, background_b64, backgroundMediaType, relight } = req.body || {};
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
    const wantRelight = relight === true && typeof background_b64 === 'string' && background_b64.length > 0;
    if (wantRelight) {
      if (background_b64.length > MAX_INPUT_B64_SIZE) {
        return reply.code(400).send({ error: 'background_b64 > 6 MB' });
      }
      if (backgroundMediaType && !/^image\/(jpeg|jpg|png|webp)$/i.test(backgroundMediaType)) {
        return reply.code(400).send({ error: 'backgroundMediaType non supporté' });
      }
      if (/[^A-Za-z0-9+/=]/.test(background_b64.slice(0, 200))) {
        return reply.code(400).send({ error: 'background_b64 invalide' });
      }
    }

    // 5. Appel Replicate — étape 1 : détourage
    try {
      const result = await removeBackgroundReplicate(image_b64, mediaType, app.log);

      // v1.3.10 : étape 2 (optionnelle) — relight IA pour adapter la lumière du sujet au fond
      // Si le relight échoue, on retombe gracieusement sur le détourage simple
      // (l'extension fera le composite client-side comme avant).
      let relightResult = null;
      let relightError = null;
      if (wantRelight) {
        try {
          relightResult = await relightSubjectOnBackground(
            result.base64,           // sujet PNG transparent
            background_b64,
            backgroundMediaType,
            app.log,
          );
        } catch (e) {
          relightError = (e.message || 'relight_failed').slice(0, 60);
          app.log.warn({ err: e, userId: user.id }, 'relight failed, falling back to bg-swap only');
        }
      }

      // 6. Track usage : double bookkeeping
      //    - ai_usage : compteur global (cost_usd pour admin dashboard)
      //    - pack_credit_usage + decrement remaining (si on consomme un pack)
      try {
        const totalCost = COST_PER_CALL_USD + (relightResult ? RELIGHT_COST_USD : 0);
        await query(
          `INSERT INTO ai_usage (user_id, kind, tokens_input, tokens_output, cost_usd)
           VALUES ($1, $2, 0, 0, $3)`,
          [user.id, relightResult ? 'bg-swap-relight' : 'bg-swap', totalCost]
        );
      } catch (e) {
        app.log.warn({ err: e }, 'ai_usage insert failed (non-fatal)');
      }
      // v1.3.10 : la décrémentation se fait MAINTENANT au moment de la publication
      // d'annonce (POST /api/clipboard/claim-annonce-credit) plutôt qu'à chaque photo.
      // 1 crédit pack = 1 ANNONCE publiée, peu importe le nombre de photos dedans.
      // bg-swap se contente de vérifier que l'user a bien des crédits (pack OU quota Ultra).

      // v1.3.10 : si relight a réussi, on renvoie le composite final au client
      // (l'extension n'a plus à faire le composite — elle fait juste l'anti-pHash).
      // Si relight a échoué OU n'a pas été demandé, on renvoie le PNG transparent
      // et le client compose lui-même avec son fond comme avant.
      if (relightResult) {
        return {
          ok: true,
          image_b64: relightResult.base64,
          mediaType: relightResult.mediaType,
          sizeBytes: relightResult.sizeBytes,
          tookMs: relightResult.tookMs,
          relit: true,
          composite: true, // signale au client : pas besoin de re-composer
        };
      }
      return {
        ok: true,
        image_b64: result.base64,
        mediaType: result.mediaType,
        sizeBytes: result.sizeBytes,
        tookMs: result.tookMs,
        relit: false,
        composite: false,
        relightError: relightError || undefined, // remonte au client pour debug si demandé
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
        detail: e.detail || e.message,
        statusCode: e.statusCode || null,
      });
    }
  });

  // ─────── POST /api/ai/relight ──────────────────────────────
  // v1.3.10 : prend un sujet DÉJÀ détouré (PNG transparent) + un fond
  // → renvoie un composite final où la lumière du sujet a été ré-rendue
  // pour matcher l'éclairage du fond.
  //
  // Coût : 1 appel Replicate IC-Light (~$0.010). Décrémente 1 crédit pack
  // SI on facture le relight comme un swap supplémentaire — pour l'instant
  // on facture le relight UNIQUEMENT en cost_usd (pas de crédit pack
  // supplémentaire) car l'user a déjà payé son détourage. C'est l'upsell
  // "Studio" : on peut soit augmenter le prix des packs, soit créer un
  // 2e crédit "relight" séparé. Voir TODO.
  //
  // Body : { subject_b64, subjectMediaType?, background_b64, backgroundMediaType? }
  // Réponse : { ok, image_b64 (JPEG composite final), mediaType, sizeBytes, tookMs }
  app.post('/api/ai/relight', {
    onRequest: [app.authenticate],
    bodyLimit: 20 * 1024 * 1024, // 2 images base64
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (req) => 'relight:' + (req.user?.sub || req.ip),
        errorResponseBuilder: () => ({ error: 'trop de relights, attends 1 minute' }),
      },
    },
  }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'auth requis' });

    const user = await queryOne(
      'SELECT id, plan, plan_status FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    const subActive = user.plan_status === 'active'
                   || user.plan_status === 'trialing'
                   || user.plan_status === 'active_cancelling';
    if (!subActive) {
      return reply.code(402).send({
        error: 'abonnement actif requis',
        plan: user.plan,
        plan_status: user.plan_status,
      });
    }

    const { subject_b64, subjectMediaType, background_b64, backgroundMediaType } = req.body || {};
    if (!subject_b64 || typeof subject_b64 !== 'string') {
      return reply.code(400).send({ error: 'subject_b64 requis' });
    }
    if (!background_b64 || typeof background_b64 !== 'string') {
      return reply.code(400).send({ error: 'background_b64 requis' });
    }
    if (subject_b64.length > MAX_INPUT_B64_SIZE) {
      return reply.code(400).send({ error: 'subject_b64 > 6 MB' });
    }
    if (background_b64.length > MAX_INPUT_B64_SIZE) {
      return reply.code(400).send({ error: 'background_b64 > 6 MB' });
    }
    if (/[^A-Za-z0-9+/=]/.test(subject_b64.slice(0, 200))) {
      return reply.code(400).send({ error: 'subject_b64 invalide' });
    }
    if (/[^A-Za-z0-9+/=]/.test(background_b64.slice(0, 200))) {
      return reply.code(400).send({ error: 'background_b64 invalide' });
    }

    try {
      const result = await relightSubjectOnBackground(
        subject_b64,
        background_b64,
        backgroundMediaType,
        app.log,
      );

      try {
        await query(
          `INSERT INTO ai_usage (user_id, kind, tokens_input, tokens_output, cost_usd)
           VALUES ($1, 'relight', 0, 0, $2)`,
          [user.id, RELIGHT_COST_USD]
        );
      } catch (e) {
        app.log.warn({ err: e }, 'ai_usage relight insert failed (non-fatal)');
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
        'relight failed'
      );
      const safeCode = (e.message || 'unknown').match(/^[a-z_0-9]+/i);
      return reply.code(502).send({
        error: 'erreur API relight',
        code: safeCode ? safeCode[0] : 'unknown',
        detail: IS_PROD ? undefined : (e.detail || e.message),
      });
    }
  });

  // ─────── POST /api/clipboard/claim-annonce-credit ────────
  // v1.3.10 : décrémente 1 crédit pack par ANNONCE publiée avec succès.
  // Body : { studio: bool } — si true, décrémente 1.5 au lieu de 1
  // 1 crédit = 1 annonce Standard, 1.5 crédit = 1 annonce Studio.
  app.post('/api/clipboard/claim-annonce-credit', {
    onRequest: [app.authenticate],
    config: {
      rateLimit: {
        max: 200,
        timeWindow: '1 minute',
        keyGenerator: (req) => 'claim:' + (req.user?.sub || req.ip),
      },
    },
  }, async (req, reply) => {
    const userId = req.user?.sub;
    if (!userId) return reply.code(401).send({ error: 'auth requis' });

    const user = await queryOne(
      'SELECT id, plan, plan_status FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return reply.code(404).send({ error: 'user introuvable' });

    const subActive = user.plan_status === 'active'
                   || user.plan_status === 'trialing'
                   || user.plan_status === 'active_cancelling';
    if (!subActive) {
      return reply.code(402).send({ error: 'abonnement actif requis' });
    }

    // v1.3.10 : Studio = 1.5 crédit, Standard = 1 crédit
    const isStudio = req.body?.studio === true;
    const cost = isStudio ? 1.5 : 1.0;
    const feature = isStudio ? 'multipost-studio' : 'multipost-standard';

    // FIFO : pack le plus vieux non-expiré qui a assez de remaining.
    const packRow = await queryOne(
      `SELECT id, remaining FROM pack_credits
       WHERE user_id = $1 AND expires_at > NOW() AND remaining >= $2
       ORDER BY expires_at ASC LIMIT 1`,
      [user.id, cost]
    );

    if (packRow) {
      try {
        // Décrément atomique avec WHERE remaining >= cost pour éviter les races.
        const upd = await queryOne(
          `UPDATE pack_credits SET remaining = remaining - $2
           WHERE id = $1 AND remaining >= $2
           RETURNING id, remaining`,
          [packRow.id, cost]
        );
        if (upd) {
          await query(
            `INSERT INTO pack_credit_usage (user_id, pack_credit_id, feature)
             VALUES ($1, $2, $3)`,
            [user.id, upd.id, feature]
          );
          return {
            ok: true,
            source: 'pack',
            remaining: parseFloat(upd.remaining),
            cost,
          };
        }
      } catch (e) {
        app.log.warn({ err: e }, 'pack credit decrement failed');
        return reply.code(500).send({ error: 'decrement_failed' });
      }
    }

    // Pas de pack avec assez de crédits → fallback Ultra (subActive déjà checké)
    return { ok: true, source: 'subscription', remaining: null, cost };
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

    // v1.3.701 : DEV_BYPASS — si ASTRO_DEV_BYPASS_PLAN=1, retourne limite illimitée
    const DEV_BYPASS = process.env.ASTRO_DEV_BYPASS_PLAN === '1';
    const planDef = PLANS[user.plan] || {};
    const monthlyLimit = DEV_BYPASS ? Infinity : (planDef.bgSwapMonthly || 0);
    const limitOut = monthlyLimit === Infinity ? null : monthlyLimit;

    let used = 0;
    if (monthlyLimit > 0 && monthlyLimit !== Infinity) {
      used = await getMonthlyUsage(user.id);
    }

    // v1.3.10 : crédits maintenant fractionnaires (NUMERIC) — Studio coûte 1.5
    const packRow = await queryOne(
      `SELECT COALESCE(SUM(remaining), 0)::numeric AS total
       FROM pack_credits
       WHERE user_id = $1 AND expires_at > NOW() AND remaining > 0`,
      [user.id]
    );
    const packCredits = parseFloat(packRow?.total || 0);

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
