# Astro Backend — Notes de déploiement

> ⚠️ **Ne jamais commit le fichier `.env`** — il contient les clés secrètes.
> Le fichier `.env` est déjà dans `.gitignore`. Les valeurs réelles sont dans `.env` local uniquement.

## Supabase
- Project URL : `https://lyaeemenwudvjaccbdmd.supabase.co`
- DATABASE_URL (Transaction pooler) : voir `.env` local
- Host : `aws-1-eu-central-2.pooler.supabase.com`
- Port : 6543

## Stripe — Products
- Starter : `prod_UNNotrzNFWVamS`
- Pro : `prod_UNNpSZHf1pG5NF`
- Max : `prod_UNNruLbHQwhe2V`
- Ultra : `prod_UNNtWNxQDd13l7`

## Stripe — Price IDs (à mettre dans .env)
```
STRIPE_PRICE_STARTER=price_1TOd362W93EXqd0c2W49RMvu
STRIPE_PRICE_PRO=price_1TOd4D2W93EXqd0c8q6fyriV
STRIPE_PRICE_MAX=price_1TOd652W93EXqd0cXxkHwq17
STRIPE_PRICE_ULTRA=price_1TOd7H2W93EXqd0c0KqqiJ3S
```

## Anthropic API Key
Stockée dans `.env` local et dans les env vars Render. Régénérable sur [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).

## Stripe Secret Key
Stockée dans `.env` local et dans les env vars Render. Régénérable sur le dashboard Stripe.

## JWT Secret
Généré une fois avec `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Stocké dans `.env` local.

## À configurer APRÈS le premier déploiement

**STRIPE_WEBHOOK_SECRET** (`whsec_...`) — Stripe Dashboard → Développeurs → Webhooks → Add endpoint
- URL : `https://<ton-backend>.onrender.com/stripe/webhook`
- Events : `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- Récupérer le secret `whsec_...` après création
- Le mettre dans l'env de Render et redéployer

## Commandes de déploiement (Render.com)

Connecter le repo `astro-backend` sur Render :
- Build command : `npm install`
- Start command : `npm run migrate && npm start`
- Environment variables : copier depuis `.env` local (PAS le commiter !)

## Test rapide une fois déployé

```bash
# Health check
curl https://astro-backend-xxx.onrender.com/health
# → { "ok": true }

# Signup
curl -X POST https://astro-backend-xxx.onrender.com/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@astro-vinted.com","password":"MinDePasse1234"}'
# → { "token": "eyJ...", "user": { ... } }

# Me
curl https://astro-backend-xxx.onrender.com/auth/me \
  -H "Authorization: Bearer eyJ..."
```
