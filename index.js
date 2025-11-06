/**
 * 🚀 BATCH REGISTRATION SYSTEM v2.1
 * Improvements:
 * - Keep-Alive Agent (undici) for stable & faster connections
 * - Robust headers (browser-like) + randomized User-Agent pool
 * - CSRF extraction fallback (meta csrf-token)
 * - Smarter retry (429/503 Retry-After, exponential backoff + jitter)
 * - Reuse CookieJar per KTP across attempts to reduce 419
 * - Adaptive concurrency based on error rate and latency
 * - Deduplicate CSV entries by KTP
 * - Safer server-up check
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const dns = require("dns").promises;
const Bottleneck = require("bottleneck");
const { fetch: undiciFetch, Agent, setGlobalDispatcher } = require("undici");
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

let CONFIG = {
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
    USER_AGENT:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ACCEPT:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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
/**
 * 🌐 UNDICI GLOBAL AGENT + HEADER HELPERS
 */
// ═══════════════════════════════════════════════════════════════════════════

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 20_000,
    connections: 100,
    pipelining: 1,
  })
);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];
function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildBrowserHeaders(apiUrl, overrides = {}) {
  const url = new URL(apiUrl);
  return {
    "User-Agent": CONFIG.headers.USER_AGENT,
    Accept: CONFIG.headers.ACCEPT,
    "Accept-Language": CONFIG.headers.ACCEPT_LANGUAGE,
    "Accept-Encoding": CONFIG.headers.ACCEPT_ENCODING,
    "Cache-Control": "max-age=0",
    Pragma: "no-cache",
    DNT: "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Origin: `${url.protocol}//${url.host}`,
    Host: url.host,
    ...overrides,
  };
}

function extractCsrf(html) {
  // input hidden
  const m1 = html.match(/name="_token"\s+value="([^"]+)"/i);
  if (m1) return m1[1];
  // meta csrf-token
  const m2 = html.match(
    /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i
  );
  if (m2) return m2[1];
  return null;
}

function getRetryAfterSeconds(res) {
  const ra = res.headers.get("retry-after");
  if (!ra) return null;
  const asNum = Number(ra);
  if (!Number.isNaN(asNum)) return Math.max(1, asNum);
  return 3;
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 📝 LOGGER CLASS
 */
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
    const successRate = (
      (metrics.successCount / (metrics.totalRequests || 1)) *
      100
    ).toFixed(2);
    const msg = `
╔════════════════════════════════════════════════════╗
║             📊 BATCH METRICS SUMMARY               ║
╠════════════════════════════════════════════════════╣
║ Total Requests    : ${String(metrics.totalRequests).padEnd(30)} ║
║ Success           : ${String(metrics.successCount).padEnd(30)} ║
║ Failed            : ${String(metrics.errorCount).padEnd(30)} ║
║ Success Rate      : ${String(successRate + "%").padEnd(30)} ║
║ Avg Response Time : ${String(
      metrics.avgResponseTime.toFixed(2) + "ms"
    ).padEnd(30)} ║
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
  const timer = setTimeout(
    () => controller.abort(),
    CONFIG.API.timeout.pageLoad
  );
  try {
    const res = await undiciFetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Consider server up for typical HEAD denials but reachable
    return res.ok || res.status === 405 || res.status === 400;
  } catch {
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

    logger.warn(
      `Server masih down, ulangi cek dalam ${retryDelay / 1000} detik...`
    );
    await delay(retryDelay + Math.random() * 2000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 🤖 RECAPTCHA V3 TOKEN GENERATOR (PUPPETEER)
 */
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
              .catch(() => {
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
/**
 * 🔁 FETCH WITH RETRY (generic, optional)
 */
// ═══════════════════════════════════════════════════════════════════════════

async function fetchWithRetry(
  url,
  opts = {},
  retryCount = CONFIG.retry.MAX_RETRY,
  logger = null
) {
  let delayMs = CONFIG.retry.RETRY_DELAY;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    if (!(await isOnline())) {
      if (logger) logger.debug(`[${attempt}/${retryCount}] Offline, tunggu 5 detik...`);
      await delay(5000);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        CONFIG.API.timeout.totalRequest
      );
      const res = await undiciFetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (logger) logger.debug(`[${attempt}/${retryCount}] ${err.message}`);

      if (attempt < retryCount) {
        await delay(delayMs);
        delayMs = Math.min(
          delayMs * CONFIG.retry.BACKOFF_MULTIPLIER,
          CONFIG.retry.MAX_BACKOFF
        );
      } else {
        throw new Error(
          `Gagal fetch setelah ${retryCount} percobaan: ${err.message}`
        );
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 📂 CSV READER & CACHE
 */
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
/**
 * 🧑 SESSION MANAGEMENT
 */
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
/**
 * 📤 POST DATA WITH RECAPTCHA V3 (robust)
 */
// ═══════════════════════════════════════════════════════════════════════════

async function postData(item, apiUrl, logger) {
  const maxAttempts = CONFIG.retry.MAX_RETRY;
  let lastError = null;

  // REUSE jar per item KTP agar CSRF/cookie konsisten di semua attempt
  const jar = CONFIG.session.FRESH_SESSION_PER_KTP
    ? new CookieJar()
    : getOrCreateSession(item.ktp);

  const localFetch = fetchCookie(undiciFetch, jar);

  // Gunakan UA yang sama untuk semua attempt pada item ini
  const selectedUA = randomUA();

  async function smartFetch(url, opts, label) {
    let delayMs = CONFIG.retry.RETRY_DELAY;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          CONFIG.API.timeout.totalRequest
        );
        const res = await localFetch(url, { ...opts, signal: controller.signal });
        clearTimeout(timeout);

        if (res.status === 429 || res.status === 503) {
          const ra = getRetryAfterSeconds(res);
          const wait =
            (ra ? ra * 1000 : Math.min(delayMs, CONFIG.retry.MAX_BACKOFF)) +
            Math.floor(Math.random() * 500);
          logger.warn(
            `${label}: ${res.status} → tunggu ${Math.round(wait / 1000)} detik (Retry-After=${ra ?? "-"})`
          );
          await delay(wait);
          delayMs = Math.min(
            delayMs * CONFIG.retry.BACKOFF_MULTIPLIER,
            CONFIG.retry.MAX_BACKOFF
          );
          continue;
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (err) {
        const msg = err.name === "AbortError" ? "Timeout" : err.message;
        logger.debug(`[${label}] attempt ${attempt}/${maxAttempts} → ${msg}`);

        if (attempt === maxAttempts) throw err;

        await delay(delayMs + Math.floor(Math.random() * 400));
        delayMs = Math.min(
          delayMs * CONFIG.retry.BACKOFF_MULTIPLIER,
          CONFIG.retry.MAX_BACKOFF
        );
      }
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 1) GET halaman awal (ambil CSRF, captcha fragment)
      const getRes = await smartFetch(
        apiUrl,
        {
          method: "GET",
          headers: buildBrowserHeaders(apiUrl, { "User-Agent": selectedUA }),
        },
        "GET_PAGE"
      );
      const html = await getRes.text();

      if (html.length <= CONFIG.performance.MAX_HTML_SIZE) {
        logger.savePage(item.ktp, html);
      }

      if (/\b(TUTUP|MAAF)\b/i.test(html)) {
        throw new Error("Pendaftaran ditutup");
      }

      const token = extractCsrf(html);
      if (!token) {
        if (attempt < maxAttempts) {
          logger.warn("CSRF token tidak ditemukan, coba ulang...");
          await delay(300 + Math.floor(Math.random() * 600));
          continue;
        } else {
          throw new Error("_token tidak ditemukan");
        }
      }

      const captchaMatch = html.match(
        /<div[^>]+id=["']captcha-box["'][^>]*>([\s\S]*?)<\/div>/i
      );
      const captcha = captchaMatch
        ? captchaMatch[1].replace(/[\s\r\n\t]+/g, "").trim()
        : "";

      // 2) reCAPTCHA v3 (opsional)
      let recaptchaToken = null;
      if (CONFIG.RECAPTCHA.ENABLED) {
        logger.debug(`🤖 Mengambil reCAPTCHA token untuk ${item.ktp}...`);
        recaptchaToken = await getRecaptchaToken(
          apiUrl,
          CONFIG.RECAPTCHA.SITEKEY
        );
        if (!recaptchaToken) {
          logger.warn(
            `⚠️  reCAPTCHA token gagal untuk ${item.ktp}, lanjut tanpa token`
          );
        } else {
          logger.debug(`✅ reCAPTCHA token berhasil untuk ${item.ktp}`);
        }
      }

      // 3) POST submit
      const payload = {
        name: item.name,
        ktp: item.ktp,
        phone_number: item.phone,
        captcha_input: captcha,
        check: "on",
        check_2: "on",
        _token: token,
      };
      if (recaptchaToken) payload["g-recaptcha-response"] = recaptchaToken;

      logger.debug(
        `📤 Kirim: ${item.ktp}|${item.name} (Attempt ${attempt}/${maxAttempts})`
      );

      const postHeaders = buildBrowserHeaders(apiUrl, {
        "User-Agent": selectedUA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: apiUrl,
      });

      const postRes = await smartFetch(
        apiUrl,
        {
          method: "POST",
          headers: postHeaders,
          body: new URLSearchParams(payload).toString(),
        },
        "POST_SUBMIT"
      );

      const postHtml = await postRes.text();

      // Sukses
      if (/Pendaftaran\s+Berhasil/i.test(postHtml)) {
        const noMatch = postHtml.match(
          /Nomor\s+Antrian:\s*([A-Z0-9]+\s*[A-Z]-\d+)/i
        );
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

      // 419/token mismatch
      if (/419|Page\s+Expired|TokenMismatch/i.test(postHtml)) {
        if (attempt < maxAttempts) {
          logger.warn("Token mismatch/expired, refresh dan coba ulang...");
          await delay(300 + Math.floor(Math.random() * 700));
          continue;
        } else {
          throw new Error("Token expired berulang");
        }
      }

      // Sudah terdaftar?
      const alreadyMatch = postHtml.match(
        /sudah\s+terdaftar|sudah\s+melakukan\s+pendaftaran/i
      );
      if (alreadyMatch) {
        logger.warn(`Data ${item.ktp} terdeteksi sudah terdaftar`);
        return {
          ...payload,
          status: "OK",
          info: "Sudah terdaftar",
          error_message: "",
          recaptcha_used: !!recaptchaToken,
        };
      }

      // Ambil pesan error
      const errMatch = postHtml.match(
        /<div class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/i
      );
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
      } else {
        await delay(400 + Math.floor(Math.random() * 700));
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
/**
 * 💾 SAVE RESULTS
 */
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
/**
 * ⚖️ ADAPTIVE CONCURRENCY
 */
// ═══════════════════════════════════════════════════════════════════════════

function computeNextConcurrency(metrics, current, baseLimit) {
  const windowSize = 20; // evaluasi per 20 request
  if (metrics.responseTimes.length < windowSize) return current;

  const recentTimes = metrics.responseTimes.slice(-windowSize);
  const recentAvg = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;

  const recentTotal = Math.min(windowSize, metrics.totalRequests);
  const totalSoFar = metrics.successCount + metrics.errorCount;
  const considered = Math.min(recentTotal, totalSoFar);
  // Approximate recent error rate using last window
  const recentErrors = metrics.errorCount - Math.max(0, metrics.errorCount - considered);
  const errRate = recentErrors / (considered || 1);

  let next = current;

  if (errRate >= 0.35 || recentAvg > 3500) {
    next = Math.max(1, current - 1);
  } else if (errRate <= 0.1 && recentAvg < 1800) {
    next = Math.min(baseLimit + 2, current + 1);
  }

  return next;
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 🧩 MAIN BATCH EXECUTION
 */
// ═══════════════════════════════════════════════════════════════════════════

async function runBatch(apiUrl, csvFile, logger) {
  logger.info("═══════════════════════════════════════════════════════════");
  logger.info(`🚀 Mulai batch untuk ${apiUrl}`);
  logger.info(`📁 CSV File: ${csvFile}`);
  logger.info(
    `🤖 reCAPTCHA: ${CONFIG.RECAPTCHA.ENABLED ? "ENABLED" : "DISABLED"}`
  );

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
        logger.warn(
          `⚠️  Puppeteer init failed: ${err.message}. Lanjut tanpa reCAPTCHA.`
        );
        CONFIG.RECAPTCHA.USE_PUPPETEER = false;
      }
    }

    // Load data + dedup by KTP
    let data = readCSVOptimized(csvFile);
    const seen = new Set();
    data = data.filter((r) => {
      if (!r.ktp) return false;
      if (seen.has(r.ktp)) return false;
      seen.add(r.ktp);
      return true;
    });

    const now = new Date();
    const isPeakTime =
      now.getHours() === CONFIG.concurrency.PEAK_HOUR &&
      now.getMinutes() < CONFIG.concurrency.PEAK_MINUTE_RANGE;
    const baseParallelLimit = isPeakTime
      ? CONFIG.concurrency.PEAK_LIMIT
      : CONFIG.concurrency.PARALLEL_LIMIT;

    logger.info(
      `Memproses ${data.length} entri (initial parallel limit: ${baseParallelLimit})`
    );

    // 🚀 BOTTLENECK
    const limiter = new Bottleneck({
      maxConcurrent: baseParallelLimit,
      minTime: 100, // Min time antara request (ms)
    });

    let currentConcurrency = baseParallelLimit;

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

          // Adaptive concurrency setiap 10 request
          if (metrics.totalRequests % 10 === 0) {
            const next = computeNextConcurrency(
              metrics,
              currentConcurrency,
              baseParallelLimit
            );
            if (next !== currentConcurrency) {
              limiter.updateSettings({ maxConcurrent: next });
              logger.info(`⚖️  Update concurrency: ${currentConcurrency} → ${next}`);
              currentConcurrency = next;
            }
          }

          if (
            processedData.length % CONFIG.performance.MAX_PROCESSED_DATA ===
            0
          ) {
            saveResults(processedData, csvFile);
            processedData = [];
          }

          return result;
        })
      );

      if ((i + 1) % baseParallelLimit === 0 && i + 1 < data.length) {
        await delay(randomDelay());
      }
    }

    await Promise.all(tasks);

    if (processedData.length > 0) {
      const result = saveResults(processedData, csvFile);
      logger.info(
        `Hasil disimpan ke ${path.basename(result.csvFile)} dan ${path.basename(
          result.jsonFile
        )}`
      );
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
/**
 * ⏰ SCHEDULER
 */
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

async function scheduleBatch(
  apiUrl,
  csvFile,
  logger,
  scheduleHour,
  scheduleMinute,
  scheduleSecond
) {
  logger.info(
    `🕒 Batch dijadwalkan pukul ${String(scheduleHour).padStart(
      2,
      "0"
    )}:${String(scheduleMinute).padStart(2, "0")}:${String(
      scheduleSecond
    ).padStart(2, "0")}`
  );

  let isRunning = false;

  setInterval(async () => {
    if (isRunning) return;

    const delayMs = getDelayToTime(
      scheduleHour,
      scheduleMinute,
      scheduleSecond
    );
    const hours = Math.floor(delayMs / 3600000);
    const minutes = Math.floor((delayMs % 3600000) / 60000);
    const seconds = Math.floor((delayMs % 60000) / 1000);

    process.stdout.write(
      `\r🕒 Waktu tunda → ${String(hours).padStart(2, "0")}:${String(
        minutes
      ).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
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
/**
 * 🛑 GRACEFUL SHUTDOWN
 */
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
/**
 * ▶️  MAIN ENTRY POINT
 */
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
  logger.info(`Server URL: ${apiUrl}`);
  if (mode === "0") {
    logger.info("🔥 Mode: Immediate Execution ");
    await runBatch(apiUrl, csvFile, logger).catch((err) =>
      logger.error("BATCH", "MAIN", err.message)
    );
  } else {
    logger.info("🕒 Mode: Scheduled Execution ");
    await scheduleBatch(
      apiUrl,
      csvFile,
      logger,
      scheduleHour,
      scheduleMinute,
      scheduleSecond
    );
  }
}

main().catch((err) => {
  console.error("🚨 Fatal error:", err.message);
  process.exit(1);
});