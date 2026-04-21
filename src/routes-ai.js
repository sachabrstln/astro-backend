// Proxy Anthropic pour l'Assistant SEO — vérifie plan + quota mensuel
import Anthropic from '@anthropic-ai/sdk';
import { query, queryOne } from './db.js';
import { PLANS, hasFeature } from './plans.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function aiRoutes(app) {
  // POST /api/ai/seo-from-photos
  app.post('/api/ai/seo-from-photos', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT id, plan, plan_status FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    if (user.plan_status !== 'active' && user.plan !== 'max' && user.plan !== 'ultra') {
      return reply.code(402).send({ error: 'abonnement requis', requiredPlans: ['max', 'ultra'] });
    }
    if (!hasFeature(user.plan, 'seo')) {
      return reply.code(403).send({ error: 'feature SEO non incluse dans ton plan', plan: user.plan, requiredPlans: ['max', 'ultra'] });
    }

    // Vérifier quota mensuel
    const monthlyLimit = PLANS[user.plan].seoMonthly;
    if (monthlyLimit !== Infinity) {
      const [{ count }] = await query(
        `SELECT COUNT(*)::int AS count FROM ai_usage
         WHERE user_id = $1 AND kind = 'seo-from-photos'
           AND created_at >= date_trunc('month', NOW())`,
        [user.id]
      );
      if (count >= monthlyLimit) {
        return reply.code(429).send({ error: 'quota mensuel atteint', used: count, limit: monthlyLimit });
      }
    }

    const { photos, hints, tone, descTemplate, extraKeywords } = req.body || {};
    if (!Array.isArray(photos) || !photos.length) return reply.code(400).send({ error: 'photos requises' });
    if (photos.length > 5) return reply.code(400).send({ error: 'max 5 photos' });

    // Prompts
    const system = `Tu es un expert de la vente sur Vinted. À partir des photos fournies, tu génères :
1) Un TITRE optimisé SEO pour Vinted, MAXIMUM 100 caractères (strict), mots-clés de recherche inclus. Format : "[Type] [marque] [couleur] [taille] [détails]". Pas de majuscules inutiles.
2) Une DESCRIPTION structurée, ton ${tone || 'vendeur et naturel'}, selon ce template :

${descTemplate || `📏 Taille : ...
👗 [article]
🎨 Coloris : ...
✨ État : ...
🧵 Matière : ...
🧼 Lavé, repassé et plié
🚚 Envoi sous 24h
📦 Colis soigneusement emballé

Mots clés : 12-15 mots-clés pertinents séparés par espaces (pas de hashtags)`}

Réponds UNIQUEMENT en JSON valide sans markdown : { "title": "...", "description": "..." }
Le titre DOIT faire ≤ 100 caractères.${extraKeywords ? '\nMots-clés à inclure quand pertinent : ' + extraKeywords : ''}`;

    const content = [];
    photos.forEach(p => {
      content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/jpeg', data: p.data } });
    });
    content.push({ type: 'text', text: 'Analyse ces photos et génère titre + description selon le template.' + (hints ? '\nInfos : ' + JSON.stringify(hints) : '') });

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 900,
        system,
        messages: [{ role: 'user', content }]
      });
      const raw = response.content?.[0]?.text || '';
      let parsed;
      try {
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : null;
      } catch (e) { parsed = null; }
      if (!parsed?.title) return reply.code(502).send({ error: 'réponse IA invalide', raw: raw.slice(0, 300) });

      // Tronquer le titre
      let title = String(parsed.title).trim();
      if (title.length > 100) title = title.slice(0, 100);

      // Log usage
      const tokIn = response.usage?.input_tokens || 0;
      const tokOut = response.usage?.output_tokens || 0;
      const costUsd = (tokIn / 1e6) * 3 + (tokOut / 1e6) * 15; // Sonnet 4 pricing
      await query(
        `INSERT INTO ai_usage (user_id, kind, tokens_input, tokens_output, cost_usd) VALUES ($1, 'seo-from-photos', $2, $3, $4)`,
        [user.id, tokIn, tokOut, costUsd]
      );

      return { title, description: String(parsed.description || '').trim() };
    } catch (e) {
      app.log.error('Anthropic error: ' + e.message);
      return reply.code(502).send({ error: 'erreur API Anthropic', detail: e.message });
    }
  });

  // GET /api/ai/usage — retourne l'usage mensuel de l'utilisateur
  app.get('/api/ai/usage', { onRequest: [app.authenticate] }, async (req, reply) => {
    const user = await queryOne('SELECT plan FROM users WHERE id = $1', [req.user.sub]);
    if (!user) return reply.code(404).send({ error: 'user introuvable' });
    const [{ count }] = await query(
      `SELECT COUNT(*)::int AS count FROM ai_usage
       WHERE user_id = $1 AND kind = 'seo-from-photos'
         AND created_at >= date_trunc('month', NOW())`,
      [req.user.sub]
    );
    const limit = PLANS[user.plan].seoMonthly;
    return { used: count, limit: limit === Infinity ? null : limit, plan: user.plan };
  });
}
