const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto('http://127.0.0.1:4173/?demo', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tab="paper"]').click();
    await page.locator('[data-pda-mode="prop_evaluation"]').waitFor();
    assert.match(await page.locator('#paperBox').innerText(), /Prop Evaluation mode/);
    await page.locator('[data-pda-mode="personal_capital"]').click();
    assert.match(await page.locator('#paperBox').innerText(), /Separate personal-capital paper ledger/);
    await page.locator('#pdaToggle').click();
    assert.match(await page.locator('#paperBox').innerText(), /Enabled · paper only/);
    await page.locator('[data-pda-mode="prop_evaluation"]').click();
    assert.match(await page.locator('#paperBox').innerText(), /Prop Evaluation mode/);
    await page.locator('[data-pda-mode="personal_capital"]').click();
    assert.match(await page.locator('#paperBox').innerText(), /Paused/);
    await page.locator('[data-tab="pos"]').click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=', 'base64');
    await page.locator('#impFiles').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => {
      const t = document.querySelector('#impStatus')?.textContent || '';
      return t.includes('Nothing recognisable') || t.includes("Couldn't read the screenshot");
    }, { timeout: 90000 });
    const ocrStatus = await page.locator('#impStatus').innerText();
    assert.match(ocrStatus, /Nothing recognisable/, 'Tesseract must load and recognize a blank image without runtime errors');
    assert.deepEqual(pageErrors, [], 'app must not throw uncaught browser errors');
    console.log('PDA browser smoke: account modes, paper-only toggle, and OCR runtime passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
