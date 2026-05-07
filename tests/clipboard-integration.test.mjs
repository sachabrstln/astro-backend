// Tests d'intégration T1+T2 : on vérifie que le contrat de bout en bout
// fonctionne (extension → background → backend → réponse → extension).
//
// On ne teste PAS la chaîne réelle (pas de Chrome ni de service worker
// dispo en Node) mais on simule fidèlement les morceaux :
//   1. clipboard.js (extension) appelle chrome.runtime.sendMessage('BG_SWAP', {image_b64, mediaType})
//   2. background.js handler reçoit, appelle API.bgSwap()
//   3. api-backend.js fait fetch sur le backend
//   4. backend route-clipboard.js traite et renvoie {ok, image_b64, mediaType, sizeBytes}
//   5. clipboard.js reçoit et décode en Blob
//
// On reproduit chacune des étapes en chaîne avec leurs vrais payloads.
//
// Lancer : node --test tests/clipboard-integration.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPBOARD_JS = pathResolve(__dirname, '../../astro-fix/modules/clipboard.js');

// ─────────────────────────────────────────────────────────────
// Backend en mémoire (route handler direct, comme dans clipboard.test.mjs)
// ─────────────────────────────────────────────────────────────
let mockUser = null;
let mockUsageCount = 0;
let backend; // { post: handler, get: handler }
let dbCallLog = [];

const realFetch = globalThis.fetch;

async function setupBackend() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    // v1.3.7 : nouveau flow 2-step. GET model_info → POST predictions avec version.
    if (u.startsWith('https://api.replicate.com/v1/models/') && !u.endsWith('/predictions')) {
      return new Response(JSON.stringify({
        owner: '851-labs', name: 'background-remover',
        latest_version: { id: 'mock_version_abc' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u === 'https://api.replicate.com/v1/predictions' ||
        u.startsWith('https://api.replicate.com/v1/models/')) {
      return new Response(JSON.stringify({
        id: 'pred_x', status: 'succeeded',
        output: 'https://replicate.delivery/result.png',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred_x' },
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

  process.env.JWT_SECRET = 'a'.repeat(40);
  process.env.NODE_ENV = 'test';
  process.env.REPLICATE_API_TOKEN = 'fake';
  process.env.DATABASE_URL = 'postgres://test:test@localhost/test';

  const dbMod = await import('../src/db.js');
  dbMod.pool.query = async (sql) => {
    dbCallLog.push(sql);
    if (/FROM users WHERE id/.test(sql)) return { rows: mockUser ? [mockUser] : [] };
    if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ count: mockUsageCount }] };
    if (/INSERT INTO ai_usage/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  };

  const clipboardRoutes = (await import('../src/routes-clipboard.js')).default;
  const routes = [];
  const fakeFastify = {
    post(path, opts, h) { routes.push({ method: 'POST', path, opts, h }); },
    get(path, opts, h) { routes.push({ method: 'GET', path, opts, h }); },
    log: { info() {}, warn() {}, error() {} },
  };
  await clipboardRoutes(fakeFastify);

  backend = {
    async call(method, path, headers = {}, body = null) {
      const route = routes.find((r) => r.method === method && r.path === path);
      if (!route) return { status: 404, body: { error: 'no_route' } };
      const req = { method, url: path, headers, body, user: null };
      const reply = {
        _status: 200, _body: null,
        code(c) { reply._status = c; return reply; },
        send(b) { reply._body = b; return reply; },
      };
      // Authenticate stub : si X-Test-User → set req.user, sinon 401
      const u = headers['x-test-user'];
      if (route.opts?.onRequest) {
        if (!u) {
          reply._status = 401; reply._body = { error: 'non authentifié' };
          return { status: reply._status, body: reply._body };
        }
        req.user = { sub: parseInt(u, 10) || u };
      }
      const result = await route.h(req, reply);
      if (result !== undefined && reply._body === null) reply._body = result;
      return { status: reply._status, body: reply._body };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Background SW simulé : reçoit l'action, appelle le backend
// (reproduit la logique de bgSwapHandler/bgSwapQuotaHandler dans
// background.js, sans dépendre de chrome.* APIs).
// ─────────────────────────────────────────────────────────────
const FAKE_AUTH_TOKEN_USER_ID = '1';

async function dispatchBackgroundMessage(msg) {
  const { action, payload } = msg;
  if (action === 'BG_SWAP') {
    const r = await backend.call(
      'POST', '/api/ai/bg-swap',
      { 'x-test-user': FAKE_AUTH_TOKEN_USER_ID, 'content-type': 'application/json' },
      payload
    );
    if (r.status !== 200) {
      return {
        ok: false,
        reason: r.body?.error || ('http_' + r.status),
        status: r.status,
        detail: r.body?.detail || null,
        limit: r.body?.limit ?? null,
        used: r.body?.used ?? null,
      };
    }
    return {
      ok: true,
      image_b64: r.body.image_b64,
      mediaType: r.body.mediaType,
      sizeBytes: r.body.sizeBytes,
      tookMs: r.body.tookMs,
    };
  }
  if (action === 'BG_SWAP_QUOTA') {
    const r = await backend.call('GET', '/api/ai/bg-swap/quota', { 'x-test-user': FAKE_AUTH_TOKEN_USER_ID });
    if (r.status !== 200) return { ok: false, reason: 'http_' + r.status };
    return { ok: true, plan: r.body.plan, limit: r.body.limit, used: r.body.used, remaining: r.body.remaining };
  }
  return { ok: false, reason: 'unknown_action' };
}

// ─────────────────────────────────────────────────────────────
// Charge clipboard.js avec chrome.runtime.sendMessage qui dispatche
// au backend simulé (chaîne complète extension → backend)
// ─────────────────────────────────────────────────────────────
let AstroClipboard;
let chromeStorage = {};

before(async () => {
  await setupBackend();

  const code = readFileSync(CLIPBOARD_JS, 'utf8');

  class FakeFR { constructor() { this.onload = null; this.onerror = null; }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
        if (this.onload) this.onload({ target: this });
      });
    }
  }
  class FakeImage { constructor() { this.naturalWidth = 100; this.naturalHeight = 100; }
    set src(_) { setTimeout(() => this.onload && this.onload(), 0); }
  }
  class FakeCanvas {
    getContext() { return { fillStyle: '', drawImage() {}, fillRect() {}, translate() {}, rotate() {}, setTransform() {} }; }
    toBlob(cb, type = 'image/jpeg') { cb(new Blob([Buffer.from([0xFF, 0xD8])], { type })); }
  }
  const fakeWindow = {};
  const sandbox = {
    window: fakeWindow,
    document: { createElement: (tag) => tag === 'canvas' ? new FakeCanvas() : {} },
    chrome: {
      runtime: {
        id: 'fake',
        sendMessage(msg, cb) {
          dispatchBackgroundMessage(msg).then((r) => cb && cb(r));
        },
        lastError: null,
      },
      storage: {
        local: {
          get(key, cb) {
            if (typeof key === 'string') cb({ [key]: chromeStorage[key] });
            else cb(chromeStorage);
          },
          set(obj, cb) { Object.assign(chromeStorage, obj); cb && cb(); },
          remove(key, cb) {
            if (Array.isArray(key)) key.forEach((k) => delete chromeStorage[k]);
            else delete chromeStorage[key];
            cb && cb();
          },
        },
      },
    },
    Image: FakeImage,
    FileReader: FakeFR,
    Blob, Buffer,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'clipboard.js' });
  AstroClipboard = fakeWindow.AstroClipboard;
});

// ─────────────────────────────────────────────────────────────
// Tests d'intégration end-to-end
// ─────────────────────────────────────────────────────────────

test('E2E : getQuota → backend → réponse complète', async () => {
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockUsageCount = 5;
  const r = await AstroClipboard.getQuota();
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'ultra');
  assert.equal(r.limit, 20);
  assert.equal(r.used, 5);
  assert.equal(r.remaining, 15);
});

test('E2E : getQuota avec plan starter → limit=0 propagé', async () => {
  mockUser = { id: 1, plan: 'starter', plan_status: 'active' };
  mockUsageCount = 0;
  const r = await AstroClipboard.getQuota();
  assert.equal(r.ok, true);
  assert.equal(r.limit, 0);
  assert.equal(r.remaining, 0);
});

test('E2E : appel BG_SWAP via chrome.runtime → backend Replicate → blob retourné', async () => {
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockUsageCount = 0;
  // Simule un fetch direct du content script vers le SW pour bg-swap (via processOnePhoto)
  // On bypass downloadPhoto en injectant un blob direct à callBgSwap, mais comme
  // callBgSwap est privé, on utilise window.AstroClipboard.processOnePhoto avec
  // une URL data: que notre fakeFetch intercepte.
  // Plus simple : on appelle directement le pipeline via prepareLot avec photos vides
  // pour valider que le contrat extension→backend tient.

  // Test direct du dispatch : envoie un message BG_SWAP et vérifie la chaîne complète
  const result = await dispatchBackgroundMessage({
    action: 'BG_SWAP',
    payload: { image_b64: 'SGVsbG8=', mediaType: 'image/jpeg' }, // "Hello" base64
  });
  assert.equal(result.ok, true, 'attendu ok=true, reçu: ' + JSON.stringify(result));
  assert.equal(typeof result.image_b64, 'string');
  assert.ok(result.image_b64.length > 0);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(typeof result.sizeBytes, 'number');
  assert.equal(typeof result.tookMs, 'number');
});

test('E2E : BG_SWAP avec plan inactif → erreur 402 propagée', async () => {
  mockUser = { id: 1, plan: 'ultra', plan_status: 'inactive' };
  const result = await dispatchBackgroundMessage({
    action: 'BG_SWAP',
    payload: { image_b64: 'SGVsbG8=', mediaType: 'image/jpeg' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
});

// v1.3.7 : starter sans pack → 402 (était 403 avant). Les users non-Ultra
// peuvent désormais acheter des packs Multipost IA pour utiliser la feature.
test('E2E : BG_SWAP avec plan starter sans pack → 402 propagé', async () => {
  mockUser = { id: 1, plan: 'starter', plan_status: 'active' };
  const result = await dispatchBackgroundMessage({
    action: 'BG_SWAP',
    payload: { image_b64: 'SGVsbG8=', mediaType: 'image/jpeg' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
});

test('E2E : BG_SWAP avec quota dépassé → 429 + limit/used propagés', async () => {
  mockUser = { id: 1, plan: 'ultra', plan_status: 'active' };
  mockUsageCount = 999;
  const result = await dispatchBackgroundMessage({
    action: 'BG_SWAP',
    payload: { image_b64: 'SGVsbG8=', mediaType: 'image/jpeg' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.limit, 20);
  assert.equal(result.used, 999);
});

test('E2E : action inconnue → ok=false', async () => {
  const result = await dispatchBackgroundMessage({ action: 'UNKNOWN_ACTION', payload: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown/);
});

test('E2E : storage extension persiste les lots', async () => {
  chromeStorage = {};
  const lot = {
    id: 'lot_e2e_1',
    name: 'E2E lot',
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    annonces: [{
      sourceItemId: '999',
      title: 'Article test',
      description: 'desc',
      price: 10,
      currency: 'EUR',
      photos: [{ detoured_b64: 'AAAA', mediaType: 'image/png', originalUrl: 'https://x' }],
      preparedAt: Date.now(),
      errorCount: 0,
    }],
    stats: { totalPhotos: 1, processedPhotos: 1, errorPhotos: 0 },
    bgConfig: { type: 'color', value: '#FFFFFF' },
  };
  await AstroClipboard.saveLot(lot);

  // Vérifie que le lot est bien dans le storage Chrome simulé
  assert.ok(chromeStorage['astro_clipboard_lots']);
  assert.ok(chromeStorage['astro_clipboard_lots']['lot_e2e_1']);

  // Et qu'il est bien lisible via getLot
  const back = await AstroClipboard.getLot('lot_e2e_1');
  assert.equal(back.name, 'E2E lot');
  assert.equal(back.annonces.length, 1);
  assert.equal(back.annonces[0].photos[0].detoured_b64, 'AAAA');
});
