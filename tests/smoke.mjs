import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { chromium } from 'playwright';

const PORT = 5173;
const URL = `http://127.0.0.1:${PORT}/`;

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

    const restoredLayerText = await page.evaluate(() => {
      const snapshot = window.createProjectSnapshot();
      window.clearAllWorkspace();
      window.loadProjectSnapshot(snapshot);
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
