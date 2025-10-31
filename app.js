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
const WAIT_AFTER_SUBMIT = Number(process.env.WAIT_AFTER_SUBMIT || 2000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 15);
const ATTEMPT_TIMEOUT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS || 90_000);
const PROXY = process.env.PROXY || null;
const BROWSER_ARGS = process.env.BROWSER_ARGS ? process.env.BROWSER_ARGS.split(' ') : [];
const USE_ANTIBOT = (process.env.USE_ANTIBOT ?? 'true') === 'true';
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);
const ENABLE_LOGGING = (process.env.ENABLE_LOGGING ?? 'true') === 'true';

// Dirs
const INPUT_DIR = path.join(process.cwd(), 'input');
const OUTPUT_DIR = path.join(process.cwd(), 'output');
const LOG_DIR = path.join(OUTPUT_DIR, 'logs');
if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Logger utility
const logFile = path.join(LOG_DIR, `run_${Date.now()}.log`);
function logMsg(msg) {
  const ts = nowTs();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (ENABLE_LOGGING) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch (e) {}
  }
}

// Selector mapping
const SELECTOR_MAP = {
  name: [
    '#name',
    'input[name="name"]',
    'input[name*="name" i]',
    'input[placeholder*="nama" i]',
    'input[placeholder*="name" i]'
  ],
  ktp: [
    '#ktp',
    'input[name="ktp"]',
    'input[name*="ktp" i]',
    'input[name*="identitas" i]',
    'input[placeholder*="ktp" i]',
    'input[placeholder*="identitas" i]'
  ],
  phone: [
    '#phone_number',
    'input[name="phone_number"]',
    'input[name*="phone" i]',
    'input[name*="hp" i]',
    'input[name*="nomor" i]',
    'input[placeholder*="hp" i]',
    'input[placeholder*="phone" i]'
  ],
  check1: [
    '#check',
    'input[name*="check" i]:first-of-type',
    'input[type="checkbox"]:first-of-type',
    'input[name*="agree" i]:first-of-type',
    'input[name*="syarat" i]:first-of-type'
  ],
  check2: [
    '#check_2',
    'input[name*="check_2" i]',
    'input[name*="check2" i]',
    'input[type="checkbox"]:nth-of-type(2)',
    'input[name*="agree" i]:nth-of-type(2)'
  ],
  captchaBox: [
    '#captcha-box',
    '.captcha-box',
    '[data-captcha]',
    '[id*="captcha" i]',
    '.alert-info',
    'div[style*="letter-spacing"]',
    'div[style*="font-weight"]'
  ],
  captchaInput: [
    '#captcha_input',
    'input[name="captcha_input"]',
    'input[name*="captcha" i]',
    'input[placeholder*="captcha" i]',
    'input[placeholder*="teks" i]'
  ],
  submitBtn: [
    'button[type="submit"]',
    'input[type="submit"]',
    'button#submit',
    'button:contains("Daftar")',
    'button:contains("Submit")',
    'button[class*="primary"]'
  ],
  form: ['form', '[role="form"]', '[data-form]']
};

function nowTs() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeStr(s) { 
  try { 
    return (s ?? '').toString().trim(); 
  } catch (e) { 
    return ''; 
  } 
}

// CSV loader
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

// JSON loader
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
    { id: 'attempts', title: 'attempts' },
    { id: 'captcha_detected', title: 'captcha_detected' },
    { id: 'timestamp', title: 'timestamp' }
  ]
});

// Find selector
async function findSelector(page, selectors) {
  if (!selectors || !Array.isArray(selectors)) return null;
  for (const s of selectors) {
    try {
      const el = await page.$(s);
      if (el) return s;
    } catch (e) { /* ignore */ }
  }
  return null;
}

// Wait for element visible
async function waitForElementVisible(page, selector, timeout = 3000) {
  try {
    await page.waitForSelector(selector, { timeout });
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0;
      },
      selector,
      { timeout: 2000 }
    );
    return true;
  } catch (e) {
    return false;
  }
}

// Fill form field
async function fillFormField(page, selector, value, fieldName = '') {
  if (!selector || !value) return false;
  try {
    if (!await waitForElementVisible(page, selector)) {
      logMsg(`Field ${fieldName} not visible after wait`);
      return false;
    }
    
    // triple clear
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(REQUEST_DELAY_MS);
    
    // type slowly
    await page.type(selector, safeStr(value), { delay: 25 });
    await sleep(REQUEST_DELAY_MS);
    
    // verify
    const filledVal = await page.inputValue(selector).catch(() => '');
    if (filledVal === safeStr(value)) {
      logMsg(`Field ${fieldName} filled: ${safeStr(value).slice(0, 50)}`);
      return true;
    } else {
      logMsg(`Field ${fieldName} mismatch. Expected: ${safeStr(value)}, Got: ${filledVal}`);
      return false;
    }
  } catch (e) {
    logMsg(`Error filling field ${fieldName}: ${e.message}`);
    return false;
  }
}

// Check checkbox
async function checkCheckbox(page, selector, fieldName = '') {
  if (!selector) return false;
  try {
    const isChecked = await page.$eval(selector, el => el.checked).catch(() => false);
    if (!isChecked) {
      await page.click(selector);
      await sleep(REQUEST_DELAY_MS);
      const nowChecked = await page.$eval(selector, el => el.checked).catch(() => false);
      logMsg(`Checkbox ${fieldName}: ${nowChecked ? 'checked' : 'failed'}`);
      return nowChecked;
    }
    return true;
  } catch (e) {
    logMsg(`Error checking checkbox ${fieldName}: ${e.message}`);
    return false;
  }
}

// Extract captcha
async function extractCaptcha(page) {
  try {
    const captchaBoxSel = await findSelector(page, SELECTOR_MAP.captchaBox);
    if (!captchaBoxSel) {
      logMsg('Captcha box selector not found');
      return null;
    }

    const rawText = (await page.textContent(captchaBoxSel) || '').trim();
    if (!rawText) {
      logMsg('Captcha box has no text');
      return null;
    }

    let code = rawText
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean)[0] || rawText;

    code = code.replace(/\s+/g, '');

    if (code.length < 3) {
      code = rawText.replace(/[^a-zA-Z0-9]/g, '');
    }

    if (code && code.length >= 3) {
      logMsg(`Captcha extracted: "${code}"`);
      return code;
    }

    logMsg(`Captcha extraction failed. Raw: "${rawText}"`);
    return null;
  } catch (e) {
    logMsg(`Error extracting captcha: ${e.message}`);
    return null;
  }
}

// Apply antibot (FIXED - no page.setUserAgent)
async function applyAntiBot(page) {
  if (!USE_ANTIBOT) return;
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin' },
          { name: 'Chrome PDF Viewer' }
        ]
      });
      window.chrome = { runtime: {} };
    });
    logMsg('Anti-bot stealth mode applied');
  } catch (e) {
    logMsg(`Anti-bot injection warning: ${e.message}`);
  }
}

async function attemptRegistration(item, idx, attemptNo) {
  let browser, context, page;
  const result = {
    id: idx,
    sourceRow: JSON.stringify(item),
    status: 'unknown',
    message: '',
    screenshot: '',
    attempts: attemptNo,
    captcha_detected: false,
    timestamp: nowTs()
  };

  const browserLaunchOptions = {
    headless: HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-resources',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      ...BROWSER_ARGS
    ]
  };
  if (PROXY) browserLaunchOptions.proxy = { server: PROXY };

  try {
    browser = await chromium.launch(browserLaunchOptions);
    
    // FIXED: Set user agent in context options, not on page
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    page = await context.newPage();

    // Apply anti-bot
    await applyAntiBot(page);

    // Set timeouts
    page.setDefaultNavigationTimeout(40_000);
    page.setDefaultTimeout(20_000);

    // Navigate
    logMsg(`Row ${idx} attempt ${attemptNo}: navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 40_000 });
    await sleep(800);

    // Fill form
    const fillResults = {};
    for (const key of ['name', 'ktp', 'phone']) {
      const selectors = SELECTOR_MAP[key];
      if (!selectors) continue;
      const sel = await findSelector(page, selectors);
      if (!sel) continue;
      const val = item[key] ?? item[key?.toLowerCase?.()] ?? item[key?.toUpperCase?.()];
      if (val === undefined || val === null) continue;
      fillResults[key] = await fillFormField(page, sel, safeStr(val), key);
    }

    // Check checkboxes
    for (const chk of ['check1', 'check2']) {
      const selectors = SELECTOR_MAP[chk];
      if (!selectors) continue;
      const sel = await findSelector(page, selectors);
      if (!sel) continue;
      const wantRaw = item[chk] ?? item[chk + '_'] ?? item.accept ?? item.agree;
      const want = wantRaw === undefined ? true : ['true', '1', 'yes', 'y'].includes(String(wantRaw).toLowerCase());
      if (want) {
        await checkCheckbox(page, sel, chk);
      }
    }

    // Handle captcha
    const captchaCode = await extractCaptcha(page);
    if (captchaCode) {
      result.captcha_detected = true;
      const captchaInputSel = await findSelector(page, SELECTOR_MAP.captchaInput);
      if (captchaInputSel) {
        await fillFormField(page, captchaInputSel, captchaCode, 'captcha');
      }
    }

    // Submit
    logMsg(`Row ${idx} attempt ${attemptNo}: submitting form`);
    const submitSel = await findSelector(page, SELECTOR_MAP.submitBtn);
    
    if (submitSel) {
      await page.click(submitSel);
    } else {
      const formSel = await findSelector(page, SELECTOR_MAP.form);
      if (formSel) {
        await page.$eval(formSel, f => f.submit());
      }
    }

    await sleep(WAIT_AFTER_SUBMIT);

    // Detect result
    const successIndicators = [
      '.alert-success',
      '.success-message',
      '.modal-success',
      '.toast-success',
      '[class*="success"]'
    ];

    const errorIndicators = [
      '.alert-danger',
      '.error-message',
      '.validation-error',
      '.toast-error',
      '[class*="error"]'
    ];

    let successFound = false;
    for (const sel of successIndicators) {
      try {
        const el = await page.$(sel);
        if (el) {
          successFound = true;
          result.status = 'success';
          result.message = (await el.textContent() || '').trim().slice(0, 1000);
          break;
        }
      } catch (e) { /* ignore */ }
    }

    if (!successFound) {
      let errorFound = false;
      for (const sel of errorIndicators) {
        try {
          const el = await page.$(sel);
          if (el) {
            errorFound = true;
            result.status = 'error';
            result.message = (await el.textContent() || '').trim().slice(0, 1000);
            break;
          }
        } catch (e) { /* ignore */ }
      }

      if (!errorFound) {
        result.status = 'unknown';
        const title = await page.title().catch(() => '');
        const bodyText = (await page.textContent('body') || '').replace(/\s+/g, ' ').trim();
        result.message = `title:${title} body:${bodyText.slice(0, 800)}`;
      }
    }

    // Screenshot
    try {
      const ktpSafe = (item.ktp || 'no_ktp').toString().replace(/\s+/g, '_').slice(0, 30);
      const ss = path.join(OUTPUT_DIR, `screenshot_${ktpSafe}_${NAME_PREFIX}.png`);
      await page.screenshot({ path: ss, fullPage: true });
      result.screenshot = ss;
    } catch (e) {
      logMsg(`Screenshot error: ${e.message}`);
    }

    result.timestamp = nowTs();
    return result;

  } catch (e) {
    logMsg(`Attempt ${attemptNo} exception: ${e.message}`);
    result.status = 'exception';
    result.message = (e.message || String(e)).slice(0, 1000);
    result.timestamp = nowTs();
    return result;
  } finally {
    try { if (page) await page.close().catch(() => {}); } catch (e) {}
    try { if (context) await context.close().catch(() => {}); } catch (e) {}
    try { if (browser) await browser.close().catch(() => {}); } catch (e) {}
  }
}

async function runRegistration(item, idx) {
  const result = {
    id: idx,
    sourceRow: JSON.stringify(item),
    status: 'unknown',
    message: '',
    screenshot: '',
    attempts: 0,
    captcha_detected: false,
    timestamp: nowTs()
  };

  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    logMsg(`Row ${idx}: attempt ${attempt}/${MAX_ATTEMPTS}`);

    try {
      const attemptPromise = attemptRegistration(item, idx, attempt);
      const res = await Promise.race([
        attemptPromise,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`timeout ${ATTEMPT_TIMEOUT_MS}ms`)), ATTEMPT_TIMEOUT_MS)
        )
      ]);

      Object.assign(result, res);
      result.attempts = attempt;

      if (result.status === 'success') {
        logMsg(`Row ${idx}: SUCCESS on attempt ${attempt}`);
        break;
      } else {
        logMsg(`Row ${idx}: status=${result.status}, msg=${(result.message || '').slice(0, 150)}`);
      }
    } catch (err) {
      logMsg(`Row ${idx}: attempt ${attempt} failed: ${err.message}`);
      result.status = 'exception';
      result.message = (err.message || String(err)).slice(0, 1000);
    }

    // Exponential backoff
    if (attempt < MAX_ATTEMPTS) {
      const baseBackoff = Math.min(35_000, 800 * Math.pow(1.8, attempt));
      const jitter = Math.random() * 2000;
      const backoff = baseBackoff + jitter;
      logMsg(`Row ${idx}: waiting ${Math.round(backoff)}ms before retry`);
      await sleep(backoff);
    }
  }

  result.timestamp = nowTs();
  result.attempts = attempt;
  return result;
}

async function runAll() {
  logMsg('=== BATCH REGISTRATION STARTED ===');
  logMsg(`Configuration: TARGET=${TARGET_URL}, CONCURRENCY=${CONCURRENCY}, MAX_ATTEMPTS=${MAX_ATTEMPTS}`);

  try {
    const data = await loadInput();
    const total = data.length;
    logMsg(`Loaded ${total} records`);

    const toProcess = ITERATIONS ? data.slice(0, ITERATIONS) : data;
    const results = [];

    if (MODE === 'sequential' || CONCURRENCY <= 1) {
      for (let i = 0; i < toProcess.length; i++) {
        logMsg(`Processing row ${i + 1}/${toProcess.length}`);
        const res = await runRegistration(toProcess[i], i + 1);
        results.push(res);
        await sleep(500);
      }
    } else {
      const queue = toProcess.map((d, i) => ({ d, i }));
      let batchNum = 0;
      while (queue.length) {
        batchNum++;
        const batch = queue.splice(0, CONCURRENCY);
        logMsg(`Processing batch ${batchNum} (${batch.length} items)`);
        const promises = batch.map(b => runRegistration(b.d, b.i + 1));
        const batchRes = await Promise.all(promises);
        results.push(...batchRes);
        await sleep(500);
      }
    }

    // Write results
    await csvWriter.writeRecords(results.map(r => ({
      id: r.id,
      sourceRow: r.sourceRow,
      status: r.status,
      message: r.message,
      screenshot: r.screenshot,
      attempts: r.attempts,
      captcha_detected: r.captcha_detected,
      timestamp: r.timestamp
    })));

    // Summary
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const exceptionCount = results.filter(r => r.status === 'exception').length;
    const unknownCount = results.filter(r => r.status === 'unknown').length;

    logMsg('=== BATCH REGISTRATION COMPLETED ===');
    logMsg(`Results: Success=${successCount}, Error=${errorCount}, Exception=${exceptionCount}, Unknown=${unknownCount}`);
    logMsg(`Output file: ${path.join(OUTPUT_DIR, 'results.csv')}`);
    logMsg(`Log file: ${logFile}`);

  } catch (err) {
    logMsg(`FATAL ERROR: ${err.message || err}`);
    try {
      const errPath = path.join(OUTPUT_DIR, `fatal_${Date.now()}.log`);
      fs.writeFileSync(errPath, String(err.stack || err));
    } catch (e) {}
    process.exit(1);
  }
}

logMsg('Process started');
runAll();

/*
Example run command:
  TARGET_URL="https://www.antrigrahadipta.com" NAME_PREFIX="antrigrahadipta" MODE="sequential" CONCURRENCY=1 HEADLESS=true MAX_ATTEMPTS=20 WAIT_AFTER_SUBMIT=3000 REQUEST_DELAY_MS=800 node app.js

*/
