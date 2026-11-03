const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const zlib = require('node:zlib');
function makeBlankPng(width, height) {
  const crc32 = data => { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k=0;k<8;k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type=Buffer.from(name), len=Buffer.alloc(4), crc=Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type,data]))); return Buffer.concat([len,type,data,crc]); };
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=6;
  const raw=Buffer.alloc(height*(1+width*4)); for(let y=0;y<height;y++) { const row=y*(1+width*4); raw[row]=0; for(let x=0;x<width;x++) raw.fill(255,row+1+x*4,row+1+x*4+4); }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [], browserLogs = [];
  page.on('console', msg => { if (msg.type() === 'error') browserLogs.push(msg.text()); });
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
    const png = makeBlankPng(32, 32);
    await page.locator('#impFiles').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => {
      const t = document.querySelector('#impStatus')?.textContent || '';
      return t.includes('Nothing recognisable') || t.includes("Couldn't read the screenshot");
    }, { timeout: 90000 });
    const ocrStatus = await page.locator('#impStatus').innerText();
    assert.match(ocrStatus, /Nothing recognisable/, 'Tesseract must load and recognize a valid blank PNG; status=' + ocrStatus + '; console=' + browserLogs.join(' | '));
    assert.deepEqual(pageErrors, [], 'app must not throw uncaught browser errors');
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const mobileErrors = [];
    mobile.on('pageerror', error => mobileErrors.push(error.message));
    await mobile.goto('http://127.0.0.1:4173/?demo', { waitUntil: 'domcontentloaded' });
    await mobile.locator('[data-tab="paper"]').click();
    await mobile.locator('[data-pda-mode="personal_capital"]').click();
    assert.match(await mobile.locator('#paperBox').innerText(), /Separate personal-capital paper ledger/);
    await mobile.locator('[data-pda-mode="prop_evaluation"]').click();
    assert.match(await mobile.locator('#paperBox').innerText(), /Prop Evaluation mode/);
    assert.deepEqual(mobileErrors, [], 'mobile layout must not throw uncaught browser errors');
    await mobile.close();
    console.log('PDA browser smoke: desktop + mobile account modes, paper-only toggle, and OCR runtime passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
