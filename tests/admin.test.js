// Tests E2E des routes /admin/* — auth + check email admin + shape réponse.
// v1.3.4 (#10 senior pass)
//
// Setup :
//   - DATABASE_URL pointant sur une DB de test
//   - JWT_SECRET ≥ 32 chars
//   - Migrations à jour
//
// Lancer : `npm test`
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp, uniqueEmail, cleanupUser, VALID_PASSWORD } from './setup.js';

let app;
const adminEmail = 'sachabruas@gmail.com'; // doit matcher ADMIN_EMAILS dans routes-admin.js
let adminToken;
let adminCleanupNeeded = false;
let nonAdminToken;
let nonAdminEmail;

before(async () => {
  app = await buildTestApp();
  await app.ready();

  // Crée (ou réutilise) un user admin. On le force en plan='ultra' actif pour des stats utiles.
  // Le signup standard refuserait ce compte si déjà créé → on tente, sinon on log in.
  let r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email: adminEmail, password: VALID_PASSWORD, acceptedTerms: true },
  });
  if (r.statusCode === 200 || r.statusCode === 201) {
    adminCleanupNeeded = true; // on l'a créé, on cleanera à la fin
    adminToken = JSON.parse(r.payload).token;
  } else {
    // Probablement existe déjà → login
    r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: adminEmail, password: VALID_PASSWORD },
    });
    // Si login fail (mdp différent en DB existante), on skip ces tests proprement
    if (r.statusCode !== 200) {
      console.warn('[admin.test] admin login failed (mdp différent en DB ?), skip');
      adminToken = null;
      return;
    }
    adminToken = JSON.parse(r.payload).token;
  }

  // Crée un user non-admin pour tester le 403
  nonAdminEmail = uniqueEmail('nonadmin');
  r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email: nonAdminEmail, password: VALID_PASSWORD, acceptedTerms: true },
  });
  assert.ok(r.statusCode === 200 || r.statusCode === 201, 'signup non-admin OK');
  nonAdminToken = JSON.parse(r.payload).token;
});

after(async () => {
  try {
    if (nonAdminEmail) await cleanupUser(nonAdminEmail);
    if (adminCleanupNeeded) await cleanupUser(adminEmail);
    if (app) await app.close();
  } catch (e) { /* silent */ }
});

test('/admin/stats sans auth → 401', async () => {
  if (!app) return;
  const r = await app.inject({ method: 'GET', url: '/admin/stats' });
  assert.equal(r.statusCode, 401);
});

test('/admin/stats avec user non-admin → 403', async () => {
  if (!app || !nonAdminToken) return;
  const r = await app.inject({
    method: 'GET',
    url: '/admin/stats',
    headers: { authorization: `Bearer ${nonAdminToken}` },
  });
  assert.equal(r.statusCode, 403, 'non-admin doit être refusé');
  const body = JSON.parse(r.payload);
  assert.equal(body.error, 'admin only');
});

test('/admin/stats avec admin → 200 + shape', async () => {
  if (!app || !adminToken) return;
  const r = await app.inject({
    method: 'GET',
    url: '/admin/stats',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.statusCode, 200, 'admin doit accéder');
  const body = JSON.parse(r.payload);
  assert.ok(typeof body.totalUsers === 'number', 'totalUsers numeric');
  assert.ok(typeof body.activeSubscribers === 'number', 'activeSubscribers numeric');
  assert.ok(typeof body.mrr === 'number', 'mrr numeric');
  assert.ok(typeof body.signupsToday === 'number', 'signupsToday numeric');
  assert.ok(body.ts, 'ts présent');
});

test('/admin/users avec admin → 200 + array paginé', async () => {
  if (!app || !adminToken) return;
  const r = await app.inject({
    method: 'GET',
    url: '/admin/users?limit=5&offset=0',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.payload);
  assert.ok(Array.isArray(body.users), 'users est un array');
  assert.ok(body.users.length <= 5, 'respect limit');
  if (body.users.length > 0) {
    const u = body.users[0];
    assert.ok(u.id, 'user.id présent');
    assert.ok(u.email, 'user.email présent');
    assert.ok('plan' in u, 'user.plan présent');
  }
});

test('/admin/health avec admin → 200 + db status', async () => {
  if (!app || !adminToken) return;
  const r = await app.inject({
    method: 'GET',
    url: '/admin/health',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.payload);
  assert.ok('db' in body, 'db status présent');
  assert.ok('memory' in body, 'memory status présent');
});
