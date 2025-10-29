/**
 * app.js
 *
 * Batch register using Playwright with unlimited retry until success.
 *
 * Usage:
 *   TARGET_URL="https://www.antrisimatupang.com" CONCURRENCY=3 HEADLESS=true node app.js
 *   TARGET_URL="https://www.antrisimatupang.com" MODE="parallel" CONCURRENCY=5 ITERATIONS=100 node app.js
 *
 * Env variables:
 *   TARGET_URL (default https://www.antrisimatupang.com)
 *   CONCURRENCY (default 1) - how many parallel browser instances per batch
 *   ITERATIONS (optional) - max number of entries to process (default: all)
 *   HEADLESS (true/false default true)
 *   MODE ("sequential" or "parallel", default "sequential")
 *   WAIT_AFTER_SUBMIT (ms default 2500)
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { chromium } = require('playwright');

const TARGET_URL = process.env.TARGET_URL || 'https://www.antrisimatupang.com';
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const ITERATIONS = process.env.ITERATIONS ? Number(process.env.ITERATIONS) : null;
const HEADLESS = (process.env.HEADLESS ?? 'true') === 'true';
const MODE = (process.env.MODE || 'sequential').toLowerCase();
const WAIT_AFTER_SUBMIT = Number(process.env.WAIT_AFTER_SUBMIT || 1500);

const INPUT_DIR = path.join(process.cwd(), 'input');
const OUTPUT_DIR = path.join(process.cwd(), 'output');
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Mapping form fields
const SELECTOR_MAP = {
  name: '#name',
  ktp: '#ktp',
  phone: '#phone_number',
  check1: '#check',
  check2: '#check_2',
  // Captcha selectors (ambil dari captcha box dan set ke captcha input)
  captchaBox: '#captcha-box, .captcha-box, [data-captcha], [id*="captcha" i]',
  captchaInput: '#captcha_input, input[name*="captcha" i]',
  submitBtn: 'button[type="submit"], input[type="submit"], button#submit',
  form: 'form'
};

function nowTs() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeStr(s) { try { return (s||'').toString(); } catch(e) { return ''; } }

function loadCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => rows.push(data))
      .on('end', () => resolve(rows))
      .on('error', (err) => reject(err));
  });
}
function loadJson(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, s) => {
      if (err) return reject(err);
      try {
        const arr = JSON.parse(s);
        if (!Array.isArray(arr)) return reject(new Error('JSON must be an array of objects'));
        resolve(arr);
      } catch (e) { reject(e); }
    });
  });
}
async function loadInput() {
  const csvPath = path.join(INPUT_DIR, 'data.csv');
  const jsonPath = path.join(INPUT_DIR, 'data.json');
  if (fs.existsSync(csvPath)) return await loadCsv(csvPath);
  if (fs.existsSync(jsonPath)) return await loadJson(jsonPath);
  throw new Error('No input file found. Put input/data.csv or input/data.json');
}

const csvWriter = createCsvWriter({
  path: path.join(OUTPUT_DIR, 'results.csv'),
  header: [
    {id: 'id', title: 'id'},
    {id: 'sourceRow', title: 'sourceRow'},
    {id: 'status', title: 'status'},
    {id: 'message', title: 'message'},
    {id: 'screenshot', title: 'screenshot'},
    {id: 'timestamp', title: 'timestamp'}
  ]
});

async function runRegistration(item, idx) {
  let result = { id: idx, sourceRow: JSON.stringify(item), status: 'unknown', message: '', screenshot: '', timestamp: nowTs() };

  while (true) { // unlimited retry loop
    try {
      const browser = await chromium.launch({ headless: HEADLESS });
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(500);

      // fill form (kecualikan captchaBox/captchaInput dari loop umum)
      for (const key of Object.keys(SELECTOR_MAP)) {
        if (['submitBtn','form','check1','check2','captchaBox','captchaInput'].includes(key)) continue;
        const selector = SELECTOR_MAP[key];
        if (!selector) continue;
        const val = item[key] ?? item[key?.toLowerCase?.()] ?? item[key?.toUpperCase?.()];
        if (val !== undefined && val !== null && (await page.$(selector))) {
          await page.fill(selector, safeStr(val)).catch(()=>{});
          await sleep(200);
        }
      }

      // checkboxes
      for (const c of ['check1','check2']) {
        const sel = SELECTOR_MAP[c];
        if(sel && await page.$(sel)){
          const want = item[c] ?? item[c+'_'] ?? item.accept ?? item.agree;
          if(want === undefined || ['true','1','yes'].includes(String(want).toLowerCase())){
            await page.check(sel).catch(async ()=>{ await page.click(sel).catch(()=>{}); });
            await sleep(100);
          }
        }
      }

      // Captcha: ambil teks dari captchaBox dan set di captchaInput
      try {
        const captchaBoxSel = SELECTOR_MAP.captchaBox;
        const captchaInputSel = SELECTOR_MAP.captchaInput;

        const hasBox = captchaBoxSel ? await page.$(captchaBoxSel) : null;
        const hasInput = captchaInputSel ? await page.$(captchaInputSel) : null;

        if (hasBox && hasInput) {
          let rawText = await page.textContent(captchaBoxSel);
          rawText = (rawText || '').trim();

          // Ambil baris pertama yang non-empty, fallback ke pembersihan sederhana
          let code = rawText
            .split('\n')
            .map(t => t.trim())
            .filter(Boolean)[0] || rawText;

          // Jika perlu, bersihkan karakter non-alfanumerik berlebih (opsional)
          // code = code.replace(/[^A-Za-z0-9]+/g, '').slice(0, 16);

          if (code) {
            await page.fill(captchaInputSel, code).catch(()=>{});
            await sleep(150);
            console.log(`Row ${idx}: captcha set from box -> "${code}"`);
          }
        }
      } catch (e) {
        console.warn(`Row ${idx} captcha handling warn:`, e.message || e);
      }

      // submit
      const submitSel = SELECTOR_MAP.submitBtn;
      if(submitSel && await page.$(submitSel)){
        await Promise.all([
          page.click(submitSel).catch(()=>{}),
          page.waitForTimeout(500)
        ]);
      } else {
        await page.evaluate(() => document.querySelector('form')?.submit()).catch(()=>{});
      }

      await sleep(WAIT_AFTER_SUBMIT);

      const successSel = await page.$('.alert-success, .success-message, .modal-success');
      const errorSel = await page.$('.alert-danger, .error-message, .validation-error');

      if(successSel){
        result.status = 'success';
        result.message = (await successSel.textContent()).trim().slice(0,400);
      } else if(errorSel){
        result.status = 'error';
        result.message = (await errorSel.textContent()).trim().slice(0,400);
      } else {
        result.status = 'unknown';
        const title = await page.title();
        const body = (await page.textContent('body') || '').replace(/\s+/g,' ').slice(0,400);
        result.message = `title:${title} body:${body.slice(0,300)}`;
      }

      // screenshot with nik
      // const ss = path.join(OUTPUT_DIR, `screenshot_${idx}_${Date.now()}.png`);
      const ss = path.join(OUTPUT_DIR, `screenshot_${item.ktp}.png`);
      await page.screenshot({ path: ss }).catch(()=>{});
      result.screenshot = ss;
      result.timestamp = nowTs();

      await page.close();
      await context.close();
      await browser.close();

      if(result.status === 'success') break; // exit loop if success
      console.log(`Row ${idx} not successful, retrying in 2s...`);
      await sleep(2000);

    } catch(err) {
      console.warn(`Row ${idx} exception:`, err.message || err);
      result.status = 'exception';
      result.message = err.message || String(err);
      result.timestamp = nowTs();
      console.log(`Retrying row ${idx} in 2s...`);
      await sleep(2000);
    }
  }

  return result;
}

async function runAll() {
  const data = await loadInput();
  const total = data.length;
  console.log(`Loaded ${total} records.`);
  const toProcess = ITERATIONS ? data.slice(0, ITERATIONS) : data;
  const results = [];

  if(MODE === 'sequential' || CONCURRENCY <= 1){
    for(let i=0;i<toProcess.length;i++){
      console.log(`Processing ${i+1}/${toProcess.length}`);
      const res = await runRegistration(toProcess[i], i+1);
      results.push(res);
      await sleep(300);
    }
  } else {
    const queue = toProcess.map((d,i)=>({d,i}));
    while(queue.length){
      const batch = queue.splice(0, CONCURRENCY);
      const promises = batch.map(b => runRegistration(b.d, b.i+1));
      const batchRes = await Promise.all(promises);
      results.push(...batchRes);
      await sleep(300);
    }
  }

  await csvWriter.writeRecords(results.map(r => ({
    id: r.id,
    sourceRow: r.sourceRow,
    status: r.status,
    message: r.message,
    screenshot: r.screenshot,
    timestamp: r.timestamp
  })));
  console.log('Done. Results written to:', path.join(OUTPUT_DIR, 'results.csv'));
}

runAll().catch(err=>{
  console.error('Fatal error:', err);
  process.exit(1);
});