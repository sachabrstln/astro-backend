// Tests de la feature Clipboard (bg-swap + quota).
// Stratégie : "fake fastify" maison — on capture les routes enregistrées
// par clipboardRoutes(app), puis on les appelle avec un req/reply mockés.
// Zéro dépendance npm.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let mockUser = null;
let mockUsageCount = 0;
let mockReplicateBehavior = 'success';
let dbCallLog = [];

const realFetch = globalThis.fetch;
function installFetchMock() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    // v1.3.7 : mock GET /v1/models/{owner}/{name} pour fetch latest_version
    // (le nouveau flow fait un GET model_info avant le POST predictions)
    if (u.startsWith('https://api.replicate.com/v1/models/') && !u.endsWith('/predictions')) {
      return new Response(JSON.stringify({
        owner: '851-labs',
        name: 'background-remover',
        latest_version: { id: 'mock_version_hash_abc123' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // v1.3.7 : POST /v1/predictions (avec version explicite) — remplace l'ancien
    // POST /v1/models/{owner}/{name}/predictions qui retournait 404 sur 851-labs
    if (u === 'https://api.replicate.com/v1/predictions' ||
        (u.startsWith('https://api.replicate.com/v1/models/') && u.endsWith('/predictions'))) {
      if (mockReplicateBehavior === 'http-500') {
        return new Response('Internal error', { status: 500 });
      }
      if (mockReplicateBehavior === 'pred-failed') {
        return new Response(JSON.stringify({
          id: 'pred_x', status: 'failed', error: 'mock failure', urls: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'pred_x',
        status: 'succeeded',
        output: 'https://replicate.delivery/result.png',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred_x' }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u === 'https://replicate.delivery/result.png') {
      const png = Buffer.from(
        '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C636400000000050001A5F645400000000049454E44AE426082',
        'hex'
      );
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return realFetch ? realFetch(url) : new Response(null, { status: 502 });
  };
}

function makeFakeFastify() {
  const routes = [];
  const app = {
    decorate(name, value) { app[name] = value; return app; },
    register(plugin) { return plugin(app); },
    post(path, opts, handler) {
      if (typeof opts === 'function') { handler = opts; opts = {}; }
      routes.push({ method: 'POST', path, opts, handler });
    },
    get(path, opts, handler) {
      if (typeof opts === 'function') { handler = opts; opts = {}; }
      routes.push({ method: 'GET', path, opts, handler });
    },
    log: { info() {}, warn() {}, error() {} },
    _routes: routes,
    _findRoute(method, path) {
      return routes.find((r) => r.method === method && r.path === path);
    },
    async _inject({ method, url, headers = {}, payload }) {
      const route = app._findRoute(method, url);
      if (!route) return { statusCode: 404, json: () => ({ error: 'route_not_found' }) };
      const req = { method, url, headers, body: payload || null, user: null };
      const reply = {
        _statusCode: 200,
        _body: null,
        code(c) { reply._statusCode = c; return reply; },
        send(b) { reply._body = b; return reply; },
        header() { return reply; }
      };
      const onRequest = (route.opts && route.opts.onRequest) || [];
      for (const fn of onRequest) {
        await fn(req, reply);
        if (reply._body !== null) {
          return {
            statusCode: reply._statusCode,
            payload: JSON.stringify(reply._body),
            json: () => reply._body
          };
        }
      }
      try {
        const result = await route.handler(req, reply);
        if (result !== undefined && reply._body === null) reply._body = result;
        return {
          statusCode: reply._statusCode,
          payload: JSON.stringify(reply._body),
          json: () => reply._body
        };
      } catch (e) {
        return { statusCode: 500, json: () => ({ error: e.message }) };
      }
    }
  };
  return app;
}

let fastifyApp;

before(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(40);
  process.env.NODE_ENV = 'test';
  process.env.REPLICATE_API_TOKEN = 'fake_token_for_tests';
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost/test';

  installFetchMock();

  const dbMod = await import('../src/db.js');
  dbMod.pool.query = async (sql) => {
    dbCallLog.push({ sql: sql.replace(/\s+/g, ' ').trim() });
    if (/FROM users WHERE id/.test(sql)) {
      return { rows: mockUser ? [mockUser] : [] };
    }
    if (/SELECT COUNT\(\*\)/.test(sql) && /ai_usage/.test(sql)) {
      return { rows: [{ count: mockUsageCount }] };
    }
    if (/INSERT INTO ai_usage/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };

  const clipboardRoutes = (await import('../src/routes-clipboard.js')).default;
  fastifyApp = makeFakeFastify();
  fastifyApp.decorate('authenticate', async (req, reply) => {
    const u = req.headers['x-test-user'];
    if (!u) return reply.code(401).send({ error: 'non authentifié' });
    req.user = { sub: parseInt(u, 10) || u };
  });
  await fastifyApp.register(clipboardRoutes);
});

function reset() {
  mockUser = null;
  mockUsageCount = 0;
  mockReplicateBehavior = 'success';
  dbCallLog = [];
}

const TINY_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH8AAAH/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQI//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwE//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwE//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwI//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyE//9oADAMBAAIAAwAAABAAH//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8QP//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8QP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8QP//Z';

test('routes enregistrées', () => {
  const post = fastifyApp._findRoute('POST', '/api/ai/bg-swap');
  const getQ = fastifyApp._findRoute('GET', '/api/ai/bg-swap/quota');
  assert.ok(post, 'POST /api/ai/bg-swap manquant');
  assert.ok(getQ, 'GET /api/ai/bg-swap/quota manquant');
  assert.ok(Array.isArray(post.opts.onRequest));
});

test('POST sans JWT → 401', async () => {
  reset();
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 401);
});

test('POST avec auth + plan inactif → 402', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'inactive' };
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 402);
});

// v1.3.7 : starter/pro sans pack → 402 (pas 403) car ils PEUVENT acheter
// un pack Multipost IA. Le 403 historique ("feature not in plan") n'a plus
// de sens : tout le monde peut utiliser la feature s'il a des crédits packs.
test('POST avec plan starter sans pack → 402 (suggère achat pack)', async () => {
  reset();
  mockUser = { id: 1, plan: 'starter', plan_status: 'active' };
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 402);
  assert.match(res.json().error, /aucun crédit/i);
});

test('POST avec plan pro sans pack → 402', async () => {
  reset();
  mockUser = { id: 1, plan: 'pro', plan_status: 'active' };
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 402);
});

test('POST sans image_b64 → 400', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /image_b64/);
});

test('POST avec mediaType invalide → 400', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'application/pdf' }
  });
  assert.equal(res.statusCode, 400);
});

test('POST happy path → 200 + shape complet', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockReplicateBehavior = 'success';
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 200, 'got: ' + res.payload);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.image_b64, 'string');
  assert.ok(body.image_b64.length > 0);
  assert.equal(body.mediaType, 'image/png');
  assert.equal(typeof body.sizeBytes, 'number');
  assert.equal(typeof body.tookMs, 'number');
  const inserted = dbCallLog.find((c) => /INSERT INTO ai_usage/.test(c.sql));
  assert.ok(inserted, 'INSERT INTO ai_usage non émis');
});

test('POST quota dépassé → 429', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockUsageCount = 999;
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().limit, 150);
});

test('POST avec Replicate 500 → 502', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockReplicateBehavior = 'http-500';
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 502);
});

test('POST avec prediction failed → 502', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockReplicateBehavior = 'pred-failed';
  const res = await fastifyApp._inject({
    method: 'POST', url: '/api/ai/bg-swap',
    headers: { 'x-test-user': '1' },
    payload: { image_b64: TINY_B64, mediaType: 'image/jpeg' }
  });
  assert.equal(res.statusCode, 502);
});

test('GET /quota avec ultra → shape complet', async () => {
  reset();
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockUsageCount = 42;
  const res = await fastifyApp._inject({
    method: 'GET', url: '/api/ai/bg-swap/quota',
    headers: { 'x-test-user': '1' }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.plan, 'ultra');
  assert.equal(body.limit, 150);
  assert.equal(body.used, 42);
  assert.equal(body.remaining, 108);
});

test('GET /quota avec starter → limit=0', async () => {
  reset();
  mockUser = { id: 1, plan: 'starter', plan_status: 'active' };
  const res = await fastifyApp._inject({
    method: 'GET', url: '/api/ai/bg-swap/quota',
    headers: { 'x-test-user': '1' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().limit, 0);
});

test('GET /quota sans auth → 401', async () => {
  reset();
  const res = await fastifyApp._inject({
    method: 'GET', url: '/api/ai/bg-swap/quota'
  });
  assert.equal(res.statusCode, 401);
});
assert.equal(res.statusCode, 200);
  assert.equal(res.json().limit, 0);
});

test('GET /quota sans auth → 401', async () => {
  reset();
  const res = await fastifyApp._inject({
    method: 'GET', url: '/api/ai/bg-swap/quota'
  });
  assert.equal(res.statusCode, 401);
});
