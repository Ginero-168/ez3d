import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { chromium } from 'playwright';
import { SUPPORTED_MODEL_EXTENSIONS } from '../src/modelLoaders.js';

const PORT = 5173;
const URL = `http://127.0.0.1:${PORT}/`;
const EPSILON = 0.01;
const REQUIRED_MODEL_FORMATS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae'];

function assertNearVector(actual, expected, label) {
  for (const axis of ['x', 'y', 'z']) {
    const delta = Math.abs(actual[axis] - expected[axis]);
    if (delta > EPSILON) {
      throw new Error(`${label}.${axis} expected ${expected[axis].toFixed(3)}, got ${actual[axis].toFixed(3)}.`);
    }
  }
}

function startServer() {
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Vite did not start in time.\n${output}`)), 20000);
    const onData = data => {
      output += data.toString();
      if (output.includes(URL)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Vite exited with code ${code}.\n${output}`));
      }
    });
  });

  return { child, ready };
}

async function run() {
  for (const format of REQUIRED_MODEL_FORMATS) {
    if (!SUPPORTED_MODEL_EXTENSIONS.includes(format)) {
      throw new Error(`Supported model formats missing .${format}.`);
    }
  }

  const server = startServer();
  await server.ready;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', err => errors.push(String(err.stack || err.message || err)));
    page.on('dialog', async dialog => {
      if (dialog.message().includes('พบงานร่าง Ez3d')) {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });

    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.locator('button', { hasText: 'สร้างพื้นที่ 3D' }).click();
    await page.waitForTimeout(1500);

    await page.locator('#tab-btn-objects').click();
    if (!(await page.locator('#left-floating-panel').isVisible())) {
      throw new Error('Objects panel did not open.');
    }
    await page.locator('#left-panel-close-btn').click();
    if (await page.locator('#left-floating-panel').isVisible()) {
      throw new Error('Left panel close button did not hide the panel.');
    }
    await page.locator('#tab-btn-objects').click();
    await page.evaluate(() => window.applyLayoutTemplate('booth3x3', true));
    await page.locator('#tab-btn-layers').click();
    const templateLayerText = await page.locator('#layer-list').innerText();
    if (!templateLayerText.includes('โรลอัป')) throw new Error('Template did not add rollup assets.');

    await page.locator('#tab-btn-objects').click();
    await page.locator("button[onclick=\"spawnItem('table')\"]").click();
    await page.locator('#tab-btn-layers').click();
    const layerText = await page.locator('#layer-list').innerText();
    if (!layerText.includes('โต๊ะ #1')) throw new Error('Table was not added to layer list.');

    const backdropName = await page.evaluate(() => {
      const state = window.__ez3dDebug.getState();
      return state.objects.find(obj => obj.type === 'backdrop')?.name || null;
    });
    if (!backdropName) throw new Error('Default backdrop was missing for texture upload test.');
    await page.evaluate(name => {
      if (!window.__ez3dDebug.selectByName(name)) throw new Error(`Could not select backdrop ${name}.`);
    }, backdropName);
    await page.locator('#image-file-input').setInputFiles({
      name: 'texture.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'),
    });
    await page.waitForFunction(() => window.__ez3dDebug.selectedHasTexture(), null, { timeout: 5000 });

    await page.keyboard.press('Escape');
    await page.mouse.click(720, 450);
    await page.waitForTimeout(100);
    const selectedTitle = await page.locator('#selected-title').innerText();
    if (!selectedTitle.includes('โต๊ะ')) throw new Error(`Canvas click did not select table; selected ${selectedTitle}.`);

    const singleTransformState = await page.evaluate(() => {
      window.applyRotation(35);
      window.setScaleX(1.15);
      const state = window.__ez3dDebug.getState();
      const selected = state.objects.find(obj => obj.name === state.selectedNames[0]);
      return { state, selected };
    });
    if (Math.abs(singleTransformState.selected.rotation.y - (35 * Math.PI / 180)) > 0.01) {
      throw new Error(`Single rotation bounced back; got ${singleTransformState.selected.rotation.y}.`);
    }
    if (Math.abs(singleTransformState.selected.scale.x - 1.15) > 0.01) {
      throw new Error(`Single scale bounced back; got ${singleTransformState.selected.scale.x}.`);
    }

    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForTimeout(100);
    const singleUndoState = await page.evaluate(() => {
      const state = window.__ez3dDebug.getState();
      const selected = state.objects.find(obj => obj.name === state.selectedNames[0]);
      return { state, selected };
    });
    if (Math.abs(singleUndoState.selected.rotation.y) > 0.01 || Math.abs(singleUndoState.selected.scale.x - 1) > 0.01) {
      throw new Error('Single undo did not restore rotation/scale after direct object transform.');
    }

    await page.locator('#tab-btn-objects').click();
    await page.locator("button[onclick=\"spawnItem('cashier')\"]").click();
    const multiTransformState = await page.evaluate(() => {
      const stateBefore = window.__ez3dDebug.getState();
      const table = stateBefore.objects.find(obj => obj.type === 'table');
      const cashier = stateBefore.objects.find(obj => obj.type === 'cashier');
      if (!table || !cashier) throw new Error('Missing table or cashier for multi-select transform test.');
      if (!window.__ez3dDebug.selectByName([table.name, cashier.name])) throw new Error('Debug multi-select failed.');
      window.setRotationY(30);
      const state = window.__ez3dDebug.getState();
      return {
        state,
        selected: state.selectedNames.map(name => state.objects.find(obj => obj.name === name)),
      };
    });
    if (multiTransformState.state.selectedCount !== 2) {
      throw new Error(`Expected 2 selected objects after multi-select; got ${multiTransformState.state.selectedCount}.`);
    }
    if (!multiTransformState.state.anchor) throw new Error('Selection anchor was not created for multi-select.');
    assertNearVector(
      multiTransformState.state.anchor.position,
      multiTransformState.state.selectionCenter,
      'Multi selection anchor'
    );

    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForTimeout(100);
    const multiUndoState = await page.evaluate(() => window.__ez3dDebug.getState());
    assertNearVector(multiUndoState.anchor.position, multiUndoState.selectionCenter, 'Multi undo anchor');

    const multiMoveScaleState = await page.evaluate(() => {
      window.setPositionX(1.25);
      window.setScaleX(1.2);
      return window.__ez3dDebug.getState();
    });
    assertNearVector(
      multiMoveScaleState.anchor.position,
      multiMoveScaleState.selectionCenter,
      'Multi move/scale anchor'
    );

    const groupState = await page.evaluate(() => {
      const before = window.__ez3dDebug.getState();
      window.groupSelected();
      const after = window.__ez3dDebug.getState();
      return { before, after };
    });
    if (groupState.after.selectedCount !== 1) {
      throw new Error(`Expected grouped selection count 1; got ${groupState.after.selectedCount}.`);
    }
    const grouped = groupState.after.objects.find(obj => obj.name === groupState.after.selectedNames[0]);
    if (!grouped || grouped.type !== 'group') throw new Error('Grouping did not select a group object.');
    if (groupState.after.objects.length !== groupState.before.objects.length - 1) {
      throw new Error(`Grouping did not reduce top-level object count by 1; before ${groupState.before.objects.length}, after ${groupState.after.objects.length}.`);
    }
    if (groupState.after.anchor) {
      throw new Error('Grouped single selection should not use a transient selection anchor.');
    }

    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForTimeout(100);
    const ungroupedState = await page.evaluate(() => window.__ez3dDebug.getState());
    if (ungroupedState.selectedCount !== 2) {
      throw new Error(`Undo group should restore two selected objects; got ${ungroupedState.selectedCount}.`);
    }
    assertNearVector(ungroupedState.anchor.position, ungroupedState.selectionCenter, 'Undo group anchor');

    const draft = await page.evaluate(() => {
      const snapshot = window.__ez3dDebug.flushAutosave();
      return snapshot;
    });
    if (!draft || draft.objects.length < 2) throw new Error('Autosave draft did not capture edited objects.');
    if (draft.metadata?.objectCount !== draft.objects.length) {
      throw new Error(`Autosave metadata object count mismatch: ${draft.metadata?.objectCount} vs ${draft.objects.length}.`);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('button', { hasText: 'สร้างพื้นที่ 3D' }).click();
    await page.waitForTimeout(500);
    const restoredDraftState = await page.evaluate(() => window.__ez3dDebug.getState());
    if (restoredDraftState.objects.length < 2) {
      throw new Error(`Autosave restore did not recover objects; got ${restoredDraftState.objects.length}.`);
    }

    const clearedDraft = await page.evaluate(async snapshot => {
      window.clearAllWorkspace();
      const cleared = window.__ez3dDebug.readAutosave();
      await window.loadProjectSnapshot(snapshot);
      return cleared;
    }, draft);
    if (clearedDraft) throw new Error('Workspace clear did not remove autosave draft.');

    await page.locator('#model-file-input').setInputFiles({
      name: 'smoke.obj',
      mimeType: 'text/plain',
      buffer: Buffer.from([
        'o SmokeTriangle',
        'v 0 0 0',
        'v 1 0 0',
        'v 0 1 0',
        'f 1 2 3',
      ].join('\n')),
    });
    await page.waitForFunction(() => {
      const state = window.__ez3dDebug.getState();
      return state.objects.some(obj => obj.name === 'smoke' && obj.type === 'custom' && obj.format === 'obj');
    }, null, { timeout: 15000 });

    const customRestoreState = await page.evaluate(async () => {
      const snapshot = window.createProjectSnapshot();
      window.clearAllWorkspace();
      await window.loadProjectSnapshot(snapshot);
      return window.__ez3dDebug.getState();
    });
    const restoredCustom = customRestoreState.objects.find(obj => obj.name === 'smoke');
    if (!restoredCustom || restoredCustom.type !== 'custom' || restoredCustom.format !== 'obj' || !restoredCustom.modelAssetId) {
      throw new Error('Custom OBJ model did not restore from project snapshot.');
    }

    const modelAccept = await page.locator('#model-file-input').getAttribute('accept');
    for (const format of REQUIRED_MODEL_FORMATS) {
      if (!modelAccept.includes(`.${format}`)) {
        throw new Error(`Model file input does not accept .${format}: ${modelAccept}`);
      }
    }

    await page.locator('#model-file-input').setInputFiles({
      name: 'smoke_stl.stl',
      mimeType: 'model/stl',
      buffer: Buffer.from([
        'solid smoke_stl',
        'facet normal 0 0 1',
        'outer loop',
        'vertex 0 0 0',
        'vertex 1 0 0',
        'vertex 0 1 0',
        'endloop',
        'endfacet',
        'endsolid smoke_stl',
      ].join('\n')),
    });
    await page.waitForFunction(() => {
      const state = window.__ez3dDebug.getState();
      return state.objects.some(obj => obj.name === 'smoke_stl' && obj.type === 'custom' && obj.format === 'stl');
    }, null, { timeout: 15000 });

    await page.locator('#model-file-input').setInputFiles({
      name: 'smoke_ply.ply',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([
        'ply',
        'format ascii 1.0',
        'element vertex 3',
        'property float x',
        'property float y',
        'property float z',
        'element face 1',
        'property list uchar int vertex_indices',
        'end_header',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '3 0 1 2',
      ].join('\n')),
    });
    await page.waitForFunction(() => {
      const state = window.__ez3dDebug.getState();
      return state.objects.some(obj => obj.name === 'smoke_ply' && obj.type === 'custom' && obj.format === 'ply');
    }, null, { timeout: 15000 });

    await page.locator('#model-file-input').setInputFiles([
      {
        name: 'multi.obj',
        mimeType: 'text/plain',
        buffer: Buffer.from([
          'mtllib multi.mtl',
          'o MultiMaterialTriangle',
          'v 0 0 0',
          'v 1 0 0',
          'v 0 1 0',
          'usemtl RedMat',
          'f 1 2 3',
        ].join('\n')),
      },
      {
        name: 'multi.mtl',
        mimeType: 'text/plain',
        buffer: Buffer.from([
          'newmtl RedMat',
          'Kd 1.0 0.0 0.0',
        ].join('\n')),
      },
    ]);
    await page.waitForFunction(() => {
      const state = window.__ez3dDebug.getState();
      return state.objects.some(obj => obj.name === 'multi' && obj.type === 'custom' && obj.format === 'obj');
    }, null, { timeout: 15000 });

    const bundleDownloadPromise = page.waitForEvent('download');
    await page.evaluate(() => window.downloadProjectBundle());
    const bundleDownload = await bundleDownloadPromise;
    if (!bundleDownload.suggestedFilename().endsWith('.ez3d.zip')) {
      throw new Error(`Project bundle filename was not .ez3d.zip: ${bundleDownload.suggestedFilename()}`);
    }
    const bundlePath = await bundleDownload.path();
    const bundleBuffer = await readFile(bundlePath);
    await page.evaluate(async () => {
      window.clearAllWorkspace();
      await window.__ez3dDebug.clearModelAssets();
    });
    await page.locator('#project-file-input').setInputFiles({
      name: 'smoke.ez3d.zip',
      mimeType: 'application/zip',
      buffer: bundleBuffer,
    });
    try {
      await page.waitForFunction(() => {
        const state = window.__ez3dDebug.getState();
        return state.objects.some(obj => obj.name === 'smoke' && obj.type === 'custom' && obj.format === 'obj' && obj.modelAssetId) &&
          state.objects.some(obj => obj.name === 'multi' && obj.type === 'custom' && obj.format === 'obj' && obj.modelAssetId);
      }, null, { timeout: 15000 });
    } catch (err) {
      const state = await page.evaluate(() => window.__ez3dDebug.getState());
      throw new Error(`Project ZIP import did not restore custom model. State: ${JSON.stringify(state.objects)}`);
    }

    await page.locator('#light-mode-btn').click();
    const lightModeColors = await page.evaluate(() => {
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const panelBg = getComputedStyle(document.getElementById('left-floating-panel')).backgroundColor;
      return { bodyBg, panelBg };
    });
    if (lightModeColors.bodyBg !== 'rgb(229, 231, 235)') {
      throw new Error(`Light mode body background should be neutral gray; got ${lightModeColors.bodyBg}.`);
    }
    if (lightModeColors.panelBg.includes('237') || lightModeColors.panelBg.includes('228')) {
      throw new Error(`Light mode panel still appears cream: ${lightModeColors.panelBg}.`);
    }

    await page.locator('#snap-toggle-btn').click();
    const snapText = await page.locator('#snap-toggle-text').innerText();
    if (!snapText.includes('OFF')) throw new Error(`Snap did not toggle off: ${snapText}`);

    await page.locator('#tab-btn-lights').click();
    await page.locator("button[onclick=\"addLight('point')\"]").click();
    if (!(await page.locator('#light-selected-panel').isVisible())) {
      throw new Error('Light property panel did not open after adding point light.');
    }

    await page.locator('#lp-intensity').fill('2.35');
    await page.locator('#lp-intensity').evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForTimeout(100);
    const undoneIntensity = await page.locator('#lp-intensity').inputValue();
    if (undoneIntensity !== '1.00') throw new Error(`Light undo failed; got ${undoneIntensity}.`);

    await page.locator('#lp-name').fill('Smoke Point Key');
    await page.locator('#lp-name').evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForTimeout(100);
    const undoneLightName = await page.locator('#lp-name').inputValue();
    if (!undoneLightName.startsWith('Point Light')) {
      throw new Error(`Light rename undo failed; got ${undoneLightName}.`);
    }

    await page.locator('#lp-color').evaluate(el => {
      el.value = '#ff0000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const redLight = await page.evaluate(() => window.__ez3dDebug.getState().lights.at(-1)?.color);
    if (redLight !== '#ff0000') throw new Error(`Light color did not update before undo: ${redLight}`);
    await page.evaluate(() => window.undo());
    await page.waitForTimeout(100);
    const undoneLightColor = await page.evaluate(() => window.__ez3dDebug.getState().lights.at(-1)?.color);
    if (undoneLightColor === '#ff0000') throw new Error('Light color undo did not restore previous color.');

    const restoredProjectState = await page.evaluate(async () => {
      const snapshot = window.createProjectSnapshot();
      window.clearAllWorkspace();
      await window.loadProjectSnapshot(snapshot);
      return {
        layerText: document.getElementById('layer-list').innerText,
        state: window.__ez3dDebug.getState(),
      };
    });
    if (!restoredProjectState.layerText.includes('โต๊ะ #1')) throw new Error('Project load did not restore table.');
    if (!restoredProjectState.state.lights.some(light => light.type === 'point')) {
      throw new Error('Project load did not restore point light.');
    }

    await page.evaluate(() => window.toggleProposalMode());
    await page.waitForTimeout(100);
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => window.downloadProposalSummary());
    const download = await downloadPromise;
    if (!download.suggestedFilename().endsWith('.html')) {
      throw new Error(`Proposal export filename was not HTML: ${download.suggestedFilename()}`);
    }

    const safeLayerRender = await page.evaluate(async () => {
      await window.loadProjectSnapshot({
        schema: 'ez3d.project',
        version: 1,
        space: { width: 3, length: 3 },
        objects: [{
          type: 'table',
          name: '<img src=x onerror="window.__ez3dXss=1">',
          position: [0, 0, 0],
          rotation: [0, 0, 0, 'XYZ'],
          scale: [1, 1, 1],
          color: '#ffffff',
        }],
        lights: [],
        carpet: [],
        comments: [],
        settings: {},
      });
      const layerList = document.getElementById('layer-list');
      return {
        text: layerList.innerText,
        hasInjectedImage: !!layerList.querySelector('img'),
        xssFlag: window.__ez3dXss === 1,
      };
    });
    if (!safeLayerRender.text.includes('<img src=x') || safeLayerRender.hasInjectedImage || safeLayerRender.xssFlag) {
      throw new Error(`Layer list rendered unsafe HTML: ${JSON.stringify(safeLayerRender)}`);
    }

    if (errors.length) throw new Error(`Page errors:\n${errors.join('\n')}`);
  } finally {
    if (browser) await browser.close();
    server.child.kill();
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
