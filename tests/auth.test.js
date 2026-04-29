// Tests E2E des routes auth via Fastify inject (pas de réseau).
// Lancer : `npm test`
//
// Couvre :
//   1. signup avec email valide + password fort       → 201
//   2. signup avec email invalide                     → 400
//   3. signup avec password trop faible               → 400
//   4. login avec credentials valides                 → 200 + JWT
//   5. /auth/me avec JWT valide                       → 200 + user
//
// IMPORTANT : ces tests touchent la DB. Utilise une DB de test (DATABASE_URL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp, uniqueEmail, cleanupUser, VALID_PASSWORD } from './setup.js';

let app;
const createdEmails = []; // tracker pour cleanup

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  // Nettoyage des users créés pendant les tests
  for (const email of createdEmails) {
    await cleanupUser(email);
  }
  if (app) await app.close();
});

test('signup — email valide + password fort → 201', async () => {
  const email = uniqueEmail('signup-ok');
  createdEmails.push(email);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email,
      password: VALID_PASSWORD,
      acceptedTerms: true,
    },
  });
  // Vinted ne renvoie pas 201 mais 200 avec le payload — on accepte 200/201
  assert.ok([200, 201].includes(res.statusCode), 'expected 200 or 201, got ' + res.statusCode + ' body=' + res.body);
  const body = JSON.parse(res.body);
  assert.ok(body.token, 'token JWT manquant');
  assert.equal(body.user?.email, email);
});

test('signup — email invalide → 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email: 'pas-un-email',
      password: VALID_PASSWORD,
      acceptedTerms: true,
    },
  });
  assert.equal(res.statusCode, 400);
});

test('signup — password trop faible → 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      email: uniqueEmail('signup-weak'),
      password: '123', // trop court + pas de complexité
      acceptedTerms: true,
    },
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error || '', /mot de passe|password/i);
});

test('login — credentials valides → 200 + JWT', async () => {
  // 1. signup
  const email = uniqueEmail('login-ok');
  createdEmails.push(email);
  await app.inject({
    method: 'POST', url: '/auth/signup',
    payload: { email, password: VALID_PASSWORD, acceptedTerms: true },
  });

  // 2. login
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: VALID_PASSWORD },
  });
  assert.equal(res.statusCode, 200, 'login failed: ' + res.body);
  const body = JSON.parse(res.body);
  assert.ok(body.token, 'JWT manquant après login');
  assert.equal(body.user?.email, email);
});

test('/auth/me — JWT valide → 200 + user', async () => {
  // 1. signup → récupère le token
  const email = uniqueEmail('me-ok');
  createdEmails.push(email);
  const signup = await app.inject({
    method: 'POST', url: '/auth/signup',
    payload: { email, password: VALID_PASSWORD, acceptedTerms: true },
  });
  const { token } = JSON.parse(signup.body);
  assert.ok(token, 'pas de token au signup');

  // 2. /auth/me
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user?.email, email);
});

test('/auth/me — sans JWT → 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/me' });
  assert.equal(res.statusCode, 401);
});
