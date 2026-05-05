// Tests T3c : pill flottante + modal liste des lots.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = pathResolve(__dirname, '../../astro-fix/modules/clipboard-ui.js');
const ui = readFileSync(UI, 'utf8');

test('clipboard-ui.js definit les fonctions de pill + modal liste', () => {
  assert.match(ui, /function _injectPillStyles\(/);
  assert.match(ui, /function _buildPill\(/);
  assert.match(ui, /async function _refreshPill\(/);
  assert.match(ui, /function _buildLotsModal\(/);
  assert.match(ui, /function _renderLotCard\(/);
  assert.match(ui, /async function _openLotsList\(/);
  assert.match(ui, /function _onPasteLot\(/);
  assert.match(ui, /async function _onDeleteLot\(/);
  assert.match(ui, /function _installLotsListener\(/);
});

test('Pill a un id unique + classe + bouton click', () => {
  assert.match(ui, /id\s*=\s*'astro-clipboard-pill'/);
  assert.match(ui, /\.astro-clip-pill/);
  assert.match(ui, /pill\.addEventListener\('click', _openLotsList\)/);
});

test('refreshPill cache la pill si 0 lot', () => {
  // On lit AstroClipboard.getLots et on cache si lots.length === 0
  assert.match(ui, /window\.AstroClipboard\?\.getLots\?\.\(\)/);
  assert.match(ui, /lots\.length === 0/);
  assert.match(ui, /_pillEl\.style\.display = 'none'/);
});

test('Modal liste a un id + close button + body', () => {
  assert.match(ui, /id\s*=\s*'astro-lots-modal'/);
  assert.match(ui, /id="lots-close"/);
  assert.match(ui, /id="lots-list"/);
  assert.match(ui, /id="lots-sub"/);
});

test('renderLotCard inclut nom + count + actions Coller/Supprimer', () => {
  const startIdx = ui.indexOf('function _renderLotCard');
  const endIdx = ui.indexOf('async function _openLotsList', startIdx);
  assert.ok(startIdx >= 0 && endIdx > startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /lot-name/);
  assert.match(body, /lot-meta/);
  assert.match(body, /lot-paste/);
  assert.match(body, /lot-del/);
  assert.match(body, /annonces\.length/);
  assert.match(body, /sourceCompteLogin/);
});

test('renderLotCard utilise la 1ere photo detouree comme thumb (fallback originalUrl)', () => {
  const startIdx = ui.indexOf('function _renderLotCard');
  const endIdx = ui.indexOf('async function _openLotsList', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /detoured_b64/);
  assert.match(body, /originalUrl/);
});

test('_onPasteLot : placeholder T3d ou call openColerModal si dispo', () => {
  const startIdx = ui.indexOf('function _onPasteLot');
  const endIdx = ui.indexOf('async function _onDeleteLot', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /window\.AstroClipboardUI\?\.openColerModal/);
  assert.match(body, /T3d/);
});

test('_onDeleteLot demande confirmation + appelle deleteLot + refresh', () => {
  const startIdx = ui.indexOf('async function _onDeleteLot');
  const endIdx = ui.indexOf('function _installLotsListener', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /window\.confirm/);
  assert.match(body, /window\.AstroClipboard\?\.deleteLot/);
  assert.match(body, /_openLotsList\(\)/);
  assert.match(body, /_refreshPill\(\)/);
});

test('Listener storage installe pour astro_clipboard_lots', () => {
  const startIdx = ui.indexOf('function _installLotsListener');
  const endIdx = ui.indexOf('function _autoInstall', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /chrome\.storage\.onChanged\.addListener/);
  assert.match(body, /changes\.astro_clipboard_lots/);
  assert.match(body, /_refreshPill/);
});

test('_autoInstall declenche pill + lots listener (apres skip si worker tab)', () => {
  const startIdx = ui.indexOf('function _autoInstall');
  const endIdx = ui.indexOf('_whenReady', startIdx);
  const body = ui.slice(startIdx, endIdx);
  assert.match(body, /_buildPill/);
  assert.match(body, /_refreshPill/);
  assert.match(body, /_installLotsListener/);
  assert.match(body, /isWorkerTab/);
});

test('AstroClipboardUI public expose openLotsList + refreshPill', () => {
  assert.match(ui, /openLotsList:\s*_openLotsList/);
  assert.match(ui, /refreshPill:\s*_refreshPill/);
});

test('Aucun reference a content.js (dependance uniquement via __astroBus)', () => {
  // Le module ne doit pas avoir de import statique
  assert.doesNotMatch(ui, /^import\s/m);
  // Mais utilise __astroBus
  assert.match(ui, /window\.__astroBus/);
});
