const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { chromium } = require('playwright');

//
// Configuration via env
//
const NAME_PREFIX = process.env.NAME_PREFIX || 'User';
const TARGET_URL = process.env.TARGET_URL || 'https://www.antrisimatupang.com';
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const ITERATIONS = process.env.ITERATIONS ? Number(process.env.ITERATIONS) : null;
const HEADLESS = (process.env.HEADLESS ?? 'true') === 'true';
const MODE = (process.env.MODE || 'sequential').toLowerCase();
const WAIT_AFTER_SUBMIT = Number(process.env.WAIT_AFTER_SUBMIT || 1500);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 10); // max retries per row
const ATTEMPT_TIMEOUT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS || 60_000); // per-attempt timeout
const PROXY = process.env.PROXY || null; // optional proxy server (socks5://...)
const BROWSER_ARGS = process.env.BROWSER_ARGS ? process.env.BROWSER_ARGS.split(' ') : [];

// Dirs
const INPUT_DIR = path.join(process.cwd(), 'input');
const OUTPUT_DIR = path.join(process.cwd(), 'output');
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Default selectors mapping (try multiple fallbacks)
const SELECTOR_MAP = {
  name: ['#name', 'input[name="name"]', 'input[name*="name" i]'],
  ktp: ['#ktp', 'input[name="ktp"]', 'input[name*="ktp" i]'],
  phone: ['#phone_number', 'input[name*="phone" i]', 'input[name*="hp" i]'],
  check1: ['#check', 'input[name*="check" i]'],
  check2: ['#check_2', 'input[name*="check_2" i]', 'input[name*="check2" i]'],
  captchaBox: ['#captcha-box', '.captcha-box', '[data-captcha]', '[id*="captcha" i]'],
  captchaInput: ['#captcha_input', 'input[name*="captcha" i]'],
  submitBtn: ['button[type="submit"]', 'input[type="submit"]', 'button#submit'],
  form: ['form']
};

function nowTs() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeStr(s) { try { return (s ?? '').toString(); } catch (e) { return ''; } }

// CSV / JSON loaders
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
    { id: 'id', title: 'id' },
    { id: 'sourceRow', title: 'sourceRow' },
    { id: 'status', title: 'status' },
    { id: 'message', title: 'message' },
    { id: 'screenshot', title: 'screenshot' },
    { id: 'timestamp', title: 'timestamp' }
  ]
});

// helper: find first selector that exists from array
async function findSelector(page, selectors) {
  for (const s of selectors) {
    try {
      const el = await page.$(s);
      if (el) return s;
    } catch (e) { /* ignore */ }
  }
  return null;
}

async function attemptRegistration(item, idx, attemptNo) {
  let browser, context, page;
  const result = { id: idx, sourceRow: JSON.stringify(item), status: 'unknown', message: '', screenshot: '', timestamp: nowTs() };

  const browserLaunchOptions = {
    headless: HEADLESS,
    args: BROWSER_ARGS
  };
  if (PROXY) browserLaunchOptions.proxy = { server: PROXY };

  try {
    browser = await chromium.launch(browserLaunchOptions);
    context = await browser.newContext();
    page = await context.newPage();

    // Set a conservative navigation timeout
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(500);

    // Fill simple inputs
    for (const key of ['name', 'ktp', 'phone']) {
      const selectors = SELECTOR_MAP[key];
      if (!selectors) continue;
      const sel = await findSelector(page, selectors);
      if (!sel) continue;
      const val = item[key] ?? item[key?.toLowerCase?.()] ?? item[key?.toUpperCase?.()];
      if (val === undefined || val === null) continue;
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.fill(sel, safeStr(val)).catch(() => {});
        await sleep(150);
      } catch (e) {
        // ignore fill error
      }
    }

    // Checkboxes: attempt to check if wanted (interpret truthy)
    for (const chk of ['check1', 'check2']) {
      const selectors = SELECTOR_MAP[chk];
      if (!selectors) continue;
      const sel = await findSelector(page, selectors);
      if (!sel) continue;
      const wantRaw = item[chk] ?? item[chk + '_'] ?? item.accept ?? item.agree;
      // default to true if undefined, to mimic original behavior which checks them
      const want = wantRaw === undefined ? true : ['true', '1', 'yes', 'y'].includes(String(wantRaw).toLowerCase());
      if (want) {
        try {
          await page.waitForSelector(sel, { timeout: 3000 });
          await page.check(sel).catch(async () => { await page.click(sel).catch(() => {}); });
          await sleep(80);
        } catch (e) {
          // ignore
        }
      }
    }

    // Captcha: read visible captcha box text and set to input if present
    try {
      const captchaBoxSel = await findSelector(page, SELECTOR_MAP.captchaBox);
      const captchaInputSel = await findSelector(page, SELECTOR_MAP.captchaInput);
      if (captchaBoxSel && captchaInputSel) {
        const rawText = (await page.textContent(captchaBoxSel) || '').trim();
        // prefer first non-empty line
        const code = rawText.split('\n').map(s => s.trim()).filter(Boolean)[0] || rawText;
        const cleaned = (code || '').replace(/\s+/g, '');
        if (cleaned) {
          await page.fill(captchaInputSel, cleaned).catch(() => {});
          console.log(`${nowTs()} Row ${idx} attempt ${attemptNo}: captcha set -> "${cleaned}"`);
          await sleep(120);
        }
      }
    } catch (e) {
      console.warn(`${nowTs()} Row ${idx} attempt ${attemptNo} captcha handling warn: ${e.message || e}`);
    }

    // Submit form: try known submit selectors first; otherwise submit form via JS
    const submitSel = await findSelector(page, SELECTOR_MAP.submitBtn);
    if (submitSel) {
      // Click and wait a short while
      await Promise.all([
        page.click(submitSel).catch(() => {}),
        page.waitForTimeout(300)
      ]);
    } else {
      // fallback: submit form element
      const formSel = await findSelector(page, SELECTOR_MAP.form);
      if (formSel) {
        await page.$eval(formSel, f => f.submit()).catch(() => {});
      } else {
        // as last resort execute click on first button[type=submit]
        await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
      }
    }

    // wait for server response / UI change
    await sleep(WAIT_AFTER_SUBMIT);

    // Determine result by searching for common success/error indicators
    const successSel = await page.$('.alert-success, .success-message, .modal-success, .toast-success');
    const errorSel = await page.$('.alert-danger, .error-message, .validation-error, .toast-error');

    if (successSel) {
      result.status = 'success';
      result.message = (await successSel.textContent() || '').trim().slice(0, 1000);
    } else if (errorSel) {
      result.status = 'error';
      result.message = (await errorSel.textContent() || '').trim().slice(0, 1000);
    } else {
      // fallback: inspect body text
      const title = await page.title().catch(() => '');
      const bodyText = (await page.textContent('body').catch(() => '') || '').replace(/\s+/g, ' ').trim();
      result.status = 'unknown';
      result.message = `title:${title} body:${bodyText.slice(0, 800)}`;
    }

    // screenshot
    try {
      const ktpSafe = (item.ktp || 'no_ktp').toString().replace(/\s+/g, '_').slice(0, 50);
      const ss = path.join(OUTPUT_DIR, `screenshot_${ktpSafe}_${NAME_PREFIX}_${Date.now()}.png`);
      await page.screenshot({ path: ss, fullPage: true }).catch(() => {});
      result.screenshot = ss;
    } catch (e) {
      // ignore screenshot errors
    }

    result.timestamp = nowTs();
    return result;
  } finally {
    try { if (page) await page.close().catch(()=>{}); } catch (e) {}
    try { if (context) await context.close().catch(()=>{}); } catch (e) {}
    try { if (browser) await browser.close().catch(()=>{}); } catch (e) {}
  }
}

async function runRegistration(item, idx) {
  const result = { id: idx, sourceRow: JSON.stringify(item), status: 'unknown', message: '', screenshot: '', timestamp: nowTs() };
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    console.log(`${nowTs()} Row ${idx}: starting attempt ${attempt}/${MAX_ATTEMPTS}`);
    try {
      const attemptPromise = attemptRegistration(item, idx, attempt);
      // enforce per-attempt timeout
      const res = await Promise.race([
        attemptPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('attempt timeout')), ATTEMPT_TIMEOUT_MS))
      ]);
      // if reached here, attemptRegistration resolved
      Object.assign(result, res);
      if (result.status === 'success') {
        console.log(`${nowTs()} Row ${idx} succeeded on attempt ${attempt}`);
        break;
      } else {
        console.log(`${nowTs()} Row ${idx} result=${result.status}. message=${(result.message||'').slice(0,200)}`);
      }
    } catch (err) {
      console.warn(`${nowTs()} Row ${idx} attempt ${attempt} error: ${err.message || err}`);
      result.status = 'exception';
      result.message = err.message ? err.message.slice(0, 1000) : String(err);
    }

    // Exponential backoff before retrying
    if (attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(30_000, 500 * Math.pow(2, attempt)); // cap 30s
      console.log(`${nowTs()} Row ${idx} will retry in ${backoff}ms`);
      await sleep(backoff);
    } else {
      console.log(`${nowTs()} Row ${idx} reached max attempts (${MAX_ATTEMPTS})`);
    }
  }

  result.timestamp = nowTs();
  return result;
}

async function runAll() {
  const data = await loadInput();
  const total = data.length;
  console.log(`${nowTs()} Loaded ${total} records.`);
  const toProcess = ITERATIONS ? data.slice(0, ITERATIONS) : data;
  const results = [];

  if (MODE === 'sequential' || CONCURRENCY <= 1) {
    for (let i = 0; i < toProcess.length; i++) {
      console.log(`${nowTs()} Processing ${i + 1}/${toProcess.length}`);
      const res = await runRegistration(toProcess[i], i + 1);
      results.push(res);
      // small pause between rows
      await sleep(300);
    }
  } else {
    // simple concurrency queue
    const queue = toProcess.map((d, i) => ({ d, i }));
    while (queue.length) {
      const batch = queue.splice(0, CONCURRENCY);
      const promises = batch.map(b => runRegistration(b.d, b.i + 1));
      const batchRes = await Promise.all(promises);
      results.push(...batchRes);
      await sleep(300);
    }
  }

  // Write results
  await csvWriter.writeRecords(results.map(r => ({
    id: r.id,
    sourceRow: r.sourceRow,
    status: r.status,
    message: r.message,
    screenshot: r.screenshot,
    timestamp: r.timestamp
  })));
  console.log(`${nowTs()} Done. Results written to:`, path.join(OUTPUT_DIR, 'results.csv'));
}

// run
runAll().catch(async (err) => {
  console.error(`${nowTs()} Fatal error:`, err);
  // attempt to write partial error file
  try {
    const errPath = path.join(OUTPUT_DIR, `fatal_${Date.now()}.log`);
    fs.writeFileSync(errPath, String(err.stack || err));
    console.error('Wrote fatal log to', errPath);
  } catch (e) { /* ignore */ }
  process.exit(1);
});