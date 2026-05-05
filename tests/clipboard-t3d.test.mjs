// Tests T3d : modal Coller avec preview live + edition + exclusion
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = pathResolve(__dirname, '../../astro-fix/modules/clipboard-ui.js');
const ui = readFileSync(UI, 'utf8');

test('clipboard-ui.js definit les fonctions du modal Coller', () => {
  assert.match(ui, /function _injectColerStyles\(/);
  assert.match(ui, /function _buildColerModal\(/);
  assert.match(ui, /async function openColerModal\(/);
  assert.match(ui, /function _renderColerTarget\(/);
  assert.match(ui, /function _renderColerList\(/);
  assert.match(ui, /function _renderAnnonceRow\(/);
  assert.match(ui, /async function _composeOneThumb\(/);
  assert.match(ui, /async function _recomposeColerThumbs\(/);
  assert.match(ui, /function _onColerBgClick\(/);
  assert.match(ui, /function _onAnnonceTitleChange\(/);
  assert.match(ui, /function _onAnnoncePriceChange\(/);
  assert.match(ui, /function _onAnnonceToggleExclude\(/);
  assert.match(ui, /function _refreshColerRecap\(/);
  assert.match(ui, /async function _onColerPublish\(/);
});

test('Modal Coller a un id + sections (target/bg/list/recap/publish)', () => {
  assert.match(ui, /id\s*=\s*'astro-coler-modal'/);
  assert.match(ui, /id="coler-sub"/);
  assert.match(ui, /id="coler-target-box"/);
  assert.match(ui, /id="coler-bg-grid"/);
  assert.match(ui, /id="coler-list"/);
  assert.match(ui, /id="coler-recap"/);
  assert.match(ui, /id="coler-publish"/);
});

test('Modal Coller a 4 fonds preset', () => {
  // Cherche les 4 boutons dans le bloc T3d (apres Modal Coller)
  const startIdx = ui.indexOf('T3d : Modal Coller');
  assert.ok(startIdx >= 0, 'section T3d non trouvee');
  const t3d = ui.slice(startIdx);
  assert.match(t3d, /coler-bg-opt[^>]+data-bg-name="Blanc"/);
  assert.match(t3d, /coler-bg-opt[^>]+data-bg-name="Gris clair"/);
  assert.match(t3d, /coler-bg-opt[^>]+data-bg-name="Beige"/);
  assert.match(t3d, /coler-bg-opt[^>]+data-bg-name="Noir"/);
});

test('renderColerTarget warn si compte source == compte courant', () => {
  const startIdx = ui.indexOf('function _renderColerTarget');
  const endIdx = ui.indexOf('function _renderColerList', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /currentLogin === sourceLogin/);
  assert.match(body, /coler-warn/);
  assert.match(body, /coler-target-ok/);
});

test('_renderAnnonceRow inclut titre input + prix input + toggle exclude', () => {
  const startIdx = ui.indexOf('function _renderAnnonceRow');
  const endIdx = ui.indexOf('async function _composeOneThumb', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /ann-title-input/);
  assert.match(body, /ann-price-input/);
  assert.match(body, /ann-toggle/);
  assert.match(body, /excluded/);
  assert.match(body, /ann-thumb/);
});

test('_composeOneThumb utilise compositeWithBackground + URL.createObjectURL', () => {
  const startIdx = ui.indexOf('async function _composeOneThumb');
  const endIdx = ui.indexOf('async function _recomposeColerThumbs', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /compositeWithBackground/);
  assert.match(body, /URL\.createObjectURL/);
  assert.match(body, /detoured_b64/);
  assert.match(body, /originalUrl/);
});

test('_recomposeColerThumbs itere sur toutes les annonces', () => {
  const startIdx = ui.indexOf('async function _recomposeColerThumbs');
  const endIdx = ui.indexOf('function _onColerBgClick', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /for\s*\(/);
  assert.match(body, /ann-thumb-/);
});

test('_onColerBgClick met a jour bgConfig + recompose les thumbs', () => {
  const startIdx = ui.indexOf('function _onColerBgClick');
  const endIdx = ui.indexOf('function _onAnnonceTitleChange', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /_colerCtx\.bgConfig/);
  assert.match(body, /_recomposeColerThumbs/);
});

test('_onAnnonceTitleChange/PriceChange persistent dans perAnnonce', () => {
  assert.match(ui, /_colerCtx\.perAnnonce\[idx\]\.title\s*=/);
  assert.match(ui, /_colerCtx\.perAnnonce\[idx\]\.price\s*=/);
});

test('_onAnnonceToggleExclude flip excluded + re-render', () => {
  const startIdx = ui.indexOf('function _onAnnonceToggleExclude');
  const endIdx = ui.indexOf('function _refreshColerRecap', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /_colerCtx\.perAnnonce\[idx\]\.excluded\s*=\s*!/);
  assert.match(body, /_renderColerList/);
});

test('_refreshColerRecap update le CTA avec le compte kept', () => {
  const startIdx = ui.indexOf('function _refreshColerRecap');
  const endIdx = ui.indexOf('async function _onColerPublish', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /\.filter\(/);
  assert.match(body, /excluded/);
  assert.match(body, /coler-publish/);
  assert.match(body, /Aucune annonce/);
});

test('_onColerPublish bloque si meme compte que source', () => {
  const startIdx = ui.indexOf('async function _onColerPublish');
  const endIdx = ui.indexOf('function _autoInstall', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /sourceCompteLogin\s*===\s*targetLogin/);
  assert.match(body, /switch d/);
});

test('_onColerPublish pose astro_clipboard_paste_op pour T3e', () => {
  const startIdx = ui.indexOf('async function _onColerPublish');
  const endIdx = ui.indexOf('function _autoInstall', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /type:\s*'coller'/);
  assert.match(body, /stage:\s*'queued'/);
  assert.match(body, /astro_clipboard_paste_op/);
  assert.match(body, /annoncesOverride/);
  assert.match(body, /bgConfig/);
  assert.match(body, /targetCompteLogin/);
  assert.match(body, /lotIdx/);
});

test('_onColerPublish navigate worker tab pour declencher T3e (apres T3e implemente)', () => {
  const startIdx = ui.indexOf('async function _onColerPublish');
  const endIdx = ui.indexOf('function _autoInstall', startIdx);
  const body = ui.slice(startIdx, endIdx);
  // T3e : navigation worker tab pour que clipboard.js orchestrator pickup
  assert.match(body, /MODIF_NAVIGATE_WORKER/);
  assert.match(body, /astro_worker=1/);
});

test('AstroClipboardUI public expose openColerModal', () => {
  assert.match(ui, /openColerModal:\s*openColerModal/);
});

test('_onPasteLot (T3c) appelle openColerModal si dispo', () => {
  const startIdx = ui.indexOf('function _onPasteLot');
  const endIdx = ui.indexOf('async function _onDeleteLot', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /window\.AstroClipboardUI\?\.openColerModal/);
});
