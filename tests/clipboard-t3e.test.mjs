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

test('_publishOneAnnonce + _buildDraftBody utilisent color_ids array + catalog_id', () => {
  const startIdx = clip.indexOf('function _buildDraftBody');
  const endIdx = clip.indexOf('// Publie une annonce via le pattern Vinted', startIdx);
  const body = clip.slice(startIdx, endIdx);
  // Vinted attend color_ids (array, max 2) dans le draft body — pas color1/color2
  assert.match(body, /color_ids/);
  // Utilise catalog_id (pas category_id) cote Vinted
  assert.match(body, /catalog_id/);
  // Les champs critiques du draft body
  assert.match(body, /title:/);
  assert.match(body, /description:/);
  assert.match(body, /brand_id:/);
  assert.match(body, /size_id:/);
  assert.match(body, /status_id:/);
  assert.match(body, /package_size_id:/);
  assert.match(body, /assigned_photos:/);
  assert.match(body, /temp_uuid:/);
  assert.match(body, /upload_session_id:/);
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

test('_publishOneAnnonce double-pass upload + POST drafts + POST completion (pattern Bleam)', () => {
  const startIdx = clip.indexOf('async function _publishOneAnnonce');
  const endIdx = clip.indexOf('async function _runColerOp', startIdx);
  const body = clip.slice(startIdx, endIdx);
  // Use 2 UUIDs distincts pour les 2 passes d'upload
  assert.match(body, /tempUUID_A/);
  assert.match(body, /tempUUID_B/);
  assert.match(body, /_genUUIDv4/);
  // Use _buildDraftBody helper
  assert.match(body, /_buildDraftBody/);
  // POST /drafts (creation + completion via meme endpoint mais en 2 etapes)
  assert.match(body, /\/api\/v2\/item_upload\/drafts/);
  assert.match(body, /\/completion/);
  // Pause humaine entre photos (0.8-2s)
  assert.match(body, /sleep\(800/);
  // Pattern push_up false sur completion
  assert.match(body, /push_up\s*=\s*false/);
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

test('T3f : cleanup auto du lot apres coller reussi', () => {
  // _runColerOp doit appeler deleteLot si errorCount === 0
  assert.match(clip, /errorCount === 0 && publishedCount > 0/);
  assert.match(clip, /deleteLot\(op\.lotId\)/);
});

test('T3f : helpers fonds custom exposes (getCustomBgs, addCustomBg, deleteCustomBg, newBgId)', () => {
  assert.match(clip, /getCustomBgs:\s*getCustomBgs/);
  assert.match(clip, /addCustomBg:\s*addCustomBg/);
  assert.match(clip, /deleteCustomBg:\s*deleteCustomBg/);
  assert.match(clip, /newBgId:\s*newBgId/);
  assert.match(clip, /BGS_KEY\s*=\s*'astro_clipboard_bgs'/);
});

test('T3f : modal Coller integre upload + grid custom', () => {
  assert.match(ui, /coler-bg-upload/);
  assert.match(ui, /coler-bg-file/);
  assert.match(ui, /coler-bg-custom-grid/);
  assert.match(ui, /_onCustomBgFileSelected/);
  assert.match(ui, /_renderCustomBgs/);
  assert.match(ui, /_selectCustomBg/);
  // bgConfig type 'image' utilise quand fond custom selectionne
  assert.match(ui, /type:\s*'image'/);
});
