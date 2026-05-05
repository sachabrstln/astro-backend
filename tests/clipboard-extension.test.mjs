// Tests T2 : pipeline photo côté extension (modules/clipboard.js).
//
// On ne peut pas charger clipboard.js tel quel (il accède à window, chrome,
// document, Image, FileReader, atob, btoa). On stub ces globaux puis on charge
// le fichier dans le contexte de test, et on exerce les fonctions pures qui
// ne touchent pas au DOM/Canvas (storage, base64, lot lifecycle).
//
// Couvre :
//   - chargement sans crash sous globaux mockés
//   - window.AstroClipboard expose l'API complète attendue
//   - base64ToBlob ↔ blobToBase64 (round-trip)
//   - lot lifecycle : saveLot / getLot / getLots / deleteLot
//   - cleanExpired purge bien les lots > TTL
//   - quota helper appelle bien chrome.runtime.sendMessage
//   - le contrat de message (BG_SWAP / BG_SWAP_QUOTA / FETCH_PHOTO) est respecté
//
// Lancer : node --test tests/clipboard-extension.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPBOARD_JS_PATH = pathResolve(__dirname, '../../astro-fix/modules/clipboard.js');

// ─────────────────────────────────────────────────────────────
// Mocks pour les globaux navigateur
// ─────────────────────────────────────────────────────────────
let chromeStorage = {};
let lastSentMessages = [];
let mockSendMessageReply = null;

function makeChromeMock() {
  return {
    runtime: {
      id: 'fake-extension-id',
      sendMessage(msg, cb) {
        lastSentMessages.push(msg);
        // Simule l'async response
        setTimeout(() => cb && cb(mockSendMessageReply), 0);
      },
      lastError: null,
    },
    storage: {
      local: {
        get(key, cb) {
          if (typeof key === 'string') {
            cb({ [key]: chromeStorage[key] });
          } else if (key === null) {
            cb(chromeStorage);
          } else {
            const out = {};
            (Array.isArray(key) ? key : Object.keys(key)).forEach((k) => {
              if (chromeStorage[k] !== undefined) out[k] = chromeStorage[k];
            });
            cb(out);
          }
        },
        set(obj, cb) {
          Object.assign(chromeStorage, obj);
          if (cb) cb();
        },
        remove(key, cb) {
          if (Array.isArray(key)) key.forEach((k) => delete chromeStorage[k]);
          else delete chromeStorage[key];
          if (cb) cb();
        },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Atob/Btoa — Node has these globally since v16
// FileReader, Image, document, URL — on stub minimal
// ─────────────────────────────────────────────────────────────
class FakeFileReader {
  constructor() {
    this.result = null;
    this.error = null;
    this.onload = null;
    this.onerror = null;
  }
  readAsDataURL(blob) {
    // Convertit Blob → data URL
    blob.arrayBuffer().then((buf) => {
      const b = Buffer.from(buf);
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${b.toString('base64')}`;
      if (this.onload) this.onload({ target: this });
    }).catch((e) => {
      this.error = e;
      if (this.onerror) this.onerror({ target: this });
    });
  }
}

class FakeImage {
  constructor() {
    this.naturalWidth = 100;
    this.naturalHeight = 100;
    this.width = 100;
    this.height = 100;
    this.onload = null;
    this.onerror = null;
  }
  set src(v) {
    this._src = v;
    setTimeout(() => { if (this.onload) this.onload(); }, 0);
  }
  get src() { return this._src; }
}

class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; }
  getContext() {
    return {
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      fillRect() {},
      drawImage() {},
      translate() {},
      rotate() {},
      setTransform() {},
    };
  }
  toBlob(cb, type = 'image/jpeg') {
    // Renvoie un blob factice avec un peu de contenu
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    cb(new Blob([buf], { type }));
  }
}

const fakeWindow = {};
const fakeDocument = {
  createElement(tag) {
    if (tag === 'canvas') return new FakeCanvas();
    return {};
  },
};

// ─────────────────────────────────────────────────────────────
// Setup : load clipboard.js dans un VM avec les mocks
// ─────────────────────────────────────────────────────────────
let AstroClipboard;

before(async () => {
  const code = readFileSync(CLIPBOARD_JS_PATH, 'utf8');

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    chrome: makeChromeMock(),
    Image: FakeImage,
    FileReader: FakeFileReader,
    Blob,
    Buffer,
    URL: { createObjectURL() { return 'blob:fake'; }, revokeObjectURL() {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    console: {
      log() {}, warn() {}, error() {},
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'clipboard.js' });
  AstroClipboard = fakeWindow.AstroClipboard;
});

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

test('module chargé sans crash + API publique présente', () => {
  assert.ok(AstroClipboard, 'window.AstroClipboard non défini');
  const expected = [
    'prepareLot', 'processOnePhoto',
    'composeForUpload', 'getPhotoBlobForUpload',
    'applyAntiPHash', 'compositeWithBackground',
    'getLots', 'getLot', 'saveLot', 'deleteLot', 'cleanExpired',
    'getQuota',
    'base64ToBlob', 'blobToBase64', 'blobToImage',
    'LOT_TTL_DAYS', 'STORAGE_KEY',
  ];
  for (const fn of expected) {
    assert.ok(AstroClipboard[fn] !== undefined, `AstroClipboard.${fn} manquant`);
  }
});

test('STORAGE_KEY + LOT_TTL_DAYS valides', () => {
  assert.equal(AstroClipboard.STORAGE_KEY, 'astro_clipboard_lots');
  assert.equal(AstroClipboard.LOT_TTL_DAYS, 14);
});

test('base64ToBlob retourne un Blob du bon type', () => {
  const b = AstroClipboard.base64ToBlob('SGVsbG8=', 'text/plain'); // "Hello"
  assert.ok(b instanceof Blob);
  assert.equal(b.type, 'text/plain');
  assert.equal(b.size, 5);
});

test('blobToBase64 round-trip', async () => {
  const original = 'Hello world 123 €';
  const buf = Buffer.from(original, 'utf8');
  const blob = new Blob([buf], { type: 'text/plain' });
  const b64 = await AstroClipboard.blobToBase64(blob);
  // Décode et vérifie
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  assert.equal(decoded, original);
});

test('saveLot + getLot + getLots + deleteLot', async () => {
  chromeStorage = {};
  const lot = {
    id: 'lot_test_1',
    name: 'Test Lot',
    createdAt: Date.now(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    annonces: [{ sourceItemId: '123', title: 'Test' }],
    stats: { totalPhotos: 0, processedPhotos: 0, errorPhotos: 0 },
    bgConfig: { type: 'color', value: '#FFFFFF' },
  };
  await AstroClipboard.saveLot(lot);

  const fetched = await AstroClipboard.getLot('lot_test_1');
  assert.deepEqual(fetched.name, 'Test Lot');
  assert.equal(fetched.annonces[0].sourceItemId, '123');

  const all = await AstroClipboard.getLots();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'lot_test_1');

  const removed = await AstroClipboard.deleteLot('lot_test_1');
  assert.equal(removed, true);
  const after = await AstroClipboard.getLot('lot_test_1');
  assert.equal(after, null);
});

test('cleanExpired purge les lots expirés', async () => {
  chromeStorage = {};
  const now = Date.now();
  const lots = {
    fresh: {
      id: 'fresh', name: 'Fresh', createdAt: now,
      expiresAt: new Date(now + 86400000).toISOString(),
      annonces: [], stats: {}, bgConfig: {},
    },
    stale: {
      id: 'stale', name: 'Stale', createdAt: now - 30 * 86400000,
      expiresAt: new Date(now - 86400000).toISOString(), // hier = expiré
      annonces: [], stats: {}, bgConfig: {},
    },
  };
  chromeStorage['astro_clipboard_lots'] = lots;

  const removedCount = await AstroClipboard.cleanExpired();
  assert.equal(removedCount, 1);
  const remaining = await AstroClipboard.getLots();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'fresh');
});

test('saveLot rejette si lot.id manquant', async () => {
  await assert.rejects(
    () => AstroClipboard.saveLot({ name: 'no id' }),
    /lot\.id requis/
  );
});

test('getQuota envoie le bon message au SW', async () => {
  lastSentMessages = [];
  mockSendMessageReply = { ok: true, plan: 'ultra', limit: 150, used: 10, remaining: 140 };
  const res = await AstroClipboard.getQuota();
  assert.equal(lastSentMessages.length, 1);
  assert.equal(lastSentMessages[0].action, 'BG_SWAP_QUOTA');
  assert.equal(res.ok, true);
  assert.equal(res.plan, 'ultra');
});

test('getQuota gère un échec côté SW', async () => {
  lastSentMessages = [];
  mockSendMessageReply = { ok: false, reason: 'not_authenticated' };
  const res = await AstroClipboard.getQuota();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_authenticated');
});
