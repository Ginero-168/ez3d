import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { chromium } from 'playwright';

const PORT = 5173;
const URL = `http://127.0.0.1:${PORT}/`;
const EPSILON = 0.01;

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
    await page.evaluate(() => window.applyLayoutTemplate('booth3x3', true));
    await page.locator('#tab-btn-layers').click();
    const templateLayerText = await page.locator('#layer-list').innerText();
    if (!templateLayerText.includes('โรลอัป')) throw new Error('Template did not add rollup assets.');

    await page.locator('#tab-btn-objects').click();
    await page.locator("button[onclick=\"spawnItem('table')\"]").click();
    await page.locator('#tab-btn-layers').click();
    const layerText = await page.locator('#layer-list').innerText();
    if (!layerText.includes('โต๊ะ #1')) throw new Error('Table was not added to layer list.');

    await page.keyboard.press('Escape');
    await page.mouse.click(720, 450);
    await page.waitForTimeout(100);
    const selectedTitle = await page.locator('#selected-title').innerText();
    if (!selectedTitle.includes('โต๊ะ')) throw new Error(`Canvas click did not select table; selected ${selectedTitle}.`);

    const singleTransformState = await page.evaluate(() => {
      window.applyRotation(35);
      const state = window.__ez3dDebug.getState();
      const selected = state.objects.find(obj => obj.name === state.selectedNames[0]);
      return { state, selected };
    });
    if (!singleTransformState.state.anchor) throw new Error('Selection anchor was not created for selected table.');
    assertNearVector(
      singleTransformState.state.anchor.position,
      singleTransformState.selected.center,
      'Single selection anchor'
    );

    await page.keyboard.press(platform() === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await page.waitForTimeout(100);
    const singleUndoState = await page.evaluate(() => {
      const state = window.__ez3dDebug.getState();
      const selected = state.objects.find(obj => obj.name === state.selectedNames[0]);
      return { state, selected };
    });
    assertNearVector(singleUndoState.state.anchor.position, singleUndoState.selected.center, 'Single undo anchor');

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
    assertNearVector(groupState.after.anchor.position, grouped.center, 'Grouped selection anchor');

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
    }, null, { timeout: 5000 });

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

    const restoredLayerText = await page.evaluate(async () => {
      const snapshot = window.createProjectSnapshot();
      window.clearAllWorkspace();
      await window.loadProjectSnapshot(snapshot);
      return document.getElementById('layer-list').innerText;
    });
    if (!restoredLayerText.includes('โต๊ะ #1')) throw new Error('Project load did not restore table.');
    if (!restoredLayerText.includes('Point Light')) throw new Error('Project load did not restore point light.');

    await page.evaluate(() => window.toggleProposalMode());
    await page.waitForTimeout(100);
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => window.downloadProposalSummary());
    const download = await downloadPromise;
    if (!download.suggestedFilename().endsWith('.html')) {
      throw new Error(`Proposal export filename was not HTML: ${download.suggestedFilename()}`);
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
