# Security Audit — Astro (21 avril 2026)

## 🔴 CRITIQUES (fixés dans ce commit)

### C1 — Bypass du paywall sur /api/ai/seo-from-photos
**Fichier** : `src/routes-ai.js:13`
**Avant** :
```js
if (user.plan_status !== 'active' && user.plan !== 'max' && user.plan !== 'ultra')
```
**Problème** : condition AND incorrecte. Un user avec `plan_status='inactive'` ET `plan='max'` passait le check :
- `'inactive' !== 'active'` → true
- `'max' !== 'max'` → false
- `true && false` = false → **ne bloque pas**

Résultat : un user dont l'abonnement Max/Ultra est résilié continue d'utiliser l'IA gratuitement jusqu'à ce que le plan retombe à `free` via webhook.

**Fix** : séparer les deux checks. D'abord plan_status (doit être `active` ou `trialing`), ensuite plan (doit être `max` ou `ultra` via `hasFeature`).

### C2 — SSL rejectUnauthorized: false
**Fichier** : `src/db.js:8`
**Problème** : `ssl: { rejectUnauthorized: false }` accepte n'importe quel certificat TLS sur la connexion Postgres. Vulnérable à un MITM si le trafic passe par un proxy compromis.
**Fix** : utiliser le CA Supabase (ou `rejectUnauthorized: true`) en production. Supabase fournit un certificat valide.

---

## 🟠 HAUTES (fixés)

### H1 — Pas de rate-limiting par email sur /auth/login
**Problème** : rate-limit global 60 req/min par IP. Attaquant avec botnet ou VPN peut bruteforcer un compte.
**Fix** : ajout d'un rate-limit spécifique sur `/auth/login` et `/auth/signup` : 5 tentatives / 15 min / IP + email combo.

### H2 — Pas de headers de sécurité HTTP
**Problème** : Fastify n'ajoute pas de headers comme `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, CSP.
**Fix** : ajout de `@fastify/helmet` avec config sensible (HSTS 1 an, nosniff, frameguard).

### H3 — Body size 15 MB pour TOUTES les routes
**Problème** : server.js fixe `bodyLimit: 15 * 1024 * 1024`. Seule `/api/ai/seo-from-photos` en a besoin (photos base64). Toutes les autres routes acceptent 15 MB = risque DoS mémoire.
**Fix** : body limit global ramené à 1 MB, override 15 MB uniquement sur la route SEO.

### H4 — Validation inputs faible
**Problème** : email et password acceptés sans validation de format ni de taille max. Un attaquant peut envoyer des chaînes de 10 MB pour saturer bcrypt.
**Fix** : validation email (regex + max 254 chars), password (min 8, max 128 chars), trim/lowercase systématique.

---

## 🟡 MOYENNES (fixées ou documentées)

### M1 — bcrypt rounds = 10
Recommandation 2024+ : 12 rounds (coût CPU acceptable sur serveur moderne).
**Fix** : passage à 12 rounds.

### M2 — Pas de CSP sur la landing
**Fichier** : `astro-landing/index.html`
**Fix** : ajout meta CSP strict dans `<head>`.

### M3 — Erreurs détaillées retournées au client
`routes-ai.js:76,94` renvoie `raw: raw.slice(0, 300)` et `detail: e.message`. Peut leaker des infos sur le système.
**Fix** : log côté serveur, message générique au client en prod.

### M4 — clé anthropicApiKey persiste dans l'extension
`modules/storage.js` peut contenir une ancienne clé API dans `store.settings.anthropicApiKey`. Plus utilisée mais conservée.
**Fix** : nettoyage automatique au startup du background si détectée.

### M5 — JWT `sub` = user.id numérique séquentiel
Leak mineur (nombre d'utilisateurs visible via le token). Pas de fix court-terme (nécessite UUIDs), documenté.

---

## 🟢 BASSES (documentées, pas de fix)

### L1 — Pas de CAPTCHA sur signup
Risque de création massive de comptes bots. À ajouter avant mise en prod publique (Cloudflare Turnstile recommandé — gratuit).

### L2 — Pas de vérification email
Comptes créés sans confirmation email. Attaquant peut signer avec des emails tiers. À ajouter avant prod (Resend ou SendGrid).

### L3 — Tokens JWT non révocables
Pas de token blacklist. Si un JWT est volé, il reste valide 30j. Acceptable pour un MVP, à améliorer avec un système de sessions en DB.

### L4 — Pas de protection contre les abus d'AI au niveau burst
Un user Max peut faire 200 appels Anthropic en 1 minute = coût élevé. Le quota mensuel les bloquera mais le pic coûte déjà. À throttler par user.

### L5 — Pas de 2FA
À prévoir pour les plans Ultra (support prioritaire → comptes plus sensibles).

---

## Checklist avant mise en prod publique

- [ ] Stripe : passer en **mode live** (actuellement en test — `sk_test_...`)
- [ ] Anthropic : vérifier le quota de crédits suffisant
- [ ] Cloudflare Turnstile sur signup/login (CAPTCHA)
- [ ] Email verification (Resend.com ou SendGrid)
- [ ] Monitoring : Sentry ou équivalent pour les erreurs
- [ ] Backup DB automatique (Supabase le fait mais à vérifier config)
- [ ] Variables d'env : `NODE_ENV=production`, `DATABASE_URL` avec SSL vérifié
- [ ] Domaine `astropro.app` configuré avec HTTPS (Vercel le fait auto)
- [ ] Landing : CSP + headers de sécurité (done via vercel.json)
- [ ] CGU + Politique de confidentialité + Mentions légales (RGPD)
- [ ] npm audit --production = 0 vulnérabilités critiques

## Score de risque actuel

**Avant fixes** : 🔴 Non-prod-ready (bypass paywall + SSL + validation)
**Après fixes appliqués** : 🟡 Prêt pour friends & family beta, pas encore pour prod publique (manque CAPTCHA + email verification + CGU)
