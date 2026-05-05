// Tests T3b : worker orchestrator + progression cross-tab.
// On charge clipboard.js dans un VM avec sessionStorage='astro_worker_tab=1'
// pour simuler le worker tab. On pose une op queued, et on verifie que
// l'orchestrator la pickup, fetch les annonces (fetch mocke), lance prepareLot
// (avec callBgSwap mocke), et passe l'op stage par queued -> running -> done
// avec progress sync.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPBOARD_JS = pathResolve(__dirname, '../../astro-fix/modules/clipboard.js');

let sandbox;
let chromeStorage;
let opUpdates; // historique des op.stage observes pour assertions
let bgSwapCalls;
let fetchedItemIds;

function makeSandbox(opts) {
  opts = opts || {};
  chromeStorage = opts.initialStorage || {};
  opUpdates = [];
  bgSwapCalls = 0;
  fetchedItemIds = [];

  class FakeFR {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(buf).toString('base64');
        if (this.onload) this.onload({ target: this });
      });
    }
  }
  class FakeImage {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 100; }
    set src(_v) { setTimeout(() => this.onload && this.onload(), 0); }
  }
  class FakeCanvas {
    getContext() { return { fillStyle: '', drawImage() {}, fillRect() {}, translate() {}, rotate() {}, setTransform() {} }; }
    toBlob(cb, type) { cb(new Blob([Buffer.from([0xFF, 0xD8])], { type: type || 'image/jpeg' })); }
  }

  const fakeWindow = {};
  const fakeSessionStorage = {
    _data: opts.workerMode ? { astro_worker_tab: '1' } : {},
    getItem(k) { return this._data[k] !== undefined ? this._data[k] : null; },
    setItem(k, v) { this._data[k] = String(v); },
  };
  const fakeLocation = {
    origin: 'https://www.vinted.fr',
    search: opts.workerMode ? '?astro_worker=1' : '',
  };

  const sb = {
    window: fakeWindow,
    document: { createElement: (t) => t === 'canvas' ? new FakeCanvas() : {} },
    sessionStorage: fakeSessionStorage,
    location: fakeLocation,
    chrome: {
      runtime: {
        id: 'fake',
        sendMessage(msg, cb) {
          if (msg.action === 'BG_SWAP') {
            bgSwapCalls++;
            // Simule une reponse OK avec un PNG factice
            const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C636400000000050001A5F645400000000049454E44AE426082', 'hex');
            setTimeout(() => cb && cb({ ok: true, image_b64: png.toString('base64'), mediaType: 'image/png', sizeBytes: png.length, tookMs: 100 }), 0);
            return;
          }
          if (msg.action === 'FETCH_PHOTO') {
            const buf = Buffer.from([0xFF, 0xD8, 0xFF]);
            setTimeout(() => cb && cb({ ok: true, base64: buf.toString('base64'), mediaType: 'image/jpeg', sizeBytes: buf.length }), 0);
            return;
          }
          setTimeout(() => cb && cb({ ok: false, reason: 'no_handler' }), 0);
        },
        lastError: null,
      },
      storage: {
        local: {
          get(key, cb) {
            if (typeof key === 'string') cb({ [key]: chromeStorage[key] });
            else cb(chromeStorage);
          },
          set(obj, cb) {
            // Trace des changements de astro_clipboard_op pour assertions
            if (obj.astro_clipboard_op !== undefined) {
              opUpdates.push({
                stage: obj.astro_clipboard_op?.stage,
                progress: obj.astro_clipboard_op?.progress ? { ...obj.astro_clipboard_op.progress } : null,
                lotId: obj.astro_clipboard_op?.lotId,
                error: obj.astro_clipboard_op?.error,
              });
            }
            Object.assign(chromeStorage, obj);
            cb && cb();
          },
          remove(key, cb) {
            if (Array.isArray(key)) key.forEach((k) => delete chromeStorage[k]);
            else delete chromeStorage[key];
            cb && cb();
          },
        },
      },
    },
    fetch: async (url) => {
      const u = String(url);
      // Vinted item_upload/items/{id}
      const m = u.match(/\/api\/v2\/item_upload\/items\/(\d+)/);
      if (m) {
        fetchedItemIds.push(m[1]);
        return new Response(JSON.stringify({
          item: {
            id: m[1],
            title: 'Test annonce ' + m[1],
            description: 'desc test',
            price: { amount: '15.00', currency_code: 'EUR' },
            brand_id: 12, brand_title: 'Nike',
            size_id: 1, size_title: 'M',
            category_id: 100,
            status_id: 6,
            package_size_id: 2,
            color_ids: [10],
            photos: [{ full_size_url: 'https://images1.vinted.net/foo.jpg' }],
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Photos vinted
      if (u.startsWith('https://images1.vinted.net/')) {
        return new Response(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response(null, { status: 404 });
    },
    Image: FakeImage, FileReader: FakeFR,
    Blob, Buffer, Response,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sb);
  return { sandbox: sb, fakeWindow };
}

test('worker tab pickup une op queued + transitions stage queued->running->done', async () => {
  const initialOp = {
    type: 'copier',
    stage: 'queued',
    startedAt: Date.now(),
    lastTickAt: Date.now(),
    queue: [{ itemId: '111', title: 'A1' }, { itemId: '222', title: 'A2' }],
    opts: { lotName: 'TestLot', bgConfig: { type: 'color', value: '#FFFFFF' }, sourceCompteId: 'c_1', sourceCompteLogin: 'tester' },
    progress: { totalPhotos: 0, processedPhotos: 0, errorPhotos: 0, currentAnnonce: 0 },
  };
  const { sandbox: sb, fakeWindow } = makeSandbox({
    workerMode: true,
    initialStorage: { astro_clipboard_op: initialOp },
  });

  const code = readFileSync(CLIPBOARD_JS, 'utf8');
  vm.runInContext(code, sb, { filename: 'clipboard.js' });

  // L'orchestrator demarre via setTimeout(1500ms). On wait jusqu'a 8 sec
  // pour laisser fetch + bg-swap + prepareLot finir (avec save grace 4s).
  await new Promise((r) => setTimeout(r, 8000));

  const stages = opUpdates.map((u) => u.stage).filter((s, i, arr) => i === 0 || s !== arr[i-1]);
  // On doit voir au moins queued -> running -> done dans l'ordre
  assert.ok(stages.includes('running'), 'stage running attendu, got: ' + stages.join(','));
  assert.ok(stages.includes('done'), 'stage done attendu, got: ' + stages.join(','));

  // 2 annonces fetchees via API Vinted
  assert.deepEqual(fetchedItemIds, ['111', '222'], 'items fetches: ' + fetchedItemIds.join(','));

  // bg-swap appele 2x (1 photo par annonce dans le mock)
  assert.equal(bgSwapCalls, 2, 'bg-swap appels');

  // Apres done + 4s grace, l'op doit etre clearee
  // Mais on a wait que 8s donc encore presente — verifie au moins lotId set
  const finalOp = chromeStorage.astro_clipboard_op;
  if (finalOp) {
    assert.ok(finalOp.lotId, 'lotId set sur op done');
    assert.equal(finalOp.stage, 'done');
  }

  // Le lot est dans astro_clipboard_lots
  const lots = chromeStorage.astro_clipboard_lots || {};
  const lotIds = Object.keys(lots);
  assert.equal(lotIds.length, 1, 'un lot cree');
  const lot = lots[lotIds[0]];
  assert.equal(lot.name, 'TestLot');
  assert.equal(lot.annonces.length, 2);
  assert.equal(lot.sourceCompteId, 'c_1');
  // Photo detouree presente en base64
  assert.ok(lot.annonces[0].photos[0].detoured_b64, 'photo detouree b64 present');
});

test('non-worker tab ne pickup pas l op', async () => {
  const initialOp = {
    type: 'copier',
    stage: 'queued',
    startedAt: Date.now(),
    lastTickAt: Date.now(),
    queue: [{ itemId: '999', title: 'X' }],
    opts: { bgConfig: { type: 'color', value: '#FFFFFF' } },
    progress: {},
  };
  const { sandbox: sb } = makeSandbox({
    workerMode: false, // user tab
    initialStorage: { astro_clipboard_op: initialOp },
  });
  vm.runInContext(readFileSync(CLIPBOARD_JS, 'utf8'), sb, { filename: 'clipboard.js' });
  await new Promise((r) => setTimeout(r, 2500));

  // L'op reste en queued (pas touchee), aucun fetch
  assert.equal(fetchedItemIds.length, 0);
  assert.equal(bgSwapCalls, 0);
  const op = chromeStorage.astro_clipboard_op;
  assert.equal(op?.stage, 'queued');
});

test('staleness : op > 30 min est cleanup au pickup', async () => {
  const oldOp = {
    type: 'copier',
    stage: 'queued',
    startedAt: Date.now() - 35 * 60 * 1000, // 35 min ago
    lastTickAt: Date.now() - 35 * 60 * 1000,
    queue: [{ itemId: '999', title: 'X' }],
    opts: {}, progress: {},
  };
  const { sandbox: sb } = makeSandbox({
    workerMode: true,
    initialStorage: { astro_clipboard_op: oldOp },
  });
  vm.runInContext(readFileSync(CLIPBOARD_JS, 'utf8'), sb, { filename: 'clipboard.js' });
  await new Promise((r) => setTimeout(r, 2500));

  // Op clearee (stale)
  assert.equal(chromeStorage.astro_clipboard_op, undefined);
  // Pas de fetch lance
  assert.equal(fetchedItemIds.length, 0);
});

test('op stage != queued (ex : running) : pas de re-pickup', async () => {
  const runningOp = {
    type: 'copier',
    stage: 'running', // deja en cours ailleurs
    startedAt: Date.now() - 30000,
    lastTickAt: Date.now() - 5000,
    queue: [{ itemId: '999', title: 'X' }],
    opts: {}, progress: {},
  };
  const { sandbox: sb } = makeSandbox({
    workerMode: true,
    initialStorage: { astro_clipboard_op: runningOp },
  });
  vm.runInContext(readFileSync(CLIPBOARD_JS, 'utf8'), sb, { filename: 'clipboard.js' });
  await new Promise((r) => setTimeout(r, 2500));

  // Op reste running, pas de fetch
  assert.equal(fetchedItemIds.length, 0);
  assert.equal(bgSwapCalls, 0);
  assert.equal(chromeStorage.astro_clipboard_op?.stage, 'running');
});
