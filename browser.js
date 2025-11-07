/**
 * 🚀 BATCH REGISTRATION SYSTEM (Puppeteer Edition)
 * - Full browser flow using Puppeteer (no raw HTTP)
 * - Wait/poll until registration form is actually open
 * - Robust navigation retries + timeouts
 * - reCAPTCHA v3 supported via grecaptcha.execute on-page
 * - CSV dedupe by KTP, structured logging, results saved (CSV + JSON)
 *
 * Usage:
 *   node batch_puppeteer.js --url=https://antrisimatupang.com --csv=batch_data.csv --mode=wait
 * Options:
 *   --mode=wait        Wait/poll until form is open, then submit all rows
 *   --mode=now         Submit immediately (no waiting)
 *   --hour=15 --minute=0 --second=0   Optional scheduled target time (used only with --mode=wait-at)
 *   --mode=wait-at     Open browser early and wait on-page until the scheduled time, then submit
 *
 * Dependencies:
 *   npm i puppeteer csv-parse
 */

const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const { parse } = require("csv-parse/sync");
const puppeteer = require("puppeteer");

// ═══════════════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  API_URL: (process.env.API_URL || "https://antrisimatupang.com").trim(),

  TIMEOUT: {
    pageLoad: 15000,
    postSubmit: 20000,
    total: 25000,
  },

  RECAPTCHA: {
    ENABLED: true,
    SITEKEY: "6Lcnt-IrAAAAACaARn5oz_zj56mqFv_plVglvyaf", // change if needed
    ENABLE_INJECTION: true, // if recaptcha api not present, inject ?render=
  },

  PATHS: {
    CSV_FILE: "batch_data.csv",
    ERROR_DIR: path.join(__dirname, "errors"),
    PAGES_DIR: path.join(__dirname, "pages"),
    ERR_LOG: path.join(__dirname, "errors.log"),
    BATCH_LOG: path.join(__dirname, "batch.log"),
    RESULT_DIR: path.join(__dirname, "results"),
  },

  RETRY: {
    MAX_ATTEMPTS_PER_ITEM: 3,
    POLL_RELOAD_MS_MIN: 1500,
    POLL_RELOAD_MS_MAX: 4000,
  },

  BROWSER: {
    headless: "new", // set to false for visible browser
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    language: "en-US,en;q=0.9",
    userAgents: [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ],
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  },

  SELECTORS: {
    // Adjust selectors if site markup differs
    form: "form", // main form
    name: 'input[name="name"]',
    ktp: 'input[name="ktp"]',
    phone: 'input[name="phone_number"]',
    captchaBox: '#captcha-box', // optional
    captchaInput: 'input[name="captcha_input"]', // optional
    check1: 'input[name="check"]',
    check2: 'input[name="check_2"]',
    token: 'input[name="_token"]',
    submitBtn: 'button[type="submit"], input[type="submit"]',
    recaptchaResponse: 'input[name="g-recaptcha-response"]',
  },

  SCHEDULER: {
    OFFSET_MS: 120,
  },

  PERFORMANCE: {
    SAVE_HTML_ON_ERROR: true,
  },

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
// 🧰 HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const randomUA = () =>
  CONFIG.BROWSER.userAgents[
    Math.floor(Math.random() * CONFIG.BROWSER.userAgents.length)
  ];

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function isOnline() {
  try {
    await dns.resolve("google.com");
    return true;
  } catch {
    return false;
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class BatchLogger {
  constructor() {
    [CONFIG.PATHS.ERROR_DIR, CONFIG.PATHS.RESULT_DIR].forEach((dir) => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
    if (!fs.existsSync(CONFIG.PATHS.ERR_LOG)) {
      fs.writeFileSync(CONFIG.PATHS.ERR_LOG, "timestamp,ktp,name,error\n");
    }
    if (!fs.existsSync(CONFIG.PATHS.BATCH_LOG)) {
      fs.writeFileSync(CONFIG.PATHS.BATCH_LOG, "");
    }
  }
  info(msg) {
    const line = `[${timestamp()}] ℹ️  ${msg}`;
    console.log(line);
    fs.appendFileSync(CONFIG.PATHS.BATCH_LOG, line + "\n");
  }
  warn(msg) {
    const line = `[${timestamp()}] ⚠️  ${msg}`;
    console.warn(line);
    fs.appendFileSync(CONFIG.PATHS.BATCH_LOG, line + "\n");
  }
  error(ktp, name, msg) {
    const line = `[${timestamp()}] ❌ ${ktp}|${name}: ${msg}`;
    console.error(line);
    fs.appendFileSync(CONFIG.PATHS.BATCH_LOG, line + "\n");
    fs.appendFileSync(
      CONFIG.PATHS.ERR_LOG,
      `${timestamp()},${ktp},${name},"${(msg || "")
        .toString()
        .replace(/"/g, '""')}"\n`
    );
  }
  success(ktp, name, nomor) {
    const line = `[${timestamp()}] ✅ ${ktp}|${name} → ${nomor}`;
    console.log(line);
    fs.appendFileSync(CONFIG.PATHS.BATCH_LOG, line + "\n");
  }
  saveHtml(prefix, ktp, html) {
    try {
      if (!CONFIG.PERFORMANCE.SAVE_HTML_ON_ERROR) return;
      const dir = path.join(CONFIG.PATHS.ERROR_DIR, "pages");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${prefix}_${ktp}_${Date.now()}.html`);
      fs.writeFileSync(file, html || "");
      return file;
    } catch {}
    return null;
  }
}

function readCSV(file) {
  if (!fs.existsSync(file)) throw new Error(`CSV tidak ditemukan: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const required = ["name", "ktp", "phone"];
  if (!records.length) throw new Error("CSV kosong");
  const missing = required.filter((c) => !(c in records[0]));
  if (missing.length) throw new Error(`Kolom hilang: ${missing.join(", ")}`);

  const cleaned = records
    .map((r) => ({
      name: (r.name || "").trim(),
      ktp: (r.ktp || "").replace(/\D/g, "").slice(0, 16),
      phone: (r.phone || "").replace(/\D/g, "").slice(0, 12),
    }))
    .filter((r) => r.name && r.ktp && r.phone);

  const seen = new Set();
  const deduped = cleaned.filter((r) => {
    if (seen.has(r.ktp)) return false;
    seen.add(r.ktp);
    return true;
  });

  return deduped;
}

function saveResults(rows, csvFile) {
  if (!rows.length) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = path.basename(csvFile, path.extname(csvFile));
  const base = `${name}_${ts}`;
  const jsonPath = path.join(CONFIG.PATHS.RESULT_DIR, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2));

  const headers = Object.keys(rows[0]);
  const csv =
    headers.join(",") +
    "\n" +
    rows
      .map((r) =>
        headers
          .map((h) => `"${(r[h] ?? "").toString().replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");
  const csvPath = path.join(CONFIG.PATHS.RESULT_DIR, `${base}.csv`);
  fs.writeFileSync(csvPath, csv);

  return { jsonPath, csvPath };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🌐 PUPPETEER: BROWSER + PAGE SETUP
// ═══════════════════════════════════════════════════════════════════════════

async function launchBrowser(logger) {
  const browser = await puppeteer.launch({
    headless: CONFIG.BROWSER.headless,
    args: CONFIG.BROWSER.args,
  });
  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();

  await page.setUserAgent(randomUA());
  await page.setViewport(CONFIG.BROWSER.viewport);
  await page.setExtraHTTPHeaders({
    "Accept-Language": CONFIG.BROWSER.language,
  });

  // Abort images/fonts to reduce load a bit (optional)
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const r = req.resourceType();
    if (r === "image" || r === "font" || r === "media") req.abort();
    else req.continue();
  });

  // Simple console piping
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "warning") logger.warn(`[page] ${msg.text()}`);
    else if (type === "error") logger.error("PAGE", "CONSOLE", msg.text());
  });

  return { browser, context, page };
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * ⏳ WAIT UNTIL REGISTRATION OPEN
 * - Polls the page: reloads until _token + enabled submit button present
 * - Also avoids typical "TUTUP/MAAF" closed states
 */
// ═══════════════════════════════════════════════════════════════════════════

async function isRegistrationOpen(page) {
  return await page.evaluate((sel) => {
    const text = document.body.innerText || "";
    const closed =
      /\b(TUTUP|MAAF|Pendaftaran\s+Ditutup|Page\s+Expired)\b/i.test(text);
    if (closed) return false;

    const token = document.querySelector(sel.token);
    const submit = document.querySelector(sel.submitBtn);
    if (!token || !submit) return false;

    const disabled =
      submit.hasAttribute("disabled") ||
      submit.getAttribute("aria-disabled") === "true";
    return !disabled;
  }, CONFIG.SELECTORS);
}

async function waitUntilOpen(page, url, logger) {
  logger.info("Menunggu hingga form pendaftaran benar-benar terbuka...");
  while (true) {
    const online = await isOnline();
    if (!online) {
      logger.warn("Tidak ada koneksi internet, retry 5 detik...");
      await delay(5000);
      continue;
    }
    try {
      await page.goto(url, {
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: CONFIG.TIMEOUT.pageLoad,
      });
      const open = await isRegistrationOpen(page);
      if (open) {
        logger.info("✅ Form terdeteksi terbuka & siap digunakan");
        return;
      }
      const next = rand(CONFIG.RETRY.POLL_RELOAD_MS_MIN, CONFIG.RETRY.POLL_RELOAD_MS_MAX);
      logger.warn(`Form belum terbuka. Reload lagi dalam ${Math.round(next / 1000)} detik...`);
      await delay(next);
    } catch (err) {
      logger.warn(`Gagal memuat halaman (${err.message}), coba lagi...`);
      await delay(rand(1500, 3500));
    }
  }
}

function getDelayToTime(hour, minute = 0, second = 0) {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    second,
    CONFIG.SCHEDULER.OFFSET_MS
  );
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

async function waitUntilScheduled(page, url, logger, hour, minute, second) {
  const ms = getDelayToTime(hour, minute, second);
  const end = Date.now() + ms;
  logger.info(
    `🕒 Menunggu jadwal ${String(hour).padStart(2, "0")}:${String(minute).padStart(
      2,
      "0"
    )}:${String(second).padStart(2, "0")} (~${Math.round(ms / 1000)} detik)`
  );
  // Preload and sit on the page, then do a tight wait loop for the last seconds
  try {
    await page.goto(url, {
      waitUntil: ["domcontentloaded", "networkidle2"],
      timeout: CONFIG.TIMEOUT.pageLoad,
    });
  } catch {}
  while (Date.now() < end) {
    const remaining = end - Date.now();
    process.stdout.write(
      `\r⏳ Tersisa ${String(Math.floor(remaining / 1000)).padStart(3, " ")} detik`
    );
    await delay(250);
  }
  process.stdout.write("\n");
  logger.info("⏰ Waktu tercapai. Memulai proses pendaftaran...");
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 🤖 reCAPTCHA v3 TOKEN (in-page)
 */
// ═══════════════════════════════════════════════════════════════════════════

async function getRecaptchaV3Token(page, siteKey) {
  try {
    const hasGrecaptcha = await page.evaluate(() => !!window.grecaptcha);
    if (!hasGrecaptcha && CONFIG.RECAPTCHA.ENABLED && CONFIG.RECAPTCHA.ENABLE_INJECTION) {
      // Inject v3 render API
      await page.addScriptTag({
        url: `https://www.google.com/recaptcha/api.js?render=${siteKey}`,
      });
      // Small wait to ensure grecaptcha loads
      await page.waitForFunction(() => !!window.grecaptcha, { timeout: 10000 });
    }

    const token = await page.evaluate(
      (sk) =>
        new Promise((resolve) => {
          if (!window.grecaptcha || !window.grecaptcha.execute) {
            resolve(null);
            return;
          }
          window.grecaptcha.ready(() => {
            window.grecaptcha
              .execute(sk, { action: "submit" })
              .then((t) => resolve(t))
              .catch(() => resolve(null));
          });
          setTimeout(() => resolve(null), 15000);
        }),
      siteKey
    );

    return token || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 📝 FILL + SUBMIT FORM (single item)
 */
// ═══════════════════════════════════════════════════════════════════════════

async function submitOne(page, url, logger, item) {
  let lastErr = null;

  for (let attempt = 1; attempt <= CONFIG.RETRY.MAX_ATTEMPTS_PER_ITEM; attempt++) {
    try {
      // Always load fresh form to pick up a fresh CSRF token
      await page.goto(url, {
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: CONFIG.TIMEOUT.pageLoad,
      });

      // Ensure form open
      const open = await isRegistrationOpen(page);
      if (!open) {
        if (attempt < CONFIG.RETRY.MAX_ATTEMPTS_PER_ITEM) {
          logger.warn(
            `${item.ktp}|${item.name}: Form belum terbuka (att ${attempt}), reload...`
          );
          await delay(rand(300, 700));
          continue;
        } else {
          throw new Error("Form belum terbuka setelah beberapa percobaan");
        }
      }

      // Wait for main fields
      await page.waitForSelector(CONFIG.SELECTORS.name, { timeout: 8000 });
      await page.waitForSelector(CONFIG.SELECTORS.ktp, { timeout: 8000 });
      await page.waitForSelector(CONFIG.SELECTORS.phone, { timeout: 8000 });
      await page.waitForSelector(CONFIG.SELECTORS.token, { timeout: 8000 });

      // Fill fields with human-ish typing
      await page.focus(CONFIG.SELECTORS.name);
      await page.keyboard.type(item.name, { delay: rand(20, 60) });

      await page.focus(CONFIG.SELECTORS.ktp);
      await page.keyboard.type(item.ktp, { delay: rand(15, 40) });

      await page.focus(CONFIG.SELECTORS.phone);
      await page.keyboard.type(item.phone, { delay: rand(15, 40) });

      // Checkbox terms if present
      const check1 = await page.$(CONFIG.SELECTORS.check1);
      if (check1) await page.evaluate((sel) => (document.querySelector(sel).checked = true), CONFIG.SELECTORS.check1);
      const check2 = await page.$(CONFIG.SELECTORS.check2);
      if (check2) await page.evaluate((sel) => (document.querySelector(sel).checked = true), CONFIG.SELECTORS.check2);

      // If site uses simple captcha text in #captcha-box → put that into input[name=captcha_input]
      const captchaInput = await page.$(CONFIG.SELECTORS.captchaInput);
      if (captchaInput) {
        const captchaText = await page.$eval(
          CONFIG.SELECTORS.captchaBox,
          (el) => (el.innerText || el.textContent || "").trim()
        ).catch(() => "");
        if (captchaText) {
          await page.focus(CONFIG.SELECTORS.captchaInput);
          await page.keyboard.type(captchaText, { delay: rand(20, 40) });
        }
      }

      // reCAPTCHA v3 (if enabled)
      let recaptchaUsed = false;
      if (CONFIG.RECAPTCHA.ENABLED && CONFIG.RECAPTCHA.SITEKEY) {
        const token = await getRecaptchaV3Token(page, CONFIG.RECAPTCHA.SITEKEY);
        if (token) {
          recaptchaUsed = true;
          const hasField = await page.$(CONFIG.SELECTORS.recaptchaResponse);
          if (hasField) {
            await page.$eval(
              CONFIG.SELECTORS.recaptchaResponse,
              (el, t) => (el.value = t),
              token
            );
          } else {
            // create hidden input inside form
            await page.$eval(
              CONFIG.SELECTORS.form,
              (form, t) => {
                const input = document.createElement("input");
                input.type = "hidden";
                input.name = "g-recaptcha-response";
                input.value = t;
                form.appendChild(input);
              },
              token
            );
          }
        } else {
          logger.warn(`${item.ktp}|${item.name}: reCAPTCHA token gagal, lanjut tanpa token`);
        }
      }

      // Submit
      const submitSel = CONFIG.SELECTORS.submitBtn;
      await page.waitForSelector(submitSel, { timeout: 8000 });

      const navPromise = page.waitForNavigation({
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: CONFIG.TIMEOUT.postSubmit,
      }).catch(() => null);

      await page.click(submitSel).catch(async () => {
        // fallback direct submit
        await page.$eval(CONFIG.SELECTORS.form, (f) => f.submit());
      });

      await navPromise;

      // Parse result
      const html = await page.content();
      // Success
      if (/Pendaftaran\s+Berhasil/i.test(html)) {
        const noMatch = html.match(/Nomor\s+Antrian:\s*([A-Z0-9]+\s*[A-Z]-\d+)/i);
        const nomor = noMatch ? noMatch[1] : "Nomor tidak terbaca";
        logger.success(item.ktp, item.name, nomor);
        return {
          ...item,
          status: "OK",
          info: `Pendaftaran berhasil, Nomor Antrian: ${nomor}`,
          recaptcha_used: recaptchaUsed,
          error_message: "",
        };
      }

      // Already registered
      if (/sudah\s+terdaftar|sudah\s+melakukan\s+pendaftaran/i.test(html)) {
        logger.warn(`Data ${item.ktp} terdeteksi sudah terdaftar`);
        return {
          ...item,
          status: "OK",
          info: "Sudah terdaftar",
          recaptcha_used: recaptchaUsed,
          error_message: "",
        };
      }

      // Token/expired
      if (/419|Page\s+Expired|TokenMismatch/i.test(html)) {
        if (attempt < CONFIG.RETRY.MAX_ATTEMPTS_PER_ITEM) {
          logger.warn(`${item.ktp}|${item.name}: Token mismatch/expired, retry...`);
          await delay(rand(300, 800));
          continue;
        } else {
          throw new Error("Token expired berulang");
        }
      }

      // Generic error
      const errDiv = html.match(/<div class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/i);
      const errMsg = errDiv
        ? errDiv[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
        : "Validasi gagal / Error tidak dikenal";

      if (CONFIG.PERFORMANCE.SAVE_HTML_ON_ERROR) {
        try {
          const file = (new BatchLogger()).saveHtml("error", item.ktp, html);
          logger.warn(`Error response disimpan: ${path.basename(file || "")}`);
        } catch {}
      }

      return {
        ...item,
        status: "ERROR",
        info: "",
        recaptcha_used: false,
        error_message: errMsg,
      };
    } catch (err) {
      lastErr = err;
      if (attempt === CONFIG.RETRY.MAX_ATTEMPTS_PER_ITEM) {
        (new BatchLogger()).error(item.ktp, item.name, err.message || "Unknown error");
        return {
          ...item,
          status: "ERROR",
          info: "",
          recaptcha_used: false,
          error_message: err.message || "Gagal setelah semua percobaan",
        };
      }
      await delay(rand(400, 900));
    }
  }

  return {
    ...item,
    status: "ERROR",
    info: "",
    recaptcha_used: false,
    error_message: lastErr ? lastErr.message : "Gagal setelah semua percobaan",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ▶️  MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = CONFIG.parseArgs();
  const url = args.url || CONFIG.API_URL;
  const csvFile = args.csv || CONFIG.PATHS.CSV_FILE;
  const mode = (args.mode || "wait").toLowerCase(); // wait | now | wait-at
  const hour = parseInt(args.hour || "15", 10);
  const minute = parseInt(args.minute || "0", 10);
  const second = parseInt(args.second || "0", 10);

  const logger = new BatchLogger();

  // Load CSV
  let rows;
  try {
    rows = readCSV(csvFile);
    logger.info(`CSV OK: ${rows.length} baris (dedupe by KTP)`);
  } catch (err) {
    logger.error("CSV", "PARSER", err.message);
    process.exit(1);
  }

  // Browser
  const { browser, page } = await launchBrowser(logger);

  try {
    if (mode === "now") {
      logger.info("🔥 Mode: Immediate submit (tanpa menunggu)");
    } else if (mode === "wait") {
      await waitUntilOpen(page, url, logger);
    } else if (mode === "wait-at") {
      await waitUntilScheduled(page, url, logger, hour, minute, second);
      // after reaching time, ensure form open (poll if needed)
      await waitUntilOpen(page, url, logger);
    } else {
      logger.warn(`Mode tidak dikenal: ${mode}. Gunakan "wait", "wait-at", atau "now".`);
      await waitUntilOpen(page, url, logger);
    }

    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const item = rows[i];
      logger.info(`📤 ${i + 1}/${rows.length} Kirim: ${item.ktp}|${item.name}`);
      const res = await submitOne(page, url, logger, item);
      results.push(res);
      // Small pacing between submissions
      await delay(rand(250, 800));
    }

    const saved = saveResults(results, csvFile);
    if (saved) {
      logger.info(`Hasil disimpan: ${path.basename(saved.csvPath)}, ${path.basename(saved.jsonPath)}`);
    }
  } catch (err) {
    logger.error("BATCH", "MAIN", err.message);
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT: Menutup browser...");
  process.exit(0);
});

main().catch((err) => {
  console.error("🚨 Fatal:", err);
  process.exit(1);
});