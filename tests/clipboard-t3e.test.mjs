// Tests T3e : pipeline API Vinted (publication)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIP = pathResolve(__dirname, '../../astro-fix/modules/clipboard.js');
const UI = pathResolve(__dirname, '../../astro-fix/modules/clipboard-ui.js');
const clip = readFileSync(CLIP, 'utf8');
const ui = readFileSync(UI, 'utf8');

test('clipboard.js definit les helpers paste op', () => {
  assert.match(clip, /function _getPasteOp\(/);
  assert.match(clip, /function _setPasteOp\(/);
  assert.match(clip, /function _clearPasteOp\(/);
  assert.match(clip, /astro_clipboard_paste_op/);
});

test('clipboard.js a un getCsrfToken avec fallback UUID', () => {
  assert.match(clip, /function _getCsrfToken\(/);
  assert.match(clip, /meta\[name="csrf-token"\]/);
  assert.match(clip, /document\.cookie\.match/);
  // Fallback hardcoded UUID
  assert.match(clip, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
});

test('clipboard.js a les 4 endpoints API Vinted (photos, drafts POST/PATCH, completion)', () => {
  assert.match(clip, /function _uploadPhotoToVinted\(/);
  assert.match(clip, /function _createDraftVinted\(/);
  assert.match(clip, /function _patchDraftVinted\(/);
  assert.match(clip, /function _submitCompletionVinted\(/);
});

test('_uploadPhotoToVinted POST multipart vers /api/v2/photos', () => {
  const startIdx = clip.indexOf('async function _uploadPhotoToVinted');
  const endIdx = clip.indexOf('async function _createDraftVinted', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /\/api\/v2\/photos/);
  assert.match(body, /FormData/);
  assert.match(body, /method:\s*'POST'/);
  assert.match(body, /X-Csrf-Token/);
});

test('_createDraftVinted POST /api/v2/item_upload/drafts', () => {
  const startIdx = clip.indexOf('async function _createDraftVinted');
  const endIdx = clip.indexOf('async function _patchDraftVinted', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /\/api\/v2\/item_upload\/drafts/);
  assert.match(body, /method:\s*'POST'/);
  assert.match(body, /'Content-Type':\s*'application\/json'/);
});

test('_patchDraftVinted PATCH /api/v2/item_upload/drafts/{id} avec wrapper {draft:patch}', () => {
  const startIdx = clip.indexOf('async function _patchDraftVinted');
  const endIdx = clip.indexOf('async function _submitCompletionVinted', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /\/api\/v2\/item_upload\/drafts\/' \+ draftId/);
  assert.match(body, /method:\s*'PATCH'/);
  // Vinted exige le wrapper { draft: ... } (verifie en live)
  assert.match(body, /JSON\.stringify\(\{\s*draft:\s*patch\s*\}\)/);
});

test('_createDraftVinted POST avec wrapper {draft:{}} (verifie en live)', () => {
  const startIdx = clip.indexOf('async function _createDraftVinted');
  const endIdx = clip.indexOf('async function _patchDraftVinted', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /JSON\.stringify\(\{\s*draft:\s*\{\}\s*\}\)/);
});

test('_publishOneAnnonce envoie color1_id+color2_id (pas color_ids array)', () => {
  const startIdx = clip.indexOf('async function _publishOneAnnonce');
  const endIdx = clip.indexOf('async function _runColerOp', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /color1_id/);
  assert.match(body, /color2_id/);
  // Et utilise catalog_id (pas category_id) au PATCH
  assert.match(body, /patch\.catalog_id/);
});

test('_fetchAnnonceFullData lit color1_id+color2_id depuis Vinted', () => {
  const startIdx = clip.indexOf('async function _fetchAnnonceFullData');
  const endIdx = clip.indexOf('async function _runCopierOp', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /it\.color1_id/);
  assert.match(body, /it\.color2_id/);
  // catalog_id en priorite sur category_id
  assert.match(body, /it\.catalog_id\s*\|\|\s*it\.category_id/);
});

test('_submitCompletionVinted POST /completion', () => {
  const startIdx = clip.indexOf('async function _submitCompletionVinted');
  const endIdx = clip.indexOf('async function _publishOneAnnonce', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /\/completion/);
  assert.match(body, /method:\s*'POST'/);
});

test('_publishOneAnnonce orchestre upload N photos + draft + patch + completion', () => {
  const startIdx = clip.indexOf('async function _publishOneAnnonce');
  const endIdx = clip.indexOf('async function _runColerOp', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /getPhotoBlobForUpload/);
  assert.match(body, /_uploadPhotoToVinted/);
  assert.match(body, /_createDraftVinted/);
  assert.match(body, /_patchDraftVinted/);
  assert.match(body, /_submitCompletionVinted/);
  // Pause humaine entre photos (0.8-2s)
  assert.match(body, /sleep\(800/);
  // Patch contient les bons champs
  assert.match(body, /assigned_photos/);
  assert.match(body, /brand_id/);
  assert.match(body, /size_id/);
  assert.match(body, /category_id/);
  assert.match(body, /package_size_id/);
});

test('_runColerOp itere sur annoncesOverride avec pause humaine 3-7s', () => {
  const startIdx = clip.indexOf('async function _runColerOp');
  const endIdx = clip.indexOf('async function _initWorkerOrchestrator', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /annoncesOverride/);
  assert.match(body, /lotIdx/);
  assert.match(body, /_publishOneAnnonce/);
  // Pause 3-7s entre annonces
  assert.match(body, /sleep\(3000/);
  // Stages
  assert.match(body, /stage = 'running'/);
  assert.match(body, /stage = 'done'/);
  // Cancel check
  assert.match(body, /stage === 'cancelled'/);
  // Update progress
  assert.match(body, /publishedAnnonces/);
  assert.match(body, /currentAnnonce/);
});

test('_runColerOp gere 429 avec pause 5 min', () => {
  const startIdx = clip.indexOf('async function _runColerOp');
  const endIdx = clip.indexOf('async function _initWorkerOrchestrator', startIdx);
  const body = clip.slice(startIdx, endIdx);
  assert.match(body, /e\.status === 429/);
  assert.match(body, /5 \* 60 \* 1000/);
});

test('_initWorkerOrchestrator pickup BOTH copier et coller op', () => {
  const startIdx = clip.indexOf('async function _initWorkerOrchestrator');
  // L'orchestrator est appele en haut niveau juste apres : `_initWorkerOrchestrator().catch(`
  const endIdx = clip.indexOf('_initWorkerOrchestrator().catch(', startIdx + 50);
  assert.ok(startIdx >= 0 && endIdx > startIdx + 100, 'orchestrator block introuvable');
  const body = clip.slice(startIdx, endIdx);
  // Copier
  assert.match(body, /op\.type === 'copier'/);
  assert.match(body, /_runCopierOp/);
  // Coller
  assert.match(body, /pasteOp\.type === 'coller'/);
  assert.match(body, /_runColerOp/);
  // Staleness check sur les 2
  assert.match(body, /copier op stale/);
  assert.match(body, /coller op stale/);
});

test('clipboard-ui.js : listener storage astro_clipboard_paste_op', () => {
  assert.match(ui, /changes\.astro_clipboard_paste_op/);
  assert.match(ui, /Publication en cours/);
});

test('_onColerPublish ouvre progress modal + navigate worker tab', () => {
  const startIdx = ui.indexOf('async function _onColerPublish');
  const endIdx = ui.indexOf('function _autoInstall', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /openProgress/);
  assert.match(body, /MODIF_NAVIGATE_WORKER/);
  assert.match(body, /astro_worker=1/);
});

test('contrat T3e : op shape complet', () => {
  const startIdx = ui.indexOf('async function _onColerPublish');
  const endIdx = ui.indexOf('function _autoInstall', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /type:\s*'coller'/);
  assert.match(body, /stage:\s*'queued'/);
  assert.match(body, /lotId:\s*lot\.id/);
  assert.match(body, /bgConfig:/);
  assert.match(body, /annoncesOverride:\s*annoncesOverride/);
  assert.match(clip, /op\.annoncesOverride/);
  assert.match(clip, /op\.bgConfig/);
  assert.match(clip, /op\.lotId/);
});
