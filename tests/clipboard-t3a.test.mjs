// Tests T3a : modal Copier (apres extraction dans modules/clipboard-ui.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIP_UI = pathResolve(__dirname, '../../astro-fix/modules/clipboard-ui.js');
const CONTENT = pathResolve(__dirname, '../../astro-fix/modules/content.js');
const ui = readFileSync(CLIP_UI, 'utf8');
const content = readFileSync(CONTENT, 'utf8');

test('clipboard-ui.js definit buildCopierModal/openCopierModal/launchCopier/loadCopierQuota', () => {
  assert.match(ui, /function buildCopierModal\(\)/);
  assert.match(ui, /function openCopierModal\(\)/);
  assert.match(ui, /async function launchCopier\(\)/);
  assert.match(ui, /async function loadCopierQuota\(/);
});

test('content.js expose window.__astroBus avec les helpers necessaires', () => {
  assert.match(content, /window\.__astroBus\s*=\s*\{/);
  assert.match(content, /isWorkerTab:/);
  assert.match(content, /getStore:/);
  assert.match(content, /getSelectedIds:/);
  assert.match(content, /openProgress:/);
  assert.match(content, /updateProgress:/);
  assert.match(content, /doneProgress:/);
  assert.match(content, /toast:/);
  assert.match(content, /addToolbarButton:/);
  assert.match(content, /registerSelGoHandler:/);
  assert.match(content, /exitSelection:/);
});

test('content.js a un dispatcher dynamique pour les selGo handlers', () => {
  assert.match(content, /_selGoHandlers\[selectionTarget\]/);
});

test('content.js NE contient plus la modal Copier (extraite ailleurs)', () => {
  assert.doesNotMatch(content, /function buildCopierModal/);
  assert.doesNotMatch(content, /function openCopierModal/);
  assert.doesNotMatch(content, /async function launchCopier/);
  assert.doesNotMatch(content, /async function loadCopierQuota/);
});

test('clipboard-ui.js consomme uniquement window.__astroBus (pas de couplage interne content.js)', () => {
  assert.match(ui, /window\.__astroBus/);
  assert.match(ui, /addToolbarButton/);
  assert.match(ui, /registerSelGoHandler/);
});

test('clipboard-ui.js auto-installe : whenReady + skip si worker tab', () => {
  assert.match(ui, /_whenReady/);
  assert.match(ui, /isWorkerTab\?\.\(\)/);
});

test('Le modal contient 4 fonds preset', () => {
  assert.match(ui, /data-bg-name="Blanc"/);
  assert.match(ui, /data-bg-name="Gris clair"/);
  assert.match(ui, /data-bg-name="Beige"/);
  assert.match(ui, /data-bg-name="Noir"/);
  assert.match(ui, /data-bg-color="#FFFFFF"/);
  assert.match(ui, /data-bg-color="#F0F0F2"/);
  assert.match(ui, /data-bg-color="#EDE5DC"/);
  assert.match(ui, /data-bg-color="#1A1A2E"/);
});

test('loadCopierQuota appelle BG_SWAP_QUOTA via chrome.runtime.sendMessage', () => {
  assert.match(ui, /chrome\.runtime\.sendMessage\(\{\s*action:\s*'BG_SWAP_QUOTA'\s*\}/);
});

test('launchCopier construit une op avec le bon shape', () => {
  const startIdx = ui.indexOf('async function launchCopier');
  const endIdx = ui.indexOf('Listener storage', startIdx);
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'launchCopier non trouve');
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /type:\s*'copier'/);
  assert.match(body, /stage:\s*'queued'/);
  assert.match(body, /startedAt:\s*Date\.now\(\)/);
  assert.match(body, /lastTickAt:\s*Date\.now\(\)/);
  assert.match(body, /lotName/);
  assert.match(body, /bgConfig/);
  assert.match(body, /sourceCompteId/);
  assert.match(body, /sourceCompteLogin/);
});

test('launchCopier persiste astro_clipboard_op et declenche MODIF_NAVIGATE_WORKER', () => {
  assert.match(ui, /chrome\.storage\.local\.set\(\{\s*astro_clipboard_op:\s*op\s*\}/);
  assert.match(ui, /action:\s*'MODIF_NAVIGATE_WORKER'/);
  assert.match(ui, /astro_worker=1/);
});

test('Listener progression cross-tab dans clipboard-ui.js (pas dans content.js)', () => {
  assert.match(ui, /_installProgressListener/);
  assert.match(ui, /astro_clipboard_op/);
  // Ne doit PAS etre dans content.js
  assert.doesNotMatch(content, /changes\.astro_clipboard_op/);
});

test('manifest.json inclut clipboard-ui.js dans les content scripts', () => {
  const manifest = JSON.parse(readFileSync(pathResolve(__dirname, '../../astro-fix/manifest.json'), 'utf8'));
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes('modules/clipboard-ui.js'), 'clipboard-ui.js manquant dans manifest');
  // Ordre : clipboard.js doit etre AVANT clipboard-ui.js (car ce dernier depend de window.AstroClipboard)
  const clipIdx = js.indexOf('modules/clipboard.js');
  const uiIdx = js.indexOf('modules/clipboard-ui.js');
  assert.ok(clipIdx < uiIdx, 'clipboard.js doit etre charge avant clipboard-ui.js');
});

test('content.js a perdu ~340 lignes (extraction)', () => {
  const lines = content.split('\n').length;
  // Apres extraction on doit etre autour de 6500 lignes (etait ~6735 avant)
  assert.ok(lines < 6700, 'content.js fait ' + lines + ' lignes, attendu < 6700 apres extraction');
});
