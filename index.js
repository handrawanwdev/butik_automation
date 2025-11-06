/**
 * 🚀 BATCH REGISTRATION SYSTEM v2.0
 * Fixed: Using Bottleneck instead of p-limit for CommonJS compatibility
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const dns = require("dns").promises;
const Bottleneck = require("bottleneck");
const { fetch: undiciFetch } = require("undici");
const { CookieJar } = require("tough-cookie");
const fetchCookie = require("fetch-cookie").default;

// Optional: Puppeteer untuk reCAPTCHA v3
let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch (e) {
  // Puppeteer tidak required
}

// ═══════════════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // API Configuration
  API: {
    url: (process.env.API_URL || "https://antrisimatupang.com").trim(),
    timeout: {
      pageLoad: 8000,
      postSubmit: 12000,
      totalRequest: 15000,
    },
  },

  // reCAPTCHA Configuration
  RECAPTCHA: {
    ENABLED: true,
    SITEKEY: "6Lcnt-IrAAAAACaARn5oz_zj56mqFv_plVglvyaf",
    USE_PUPPETEER: true,
    PUPPETEER_TIMEOUT: 30000,
  },

  // File Paths
  paths: {
    CSV_FILE: "batch_data.csv",
    ERROR_DIR: path.join(__dirname, "errors"),
    ERROR_LOG: path.join(__dirname, "errors.log"),
    PAGES_DIR: path.join(__dirname, "pages"),
    BATCH_LOG: path.join(__dirname, "batch.log"),
    RESULT_DIR: path.join(__dirname, "results"),
  },

  // Retry & Backoff
  retry: {
    MAX_RETRY: 3,
    RETRY_DELAY: 2000,
    MAX_BACKOFF: 10000,
    BACKOFF_MULTIPLIER: 1.5,
  },

  // Concurrency & Batching
  concurrency: {
    PARALLEL_LIMIT: 3,
    PEAK_HOUR: 15,
    PEAK_MINUTE_RANGE: 2,
    PEAK_LIMIT: 2,
    BATCH_DELAY_MIN: 300,
    BATCH_DELAY_MAX: 900,
  },

  // Session Management
  session: {
    CACHE_MAX_SIZE: 50,
    FRESH_SESSION_PER_KTP: true,
  },

  // Scheduler
  scheduler: {
    OFFSET_MS: 100,
  },

  // Performance
  performance: {
    MAX_HTML_SIZE: 1000000,
    FLUSH_INTERVAL: 1000,
    MAX_PROCESSED_DATA: 1000,
  },

  // Headers
  headers: {
    USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ACCEPT: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    ACCEPT_LANGUAGE: "en-US,en;q=0.5",
    ACCEPT_ENCODING: "gzip, deflate, br",
  },

  // Parse CLI arguments
  parseArgs: (args = process.argv.slice(2)) => {
    const options = {};
    args.forEach((arg) => {
      const [k, v] = arg.split("=");
      if (k && v) options[k.replace(/^--/, "")] = v;
    });
    return options;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 📝 LOGGER CLASS
// ═══════════════════════════════════════════════════════════════════════════

class BatchLogger {
  constructor(errorDir, errorLog, batchLog) {
    this.errorDir = errorDir;
    this.errorLog = errorLog;
    this.batchLog = batchLog;
    this.ensureDirectories();
    this.initLogFiles();
  }

  ensureDirectories() {
    [this.errorDir, path.dirname(this.batchLog)].forEach((dir) => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  initLogFiles() {
    if (!fs.existsSync(this.errorLog)) {
      fs.writeFileSync(this.errorLog, "timestamp,ktp,name,error_message\n");
    }
    if (!fs.existsSync(this.batchLog)) {
      fs.writeFileSync(this.batchLog, "");
    }
  }

  timestamp() {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  error(ktp, name, message) {
    const ts = this.timestamp();
    const msg = `[${ts}] ❌ ERROR | ${ktp}|${name}: ${message}`;
    console.error(msg);
    fs.appendFileSync(
      this.errorLog,
      `${ts},${ktp},${name},"${message.replace(/"/g, '""')}"\n`
    );
    fs.appendFileSync(this.batchLog, msg + "\n");
  }

  success(ktp, name, nomor) {
    const ts = this.timestamp();
    const msg = `[${ts}] ✅ SUCCESS | ${ktp}|${name} → ${nomor}`;
    console.log(msg);
    fs.appendFileSync(this.batchLog, msg + "\n");
  }

  warn(message) {
    const ts = this.timestamp();
    const msg = `[${ts}] ⚠️  WARN: ${message}`;
    console.warn(msg);
    fs.appendFileSync(this.batchLog, msg + "\n");
  }

  info(message) {
    const ts = this.timestamp();
    const msg = `[${ts}] ℹ️  INFO: ${message}`;
    console.log(msg);
    fs.appendFileSync(this.batchLog, msg + "\n");
  }

  debug(message, verbose = false) {
    if (!verbose) return;
    const ts = this.timestamp();
    const msg = `[${ts}] 🔧 DEBUG: ${message}`;
    console.log(msg);
    fs.appendFileSync(this.batchLog, msg + "\n");
  }

  saveErrorPage(ktp, html) {
    const dir = path.join(this.errorDir, "error_pages");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `error_${ktp}_${Date.now()}.html`);
    fs.writeFileSync(file, html);
    return file;
  }

  savePage(ktp, html) {
    const dir = path.join(this.errorDir, "pages");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `page_${ktp}_${Date.now()}.html`);
    fs.writeFileSync(file, html);
    return file;
  }

  printMetrics(metrics) {
    const ts = this.timestamp();
    const duration = ((Date.now() - metrics.startTime) / 1000).toFixed(2);
    const successRate = ((metrics.successCount / (metrics.totalRequests || 1)) * 100).toFixed(2);
    const msg = `
╔════════════════════════════════════════════════════╗
║             📊 BATCH METRICS SUMMARY               ║
╠════════════════════════════════════════════════════╣
║ Total Requests    : ${String(metrics.totalRequests).padEnd(30)} ║
║ Success           : ${String(metrics.successCount).padEnd(30)} ║
║ Failed            : ${String(metrics.errorCount).padEnd(30)} ║
║ Success Rate      : ${String(successRate + "%").padEnd(30)} ║
║ Avg Response Time : ${String(metrics.avgResponseTime.toFixed(2) + "ms").padEnd(30)} ║
║ Duration          : ${String(duration + "s").padEnd(30)} ║
║ Finish Time       : ${ts.padEnd(32)} ║
╚════════════════════════════════════════════════════╝
`;
    console.log(msg);
    fs.appendFileSync(this.batchLog, msg + "\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔧 UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

const randomDelay = () =>
  Math.floor(
    Math.random() *
      (CONFIG.concurrency.BATCH_DELAY_MAX - CONFIG.concurrency.BATCH_DELAY_MIN)
  ) + CONFIG.concurrency.BATCH_DELAY_MIN;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const timestamp = () => {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function isOnline() {
  try {
    await dns.resolve("google.com");
    return true;
  } catch {
    return false;
  }
}

async function isServerUp(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.API.timeout.pageLoad);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

async function waitUntilServerUp(url, logger, retryDelay = 5000) {
  while (true) {
    const online = await isOnline();
    if (!online) {
      logger.warn("Tidak ada koneksi internet, tunggu koneksi...");
      await delay(retryDelay);
      continue;
    }

    const serverUp = await isServerUp(url);
    if (serverUp) {
      return;
    }

    logger.warn(`Server masih down, ulangi cek dalam ${retryDelay / 1000} detik...`);
    await delay(retryDelay + Math.random() * 2000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🤖 RECAPTCHA V3 TOKEN GENERATOR (PUPPETEER)
// ═══════════════════════════════════════════════════════════════════════════

let browser = null;

async function initBrowser() {
  if (!puppeteer) {
    throw new Error(
      "Puppeteer tidak terinstall. Jalankan: npm install puppeteer"
    );
  }

  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }

  return browser;
}

async function getRecaptchaToken(pageUrl, sitekey) {
  try {
    if (!CONFIG.RECAPTCHA.USE_PUPPETEER) {
      return null;
    }

    const b = await initBrowser();
    const page = await b.newPage();

    page.setDefaultNavigationTimeout(CONFIG.RECAPTCHA.PUPPETEER_TIMEOUT);
    page.setDefaultTimeout(CONFIG.RECAPTCHA.PUPPETEER_TIMEOUT);

    await page.goto(pageUrl, { waitUntil: "networkidle2" });

    const token = await page.evaluate((sk) => {
      return new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "https://www.google.com/recaptcha/api.js";
        document.head.appendChild(script);

        script.onload = () => {
          grecaptcha.ready(() => {
            grecaptcha
              .execute(sk, { action: "submit" })
              .then((token) => {
                resolve(token);
              })
              .catch((err) => {
                resolve(null);
              });
          });
        };

        setTimeout(() => resolve(null), 15000);
      });
    }, sitekey);

    await page.close();
    return token;
  } catch (err) {
    console.error("🔴 Error getRecaptchaToken:", err.message);
    return null;
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔁 FETCH WITH RETRY
// ═══════════════════════════════════════════════════════════════════════════

async function fetchWithRetry(url, opts = {}, retryCount = CONFIG.retry.MAX_RETRY, logger = null) {
  let delayMs = CONFIG.retry.RETRY_DELAY;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    if (!(await isOnline())) {
      if (logger) logger.debug(`[${attempt}/${retryCount}] Offline, tunggu 5 detik...`);
      await delay(5000);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.API.timeout.totalRequest);
      const res = await undiciFetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (logger) logger.debug(`[${attempt}/${retryCount}] ${err.message}`);

      if (attempt < retryCount) {
        await delay(delayMs);
        delayMs = Math.min(delayMs * CONFIG.retry.BACKOFF_MULTIPLIER, CONFIG.retry.MAX_BACKOFF);
      } else {
        throw new Error(`Gagal fetch setelah ${retryCount} percobaan: ${err.message}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 📂 CSV READER & CACHE
// ═══════════════════════════════════════════════════════════════════════════

let csvCache = null;

function readCSVOptimized(file) {
  if (csvCache) return csvCache;

  if (!fs.existsSync(file)) {
    throw new Error(`CSV tidak ditemukan: ${file}`);
  }

  const raw = fs.readFileSync(file, "utf-8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const required = ["name", "ktp", "phone"];
  if (!records.length) throw new Error("CSV kosong");

  const missing = required.filter((c) => !(c in records[0]));
  if (missing.length) throw new Error(`Kolom hilang: ${missing.join(", ")}`);

  const normalized = records.map((r) => ({
    name: (r.name || "").trim(),
    ktp: (r.ktp || "").replace(/\D/g, "").slice(0, 16),
    phone: (r.phone || "").replace(/\D/g, "").slice(0, 12),
  }));

  csvCache = normalized;
  return normalized;
}

function checkCSVFile(file, logger) {
  logger.info(`Cek file CSV: ${file}`);
  try {
    const data = readCSVOptimized(file);
    logger.info(`Ditemukan ${data.length} baris data.`);
    if (!data.length) {
      logger.warn(`File ${file} kosong. Silakan isi data.`);
      process.exit(0);
    }
    logger.info(`File ${file} valid dengan ${data.length} baris data.`);
  } catch (err) {
    logger.error("CSV", "PARSER", err.message);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🧑 SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const sessionCache = new Map();

function getOrCreateSession(ktp) {
  if (sessionCache.has(ktp)) {
    return sessionCache.get(ktp);
  }

  const jar = new CookieJar();
  sessionCache.set(ktp, jar);

  if (sessionCache.size > CONFIG.session.CACHE_MAX_SIZE) {
    const firstKey = sessionCache.keys().next().value;
    sessionCache.delete(firstKey);
  }

  return jar;
}

// ═══════════════════════════════════════════════════════════════════════════
// 📤 POST DATA WITH RECAPTCHA V3
// ═══════════════════════════════════════════════════════════════════════════

async function postData(item, apiUrl, logger) {
  const maxAttempts = CONFIG.retry.MAX_RETRY;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const jar = CONFIG.session.FRESH_SESSION_PER_KTP
        ? new CookieJar()
        : getOrCreateSession(item.ktp);

      const localFetch = fetchCookie(undiciFetch, jar);

      // 1️⃣ GET halaman awal
      const pageRes = await localFetch(apiUrl, {
        method: "GET",
        headers: {
          "User-Agent": CONFIG.headers.USER_AGENT,
          Accept: CONFIG.headers.ACCEPT,
          "Accept-Language": CONFIG.headers.ACCEPT_LANGUAGE,
          "Accept-Encoding": CONFIG.headers.ACCEPT_ENCODING,
          DNT: "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
      });

      const html = await pageRes.text();

      // Save halaman
      if (html.length <= CONFIG.performance.MAX_HTML_SIZE) {
        logger.savePage(item.ktp, html);
      }

      // Check if pendaftaran tutup
      if (html.toUpperCase().includes("TUTUP") || html.toUpperCase().includes("MAAF")) {
        throw new Error("Pendaftaran ditutup");
      }

      // Extract token CSRF
      const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/i);
      if (!tokenMatch) throw new Error("_token tidak ditemukan");
      const token = tokenMatch[1];

      // Extract captcha
      const captchaMatch = html.match(/<div[^>]+id=["']captcha-box["'][^>]*>([\s\S]*?)<\/div>/i);
      const captcha = captchaMatch
        ? captchaMatch[1].replace(/[\s\r\n\t]+/g, "").trim()
        : "";

      // 🤖 GET reCAPTCHA v3 TOKEN
      let recaptchaToken = null;
      if (CONFIG.RECAPTCHA.ENABLED) {
        logger.debug(`🤖 Mengambil reCAPTCHA token untuk ${item.ktp}...`);
        recaptchaToken = await getRecaptchaToken(apiUrl, CONFIG.RECAPTCHA.SITEKEY);
        
        if (!recaptchaToken) {
          logger.warn(`⚠️  reCAPTCHA token gagal untuk ${item.ktp}, lanjut tanpa token`);
        } else {
          logger.debug(`✅ reCAPTCHA token berhasil untuk ${item.ktp}`);
        }
      }

      // Prepare payload dengan reCAPTCHA token
      const payload = {
        name: item.name,
        ktp: item.ktp,
        phone_number: item.phone,
        captcha_input: captcha,
        check: "on",
        check_2: "on",
        _token: token,
      };

      // Tambah reCAPTCHA response jika ada
      if (recaptchaToken) {
        payload["g-recaptcha-response"] = recaptchaToken;
      }

      logger.debug(`📤 Kirim: ${item.ktp}|${item.name} (Attempt ${attempt}/${maxAttempts})`);

      // 2️⃣ POST submit
      const postRes = await localFetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": CONFIG.headers.USER_AGENT,
          Referer: apiUrl,
          Accept: CONFIG.headers.ACCEPT,
          "Accept-Language": CONFIG.headers.ACCEPT_LANGUAGE,
          "Accept-Encoding": CONFIG.headers.ACCEPT_ENCODING,
          DNT: "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
        body: new URLSearchParams(payload).toString(),
      });

      const postHtml = await postRes.text();

      // Check success
      if (postHtml.includes("Pendaftaran Berhasil")) {
        const noMatch = postHtml.match(/Nomor\s+Antrian:\s*([A-Z0-9]+\s*[A-Z]-\d+)/i);
        const nomor = noMatch ? noMatch[1] : "Nomor tidak terbaca";
        logger.success(item.ktp, item.name, nomor);

        return {
          ...payload,
          status: "OK",
          info: `Pendaftaran berhasil, Nomor Antrian: ${nomor}`,
          error_message: "",
          recaptcha_used: !!recaptchaToken,
        };
      }

      // Check token expired
      if (
        postHtml.includes("419") ||
        postHtml.includes("Page Expired") ||
        postHtml.includes("TokenMismatch")
      ) {
        if (attempt < maxAttempts) {
          await delay(Math.floor(Math.random() * 600) + 300);
          continue;
        } else {
          throw new Error("Token expired berulang");
        }
      }

      // Extract error message
      const errMatch = postHtml.match(/<div class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/i);
      const errMsg = errMatch
        ? errMatch[1].replace(/<[^>]+>/g, "").trim() || "Validasi gagal"
        : "Error tidak dikenal";

      logger.saveErrorPage(item.ktp, postHtml);
      logger.error(item.ktp, item.name, errMsg);

      return {
        ...payload,
        status: "ERROR",
        error_message: errMsg,
        info: "Error response saved",
        recaptcha_used: !!recaptchaToken,
      };
    } catch (err) {
      lastError = err;
      const msg = err.message || "Unknown error";
      logger.debug(`[Attempt ${attempt}/${maxAttempts}] ${msg}`);

      if (attempt === maxAttempts) {
        logger.error(item.ktp, item.name, msg);
      }
    }
  }

  return {
    ...item,
    status: "ERROR",
    error_message: lastError ? lastError.message : "Gagal setelah semua percobaan",
    info: "",
    recaptcha_used: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 💾 SAVE RESULTS
// ═══════════════════════════════════════════════════════════════════════════

function saveResults(data, csvFileName) {
  if (!data.length) return;

  if (!fs.existsSync(CONFIG.paths.RESULT_DIR)) {
    fs.mkdirSync(CONFIG.paths.RESULT_DIR, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const resultName = `${csvFileName.toLowerCase().replace(".csv", "")}_${ts}`;

  const jsonFile = path.join(CONFIG.paths.RESULT_DIR, `${resultName}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2));

  const headers = Object.keys(data[0]);
  const csv =
    headers.join(",") +
    "\n" +
    data
      .map((d) =>
        headers
          .map((h) => `"${(d[h] ?? "").toString().replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

  const csvFile = path.join(CONFIG.paths.RESULT_DIR, `${resultName}.csv`);
  fs.writeFileSync(csvFile, csv);

  return { jsonFile, csvFile };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🧩 MAIN BATCH EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

async function runBatch(apiUrl, csvFile, logger) {
  logger.info("═══════════════════════════════════════════════════════════");
  logger.info(`🚀 Mulai batch untuk ${apiUrl}`);
  logger.info(`📁 CSV File: ${csvFile}`);
  logger.info(`🤖 reCAPTCHA: ${CONFIG.RECAPTCHA.ENABLED ? "ENABLED" : "DISABLED"}`);

  const startTime = Date.now();
  let processedData = [];
  const metrics = {
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    avgResponseTime: 0,
    startTime,
    responseTimes: [],
  };

  try {
    await waitUntilServerUp(apiUrl, logger);

    // Init browser jika reCAPTCHA enabled
    if (CONFIG.RECAPTCHA.ENABLED && CONFIG.RECAPTCHA.USE_PUPPETEER) {
      logger.info("🌐 Initializing Puppeteer browser...");
      try {
        await initBrowser();
        logger.info("✅ Puppeteer browser ready");
      } catch (err) {
        logger.warn(`⚠️  Puppeteer init failed: ${err.message}. Lanjut tanpa reCAPTCHA.`);
        CONFIG.RECAPTCHA.USE_PUPPETEER = false;
      }
    }

    const data = readCSVOptimized(csvFile);
    const now = new Date();
    const isPeakTime =
      now.getHours() === CONFIG.concurrency.PEAK_HOUR &&
      now.getMinutes() < CONFIG.concurrency.PEAK_MINUTE_RANGE;
    const parallelLimit = isPeakTime
      ? CONFIG.concurrency.PEAK_LIMIT
      : CONFIG.concurrency.PARALLEL_LIMIT;

    logger.info(`Memproses ${data.length} entri (parallel limit: ${parallelLimit})`);

    // 🚀 GUNAKAN BOTTLENECK SEBAGAI PENGGANTI P-LIMIT
    const limiter = new Bottleneck({
      maxConcurrent: parallelLimit,
      minTime: 100, // Min time antara request (ms)
    });

    const tasks = [];

    for (let i = 0; i < data.length; i++) {
      tasks.push(
        limiter.schedule(async () => {
          const startReq = Date.now();
          const result = await postData(data[i], apiUrl, logger);

          metrics.totalRequests++;
          if (result.status === "OK") {
            metrics.successCount++;
          } else {
            metrics.errorCount++;
          }

          const respTime = Date.now() - startReq;
          metrics.responseTimes.push(respTime);
          metrics.avgResponseTime =
            metrics.responseTimes.reduce((a, b) => a + b, 0) /
            metrics.responseTimes.length;

          processedData.push(result);

          if (processedData.length % CONFIG.performance.MAX_PROCESSED_DATA === 0) {
            saveResults(processedData, csvFile);
            processedData = [];
          }

          return result;
        })
      );

      if ((i + 1) % parallelLimit === 0 && i + 1 < data.length) {
        await delay(randomDelay());
      }
    }

    await Promise.all(tasks);

    if (processedData.length > 0) {
      const result = saveResults(processedData, csvFile);
      logger.info(`Hasil disimpan ke ${path.basename(result.csvFile)} dan ${path.basename(result.jsonFile)}`);
    }

    logger.printMetrics(metrics);
  } catch (err) {
    logger.error("BATCH", "MAIN", err.message);
  } finally {
    // Close browser
    if (CONFIG.RECAPTCHA.ENABLED && CONFIG.RECAPTCHA.USE_PUPPETEER) {
      logger.info("🌐 Closing Puppeteer browser...");
      await closeBrowser();
    }

    logger.info("═══════════════════════════════════════════════════════════");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ⏰ SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════

function getDelayToTime(hour, minute = 0, second = 0) {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    second,
    CONFIG.scheduler.OFFSET_MS
  );

  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

async function scheduleBatch(apiUrl, csvFile, logger, scheduleHour, scheduleMinute, scheduleSecond) {
  logger.info(
    `🕒 Batch dijadwalkan pukul ${String(scheduleHour).padStart(2, "0")}:${String(
      scheduleMinute
    ).padStart(2, "0")}:${String(scheduleSecond).padStart(2, "0")}`
  );

  let isRunning = false;

  setInterval(async () => {
    if (isRunning) return;

    const delayMs = getDelayToTime(scheduleHour, scheduleMinute, scheduleSecond);
    const hours = Math.floor(delayMs / 3600000);
    const minutes = Math.floor((delayMs % 3600000) / 60000);
    const seconds = Math.floor((delayMs % 60000) / 1000);

    process.stdout.write(
      `\r🕒 Waktu tunda → ${String(hours).padStart(2, "0")}:${String(minutes).padStart(
        2,
        "0"
      )}:${String(seconds).padStart(2, "0")}`
    );

    if (hours === 0 && minutes === 0 && seconds === 0) {
      console.log("\n");
      isRunning = true;
      await runBatch(apiUrl, csvFile, logger).catch((err) =>
        logger.error("BATCH", "SCHEDULER", err.message)
      );
      isRunning = false;
    }
  }, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// 🛑 GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

let shutdownInProgress = false;

process.on("SIGINT", async () => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.log("\n");
  console.log("🛑 Shutting down gracefully...");
  
  if (browser) {
    console.log("🌐 Closing browser...");
    await closeBrowser();
  }

  console.log("✅ Shutdown complete");
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// ▶️  MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const cliOptions = CONFIG.parseArgs();
  const apiUrl = cliOptions.url || CONFIG.API.url;
  const csvFile = cliOptions.csv || CONFIG.paths.CSV_FILE;
  const mode = cliOptions.mode || "1";
  const scheduleHour = parseInt(cliOptions.hour) || CONFIG.concurrency.PEAK_HOUR;
  const scheduleMinute = parseInt(cliOptions.minute) || 0;
  const scheduleSecond = parseInt(cliOptions.second) || 0;

  [CONFIG.paths.ERROR_DIR, CONFIG.paths.RESULT_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  const logger = new BatchLogger(
    CONFIG.paths.ERROR_DIR,
    CONFIG.paths.ERROR_LOG,
    CONFIG.paths.BATCH_LOG
  );

  checkCSVFile(csvFile, logger);

  if (mode === "0") {
    logger.info("🔥 Mode: Immediate Execution");
    await runBatch(apiUrl, csvFile, logger).catch((err) =>
      logger.error("BATCH", "MAIN", err.message)
    );
  } else {
    logger.info("🕒 Mode: Scheduled Execution");
    await scheduleBatch(apiUrl, csvFile, logger, scheduleHour, scheduleMinute, scheduleSecond);
  }
}

main().catch((err) => {
  console.error("🚨 Fatal error:", err.message);
  process.exit(1);
});