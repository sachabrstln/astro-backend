# Astro Backend

Backend Node.js + Fastify pour l'extension Astro (Vinted).
- Auth JWT (signup, login)
- Abonnements Stripe (4 plans : Starter, Pro, Max, Ultra)
- Proxy Anthropic pour l'Assistant SEO (gating par plan + quota mensuel)

## Architecture

```
┌─────────────────┐     ┌───────────┐     ┌──────────┐
│ Extension Astro │ ──► │ Backend   │ ──► │Anthropic │
│  (Vinted tab)   │     │ (Fastify) │     │   API    │
└─────────────────┘     └─────┬─────┘     └──────────┘
                              │
                              ▼
                        ┌──────────┐
                        │ Supabase │
                        │ (Postgres)│
                        └──────────┘
                              │
                              ▼
                        ┌──────────┐
                        │  Stripe  │
                        │ webhooks │
                        └──────────┘
```

## Stack

- **Fastify 5** (framework HTTP)
- **@fastify/jwt** (auth session 30j)
- **pg** (Postgres client)
- **bcryptjs** (password hashing)
- **stripe 17** (abonnements + webhooks)
- **@anthropic-ai/sdk** (Claude Vision pour l'Assistant SEO)

## Setup local

```bash
# 1. Installer les deps
npm install

# 2. Copier et remplir l'env
cp .env.example .env
# Remplir DATABASE_URL, JWT_SECRET, STRIPE_*, ANTHROPIC_API_KEY

# 3. Créer les tables
npm run migrate

# 4. Lancer en dev
npm run dev
```

Le serveur écoute sur `http://localhost:8787`.

## Setup Supabase (DB gratuite)

1. Va sur [supabase.com](https://supabase.com) → new project
2. Récupère `DATABASE_URL` dans Project Settings → Database → Connection string
3. Colle dans `.env` sous `DATABASE_URL`
4. Lance `npm run migrate`

## Setup Stripe

1. [stripe.com](https://stripe.com) → récupère la clé secrète (sk_live_... ou sk_test_...)
2. Crée 4 produits dans le dashboard Stripe (Starter, Pro, Max, Ultra) avec leurs prix (12,99€, 30€, 45,99€, 62,99€ par mois)
3. Récupère les Price IDs (price_xxx) et mets-les dans `.env`
4. Configure le webhook :
   - URL : `https://ton-backend.onrender.com/stripe/webhook`
   - Events : `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Récupère le `STRIPE_WEBHOOK_SECRET` (whsec_xxx)

## Déploiement Render.com (gratuit)

1. Push ce repo sur GitHub
2. [render.com](https://render.com) → New → Web Service → connecter ton repo
3. Configure :
   - Runtime : Node
   - Build Command : `npm install`
   - Start Command : `npm run migrate && npm start`
   - Plan : Free
4. Variables d'env : copier toutes celles de `.env.example` dans Render → Environment
5. Déployé sur `https://astro-backend.onrender.com`

## Endpoints

### Auth
- `POST /auth/signup` — `{ email, password }` → `{ token, user }`
- `POST /auth/login` — `{ email, password }` → `{ token, user }`
- `GET /auth/me` — Bearer JWT → `{ user }`

### Stripe
- `POST /stripe/checkout` — Bearer JWT, `{ plan: 'starter|pro|max|ultra' }` → `{ url }` (redirect Stripe Checkout)
- `POST /stripe/portal` — Bearer JWT → `{ url }` (portail client pour gérer l'abo)
- `POST /stripe/webhook` — Signé par Stripe (pas besoin de JWT)

### AI (Assistant SEO)
- `POST /api/ai/seo-from-photos` — Bearer JWT, `{ photos: [{data, mediaType}], hints, tone, descTemplate, extraKeywords }`
  - Nécessite plan **max** ou **ultra**
  - Quota : 200/mois Max, illimité Ultra
  - Renvoie `{ title: "...", description: "..." }`
- `GET /api/ai/usage` — Bearer JWT → `{ used, limit, plan }`

## Coûts estimés

**Claude Sonnet 4 (prix Novembre 2024)** : $3/Mtok input + $15/Mtok output
- 1 génération SEO ≈ 5 photos compressées + 500 tokens réponse ≈ **0,02$ par génération**
- Utilisateur Max (200 gens/mois) : ~4$/mois de coût API → revenu 45,99€, marge ultra large
- Utilisateur Ultra (illimité, estime 500 gens/mois) : ~10$/mois → revenu 62,99€, marge OK

## Sécurité

- JWT signé HS256, expire 30j
- Passwords bcrypt (10 rounds)
- Webhook Stripe vérifié par signature HMAC
- CORS : uniquement extension Chrome + domaine officiel
- Rate limit 60 req/min par IP
- SSL obligatoire en prod
