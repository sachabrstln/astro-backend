# Astro — Checklist mise en production publique

## 🔑 Variables d'environnement Render (à compléter)

### Obligatoires
- [x] `PORT=8787`
- [x] `NODE_ENV=production`
- [x] `FRONTEND_URL=https://astro-vinted.com` (mettre le vrai domaine)
- [x] `DATABASE_URL=postgresql://...` (Supabase pooler)
- [x] `JWT_SECRET=...` (min 32 chars, aléatoire)
- [x] `ANTHROPIC_API_KEY=sk-ant-...`
- [x] `STRIPE_SECRET_KEY=sk_live_...` ⚠️ **passer en MODE LIVE** (actuellement test)
- [x] `STRIPE_WEBHOOK_SECRET=whsec_...` (re-créer pour mode live)
- [x] `STRIPE_PRICE_STARTER=price_...`
- [x] `STRIPE_PRICE_PRO=price_...`
- [x] `STRIPE_PRICE_MAX=price_...`
- [x] `STRIPE_PRICE_ULTRA=price_...`

### Recommandées
- [ ] `CF_TURNSTILE_SECRET=0x4AAA...` (Cloudflare Turnstile)
- [ ] `RESEND_API_KEY=re_...` (emails transactionnels)
- [ ] `EMAIL_FROM=Astro <no-reply@astro-vinted.com>` (domaine vérifié chez Resend)
- [ ] `DATABASE_SSL_STRICT=1` (vérification TLS stricte)

### Optionnelles
- [ ] `DATABASE_CA=...` (CA Supabase si strict mode)

## 🌐 Landing page (Vercel/Netlify)

Dans `astro-landing/index.html` et `forgot-password.html` :
- [ ] Remplacer `window.TURNSTILE_SITEKEY = ''` par ta clé publique Turnstile

Dans `astro-landing/mentions-legales.html` :
- [ ] Compléter raison sociale, SIREN, adresse

Domaine :
- [ ] Pointer DNS `astro-vinted.com` → Vercel
- [ ] Vérifier HTTPS auto (Vercel le fait)

## 📧 Emails transactionnels (Resend)

1. Créer compte sur [resend.com](https://resend.com)
2. Vérifier le domaine `astro-vinted.com` (DNS TXT/MX records)
3. Créer API key → mettre dans `RESEND_API_KEY`
4. Sans cette config, le backend log les emails au lieu de les envoyer (dev mode)

## 🛡️ Cloudflare Turnstile

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Turnstile
2. Ajouter un site : `astro-vinted.com`
3. Mode : "Managed" (invisible + challenge si suspect)
4. Récupérer :
   - **Site key** (publique) → dans les HTML de la landing
   - **Secret key** → `CF_TURNSTILE_SECRET` dans Render

## 💳 Stripe production

1. Stripe Dashboard → basculer en mode live (toggle en haut)
2. Créer les 4 produits en mode live (Starter, Pro, Max, Ultra)
3. Récupérer les nouveaux `price_...` → env Render
4. Créer le webhook endpoint live → récupérer nouveau `whsec_...`
5. Vérifier la clé secrète live `sk_live_...`
6. Activer la "Tax" de Stripe si tu vends en UE (TVA auto)

## 📊 Monitoring (à ajouter)

### Sentry (recommandé)
```bash
npm install @sentry/node
```
Dans `src/server.js` :
```js
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
app.setErrorHandler((err, req, reply) => {
  Sentry.captureException(err);
  // ... reste du handler
});
```

### Logs Render
- Déjà configurés, visibles dans le dashboard Render
- Prévoir retention : Pro plan pour garder les logs > 7 jours

### Uptime monitoring
- [ ] UptimeRobot ou Better Uptime sur `/health` (gratuit)

## 🗄️ Base de données

- [x] Tables créées automatiquement au déploiement (`npm run migrate`)
- [ ] Backups Supabase activés (Free plan : 7 jours, Pro : 14 jours)
- [ ] Tester la restauration d'un backup
- [ ] `DATABASE_SSL_STRICT=1` pour forcer vérif TLS

## 🔐 Sécurité (implémenté)

- [x] Prompt injection sanitization
- [x] Password policy (10 chars, 1 lettre + 1 chiffre, HIBP check)
- [x] Rate limit signup/login (5/15min par IP+email)
- [x] Rate limit AI par user (10/min)
- [x] Timing-attack resistance (dummy bcrypt)
- [x] Account lockout après 5 tentatives
- [x] Sessions révocables (jti en DB)
- [x] Password reset via email (expire 60min)
- [x] Email verification (expire 48h)
- [x] Audit log DB (sensitive actions)
- [x] Helmet security headers (HSTS, nosniff, frameguard)
- [x] CORS strict
- [x] CSP sur la landing
- [x] Bcrypt 12 rounds
- [x] Error handler masque stack traces en prod
- [x] Webhook Stripe signature vérifiée
- [x] Idempotence webhook (webhook_events table)

## 📋 Légal / RGPD

- [x] Page CGU créée (`/cgu.html`)
- [x] Politique de confidentialité RGPD (`/privacy.html`)
- [x] Mentions légales (à compléter avec SIREN)
- [x] security.txt à `/.well-known/security.txt`
- [ ] Inscrire l'activité si CA > seuil auto-entrepreneur
- [ ] Souscrire RC Pro (recommandé)
- [ ] Mettre en place registre de traitement RGPD
- [ ] Email DPO fonctionnel (privacy@astro-vinted.com)

## 🚀 Déploiement

```bash
# Depuis astro-backend/
git add .
git commit -m "security hardening prod"
git push

# Render redéploiera automatiquement
# Les migrations DB tourneront au startup (npm run migrate && npm start)
```

## ✅ Tests avant lancement

- [ ] Signup + confirmation email reçue
- [ ] Login normal
- [ ] Login avec mauvais password → lockout après 5 essais
- [ ] Reset password → email → nouveau mdp → login OK
- [ ] Turnstile requis (si configuré)
- [ ] HIBP : essayer "password123" → refusé
- [ ] Stripe checkout Starter → paiement test → webhook → plan_status=active
- [ ] Désabonnement via portal → webhook → plan_status=inactive
- [ ] SEO gen après paiement Max → fonctionne
- [ ] Logout → token invalide
- [ ] Rate limit login 6x → bloqué
- [ ] CORS : depuis un autre domaine → rejeté
- [ ] CSP landing : pas d'erreur dans la console

## 📈 À prévoir après lancement

- [ ] 2FA (TOTP) pour plans Ultra
- [ ] Logout-all-devices dans le dashboard (endpoint existe déjà)
- [ ] Account deletion endpoint (RGPD right to be forgotten)
- [ ] Password change endpoint (user connecté)
- [ ] Export de données RGPD
- [ ] Sentry monitoring
- [ ] Analytics privacy-friendly (Plausible ou Fathom)
- [ ] Helpdesk (Crisp ou similaire)
- [ ] Captcha sur l'extension aussi (pas juste la landing)
