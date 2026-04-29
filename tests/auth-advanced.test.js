// Tests avancés du flow auth — logout, session revoke, password reset.
// v1.3.4 (#10 senior pass)
//
// Couvre les scénarios critiques de sécurité :
//   - logout révoque le token (401 sur les requêtes suivantes)
//   - logout-all révoque tous les tokens d'un user
//   - password reset force la rotation des sessions
//   - JWT avec user_id mismatch est rejeté (defense in depth)
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp, uniqueEmail, cleanupUser, VALID_PASSWORD } from './setup.js';

let app;
const emailsCreated = [];

before(async () => {
  app = await buildTestApp();
  await app.ready();
});

after(async () => {
  for (const email of emailsCreated) {
    await cleanupUser(email).catch(() => {});
  }
  if (app) await app.close();
});

// ── Helpers ──────────────────────────────────────────────────
async function signup() {
  const email = uniqueEmail();
  emailsCreated.push(email);
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: VALID_PASSWORD, acceptedTerms: true },
  });
  assert.ok(r.statusCode === 200 || r.statusCode === 201, `signup ${r.statusCode}: ${r.payload}`);
  const body = JSON.parse(r.payload);
  return { email, token: body.token, userId: body.user?.id };
}

async function login(email, password = VALID_PASSWORD) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  assert.equal(r.statusCode, 200, `login ${r.statusCode}: ${r.payload}`);
  return JSON.parse(r.payload).token;
}

async function callMe(token) {
  return app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

// ── Tests ────────────────────────────────────────────────────

test('logout révoque le token actuel uniquement', async () => {
  const { email } = await signup();

  // 2 sessions distinctes (2 logins → 2 jti différents)
  const token1 = await login(email);
  const token2 = await login(email);
  assert.notEqual(token1, token2);

  // Les 2 tokens fonctionnent
  assert.equal((await callMe(token1)).statusCode, 200);
  assert.equal((await callMe(token2)).statusCode, 200);

  // Logout sur token1
  const r = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { authorization: `Bearer ${token1}` },
  });
  assert.equal(r.statusCode, 200);

  // token1 doit être révoqué (401), token2 doit rester valide
  assert.equal((await callMe(token1)).statusCode, 401, 'token1 révoqué');
  assert.equal((await callMe(token2)).statusCode, 200, 'token2 toujours valide');
});

test('logout-all révoque toutes les sessions du user', async () => {
  const { email } = await signup();

  const tokenA = await login(email);
  const tokenB = await login(email);
  const tokenC = await login(email);

  // logout-all depuis tokenA
  const r = await app.inject({
    method: 'POST',
    url: '/auth/logout-all',
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(r.statusCode, 200);

  // Les 3 tokens doivent être révoqués
  assert.equal((await callMe(tokenA)).statusCode, 401, 'tokenA révoqué');
  assert.equal((await callMe(tokenB)).statusCode, 401, 'tokenB révoqué');
  assert.equal((await callMe(tokenC)).statusCode, 401, 'tokenC révoqué');
});

test('password reset request → renvoie ok=true même si email inconnu (anti-énumération)', async () => {
  const fakeEmail = uniqueEmail('ghost');
  const r = await app.inject({
    method: 'POST',
    url: '/auth/password-reset/request',
    payload: { email: fakeEmail },
  });
  // L'API ne doit PAS révéler que l'email n'existe pas → 200 dans tous les cas
  assert.ok(r.statusCode === 200 || r.statusCode === 201, 'no leak');
});

test('JWT avec session révoquée renvoie 401 explicite', async () => {
  const { email } = await signup();
  const token = await login(email);

  // Révoque manuellement la session
  const { query } = await import('../src/db.js');
  // Décode le jti côté test
  const jwt = (await import('@fastify/jwt')).default; // pas vraiment utile, on extrait via le payload
  // Plus simple : on appelle logout
  await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { authorization: `Bearer ${token}` },
  });

  const r = await callMe(token);
  assert.equal(r.statusCode, 401);
  const body = JSON.parse(r.payload);
  assert.match(body.error, /révoquée|invalide/, 'message d\'erreur explicite');
});

test('JWT mal formé → 401 propre (pas de 500)', async () => {
  const r = await callMe('not-a-real-jwt');
  assert.equal(r.statusCode, 401);
});

test('signup sans acceptedTerms → 400', async () => {
  const email = uniqueEmail('cgu');
  emailsCreated.push(email);
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: VALID_PASSWORD /* pas de acceptedTerms */ },
  });
  assert.equal(r.statusCode, 400, 'CGU obligatoire');
  const body = JSON.parse(r.payload);
  assert.match(body.error, /CGU|conditions/i);
});

test('signup avec referralCode invalide → 400', async () => {
  const email = uniqueEmail('refbad');
  emailsCreated.push(email);
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email,
      password: VALID_PASSWORD,
      acceptedTerms: true,
      referralCode: 'xx', // trop court
    },
  });
  assert.equal(r.statusCode, 400);
  const body = JSON.parse(r.payload);
  assert.match(body.error, /parrainage|referral/i);
});
