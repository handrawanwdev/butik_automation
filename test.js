// content.js - Auto Form Filler (Enhanced Success Detection + Screenshot Preview + API Timeout + Fix captureFormData + Log Trim + Always Screenshot + Dedup)
(function () {
  "use strict";

  const CFG = {
    DEFAULT_URL: "https://antrigrahadipta.com/",
    DEFAULT_PARALLEL: 2,
    DEFAULT_RETRY: 3,
    WAIT_FORM_MAX_MS: 30 * 60 * 1000,
    REFRESH_INTERVAL_MS: 500,
    SUBMIT_TIMEOUT_MS: 20000, // 20 detik untuk server response
    FALLBACK_TIMEOUT_MS: 3000, // 3 detik sebelum fallback API
    RETRY_DELAY_BASE_MS: 2000,
    MICRO_DELAY_MIN: 5,
    MICRO_DELAY_MAX: 15,
    CLICK_DELAY_MIN: 100,
    CLICK_DELAY_MAX: 600,
    KEY_LOGS: "autosign_logs_v5",
    KEY_STATE: "autosign_state_v5",
    DEFAULT_SCHEDULE: "09:00:00",
    RECAPTCHA_SITE_KEY: "6Lcnt-IrAAAAACaARn5oz_zj56mqFv_plVglvyaf",
    API_CHECK_URL: null, // bisa di-set via UI
    API_TIMEOUT_MS: 8000, // timeout untuk API fallback
    MAX_LOGS: 1500, // trimming agar localStorage tidak over
    VERSION: "1.6.0",
  };

  const store = {
    get: (k, def = null) => {
      try {
        const val = localStorage.getItem(k);
        return Promise.resolve(val ? JSON.parse(val) : def);
      } catch (err) {
        return Promise.resolve(def);
      }
    },
    set: (obj) => {
      try {
        Object.keys(obj).forEach((k) => {
          localStorage.setItem(k, JSON.stringify(obj[k]));
        });
        return Promise.resolve(true);
      } catch (err) {
        return Promise.resolve(false);
      }
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timestamp = () => new Date().toLocaleString("id-ID", { hour12: false });
  const microDelay = () =>
    sleep(
      CFG.MICRO_DELAY_MIN +
        Math.random() * (CFG.MICRO_DELAY_MAX - CFG.MICRO_DELAY_MIN)
    );
  const clickDelay = () =>
    sleep(
      CFG.CLICK_DELAY_MIN +
        Math.random() * (CFG.CLICK_DELAY_MAX - CFG.CLICK_DELAY_MIN)
    );

  const fetchWithTimeout = async (url, options = {}, timeout = CFG.API_TIMEOUT_MS) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  // Enhanced Screenshot: render informasi penting dari halaman untuk jejak audit
  const screenshot = async () => {
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = Math.min(window.innerWidth, 1280);
      canvas.height = Math.min(window.innerHeight, 720);

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#000000";
      ctx.font = "bold 16px Arial";
      ctx.fillText("📸 " + timestamp(), 10, 25);
      ctx.font = "12px Arial";
      ctx.fillText(window.location.href, 10, 45);
      ctx.fillText("AutoSign v" + CFG.VERSION, 10, 62);

      const bodyText = (document.body.innerText || "").replace(/\s+\n/g, "\n");
      const lines = bodyText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 25);

      ctx.font = "11px monospace";
      lines.forEach((line, i) => {
        ctx.fillText(line.substring(0, 120), 10, 85 + i * 14);
      });

      return canvas.toDataURL("image/png");
    } catch (err) {
      console.warn("Screenshot failed:", err);
      return null;
    }
  };

  const notify = (title, text) => {
    console.log(`[${title}] ${text}`);
    return Promise.resolve();
  };

  const formBot = {
    async typeValue(el, val) {
      if (!el) return;
      el.focus();
      el.value = "";
      for (let ch of String(val)) {
        el.value += ch;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await sleep(50 + Math.random() * 100);
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await microDelay();
      el.blur();
    },

    async humanClick(btn) {
      if (!btn) return;
      btn.scrollIntoView({ behavior: "auto", block: "center" });
      await sleep(200 + Math.random() * 300);

      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      for (let i = 0; i < 3; i++) {
        const x = cx + (Math.random() - 0.5) * 10;
        const y = cy + (Math.random() - 0.5) * 10;
        btn.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })
        );
        await sleep(20 + Math.random() * 30);
      }

      await clickDelay();
      btn.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: cx, clientY: cy })
      );
      await sleep(50 + Math.random() * 100);
      btn.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, clientX: cx, clientY: cy })
      );
      btn.click();
      await microDelay();
    },

    findElements() {
      // Perluas variasi selector agar robust di berbagai halaman
      const form =
        document.querySelector("form") ||
        document.querySelector("form[action*='daftar'], form[action*='pendaftaran']");

      const ktp =
        document.querySelector("#ktp, input[name*='ktp' i], input[id*='ktp' i]") ||
        document.querySelector("input[name*='nik' i], input[id*='nik' i]");

      const name =
        document.querySelector("#name, input[name='name'], input[name*='nama' i]") ||
        document.querySelector("input[id*='name' i], input[id*='nama' i]");

      const phone =
        document.querySelector(
          "#phone_number, input[type='tel'], input[name*='phone' i], input[id*='phone' i]"
        ) ||
        document.querySelector("input[name*='hp' i], input[id*='hp' i], input[name*='wa' i]");

      const submit =
        document.querySelector(
          "button[type='submit'], input[type='submit'], button.submit, button#submit, button[class*='submit' i]"
        ) || document.querySelector("button:not([type]):not([disabled])");

      const captchaBox =
        document.querySelector("#captcha-box, .captcha-box, [data-captcha]") ||
        document.querySelector("[id*='captcha' i]");

      const captchaInput =
        document.querySelector("#captcha_input") ||
        document.querySelector("input[name*='captcha' i]");

      const check1 = document.querySelector("#check, input[name='check']");
      const check2 = document.querySelector("#check_2, input[name='check_2']");

      return { form, ktp, name, phone, submit, captchaBox, captchaInput, check1, check2 };
    },

    async waitForForm(maxMs = CFG.WAIT_FORM_MAX_MS) {
      const start = Date.now();
      let lastLog = 0;

      while (Date.now() - start < maxMs) {
        if (app.stopFlag) return null;

        const els = this.findElements();
        if (els.ktp && els.name && els.phone && els.submit) {
          await log.add(null, "INFO", "✅ Form ditemukan dan siap diisi");
          return els;
        }

        const elapsed = Date.now() - start;
        if (elapsed - lastLog > 5000) {
          const remaining = Math.round((maxMs - elapsed) / 1000);
          await log.add(null, "INFO", `⏳ Menunggu form... (${remaining}s tersisa)`);
          lastLog = elapsed;
        }

        await sleep(CFG.REFRESH_INTERVAL_MS);
      }
      throw new Error("Form tidak muncul dalam 30 menit");
    },

    async handleRecaptchaV3(form) {
      if (!form) return;
      const siteKey = CFG.RECAPTCHA_SITE_KEY;
      if (typeof grecaptcha === "undefined" || !siteKey) return;

      try {
        await log.add(null, "INFO", "🔐 Menangani reCAPTCHA v3...");
        await new Promise((resolve) => {
          grecaptcha.ready(() => {
            const exec = grecaptcha.enterprise?.execute || grecaptcha.execute;
            exec(siteKey, { action: "submit" })
              .then((token) => {
                let recaptchaInput = form.querySelector('input[name="g-recaptcha-response"]');
                if (!recaptchaInput) {
                  recaptchaInput = document.createElement("input");
                  recaptchaInput.setAttribute("type", "hidden");
                  recaptchaInput.setAttribute("name", "g-recaptcha-response");
                  form.appendChild(recaptchaInput);
                }
                recaptchaInput.setAttribute("value", token);
                log.add(null, "INFO", "✅ reCAPTCHA v3 token berhasil");
                resolve();
              })
              .catch((err) => {
                log.add(null, "WARN", `⚠️ reCAPTCHA error: ${err.message}`);
                resolve();
              });
          });
        });
      } catch (err) {
        await log.add(null, "WARN", `⚠️ reCAPTCHA gagal: ${err.message}`);
      }
    },

    captureFormData(els, item) {
      // Kumpulkan data aktual dari form untuk fallback API
      const payload = {
        name:
          (els.name && (els.name.value ?? els.name.textContent)?.trim()) ||
          item?.name ||
          "",
        ktp:
          (els.ktp && (els.ktp.value ?? els.ktp.textContent)?.trim()) ||
          item?.ktp ||
          "",
        phone:
          (els.phone && (els.phone.value ?? els.phone.textContent)?.trim()) ||
          item?.phone ||
          "",
      };

      if (els.captchaInput) {
        payload.captcha = els.captchaInput.value?.trim() || "";
      }

      // Sertakan hidden inputs yang mungkin dibutuhkan backend (token, ref, dsb.)
      const hiddenMap = {};
      try {
        const hiddenInputs = els.form
          ? els.form.querySelectorAll('input[type="hidden"], input[name*="token" i]')
          : document.querySelectorAll('input[type="hidden"], input[name*="token" i]');
        hiddenInputs.forEach((h) => {
          const key = h.name || h.id || "";
          if (key) hiddenMap[key] = h.value ?? "";
        });
      } catch (_) {}

      if (Object.keys(hiddenMap).length) payload._hidden = hiddenMap;
      return payload;
    },
  };

  // ENHANCED SUCCESS DETECTOR WITH API FALLBACK
  const detector = {
    check() {
      const text = document.body.innerText || "";
      // Tambahkan variasi pola teks sukses
      if (/Pendaftaran\s+Berhasil!?/i.test(text)) return true;
      if (/Berhasil\s+mendaftar/i.test(text)) return true;
      if (/Pendaftaran\s+Anda\s+berhasil/i.test(text)) return true;
      if (/Nomor\s+Antrian\s*:/i.test(text) && /Ref\s*:/i.test(text)) return true;
      if (/Nomor\s+Antrian/i.test(text) && /Tanggung\s+jawab/i.test(text)) return true;
      return false;
    },

    extractDetails() {
      const text = document.body.innerText || "";
      const info = {};

      const noAntrianMatch = text.match(/Nomor\s+Antrian\s*:\s*([A-Z0-9\-\s]+)/i);
      if (noAntrianMatch) info.noAntrian = noAntrianMatch[1].trim();

      const refMatch = text.match(/Ref\s*:\s*([0-9]+)/i);
      if (refMatch) info.ref = refMatch[1].trim();

      const namaMatch =
        text.match(/Nama\s+KTP\s*:\s*([^\n]+)/i) ||
        text.match(/Nama\s*:\s*([^\n]+)/i);
      if (namaMatch) info.namaKTP = namaMatch[1].trim();

      const ktpMatch = text.match(/Nomor\s+KTP\s*:\s*([*\d]+)/i);
      if (ktpMatch) info.nomorKTP = ktpMatch[1].trim();

      const hpMatch = text.match(/Nomor\s+HP\s*:\s*([*\d]+)/i);
      if (hpMatch) info.nomorHP = hpMatch[1].trim();

      const tanggalMatch =
        text.match(/Tanggal\s+Kedatangan\s*:\s*([0-9\-]+)/i) ||
        text.match(/Tanggal\s*:\s*([0-9\/\-\s]+)/i);
      if (tanggalMatch) info.tanggalKedatangan = tanggalMatch[1].trim();

      const waktuMatch =
        text.match(/Wajib\s+hadir\s+pukul\s+([0-9:.]+\s*-\s*[0-9:.]+)/i) ||
        text.match(/Pukul\s*:\s*([0-9:.]+\s*(?:-\s*[0-9:.]+)?)/i);
      if (waktuMatch) info.waktuHadir = waktuMatch[1].trim();

      return info;
    },

    formatSuccessMessage(info) {
      const parts = ["✅ BERHASIL!"];
      if (info.noAntrian) parts.push(`No: ${info.noAntrian}`);
      if (info.ref) parts.push(`Ref: ${info.ref}`);
      if (info.namaKTP) parts.push(`Nama: ${info.namaKTP}`);
      if (info.tanggalKedatangan) parts.push(`Tgl: ${info.tanggalKedatangan}`);
      if (info.waktuHadir) parts.push(`Waktu: ${info.waktuHadir}`);
      return parts.join(" | ");
    },

    async checkViaAPI(item, formData = null) {
      try {
        const state = await store.get(CFG.KEY_STATE, {});
        const apiUrl = state.apiCheckUrl || CFG.API_CHECK_URL;
        if (!apiUrl) {
          return { ok: false, reason: "API URL tidak diset" };
        }

        await log.add(item, "INFO", "🌐 Fallback: Mengirim data ke API...");

        const payload = formData || {
          ktp: item.ktp,
          phone: item.phone,
          name: item.name,
        };

        await log.add(
          item,
          "INFO",
          `📦 Data: ${JSON.stringify(payload).substring(0, 160)}...`
        );

        const response = await fetchWithTimeout(
          apiUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(payload),
          },
          CFG.API_TIMEOUT_MS
        );

        if (!response.ok) {
          throw new Error(`API HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        const isSuccess =
          data.success === true || data.status === "success" || data.code === 200;
        const resultData = data.data || data.result || data;

        if (isSuccess && resultData) {
          const info = {
            noAntrian:
              resultData.noAntrian ||
              resultData.no_antrian ||
              resultData.queue_number,
            ref:
              resultData.ref ||
              resultData.reference ||
              resultData.reference_number,
            namaKTP:
              resultData.namaKTP ||
              resultData.nama ||
              resultData.name ||
              item.name,
            nomorKTP: resultData.nomorKTP || resultData.nomor_ktp || item.ktp,
            nomorHP: resultData.nomorHP || resultData.nomor_hp || item.phone,
            tanggalKedatangan:
              resultData.tanggal ||
              resultData.tanggalKedatangan ||
              resultData.date,
            waktuHadir:
              resultData.waktu || resultData.waktuHadir || resultData.time,
          };

          const message = this.formatSuccessMessage(info);
          await log.add(item, "INFO", "✅ API: Pendaftaran berhasil!");
          return { ok: true, info, message, source: "API" };
        }

        const errorMsg = data.message || data.error || data.msg || "Pendaftaran tidak berhasil";
        return { ok: false, reason: `API: ${errorMsg}`, apiResponse: data };
      } catch (err) {
        const reason =
          err.name === "AbortError"
            ? `API Timeout (${Math.round(CFG.API_TIMEOUT_MS / 1000)}s)`
            : `API Error: ${err.message}`;
        await log.add(item, "WARN", `⚠️ ${reason}`);
        return { ok: false, reason };
      }
    },

    async waitSuccess(item, formData = null, timeoutMs = CFG.SUBMIT_TIMEOUT_MS) {
      const start = Date.now();
      let fallbackTriggered = false;

      while (Date.now() - start < timeoutMs) {
        if (app.stopFlag) return { ok: false, reason: "Dihentikan user" };

        // Cek UI response
        if (this.check()) {
          await sleep(1200); // beri waktu konten lengkap tertulis
          const info = this.extractDetails();

          if (info.noAntrian || info.ref) {
            const message = this.formatSuccessMessage(info);
            return { ok: true, info, message, source: "UI" };
          }

          // Success muncul tapi data belum lengkap
          const elapsed = Date.now() - start;
          if (elapsed < timeoutMs - 1500) {
            await log.add(item, "INFO", "⏳ Menunggu data lengkap...");
            await sleep(800);
            continue;
          }
        }

        // Fallback API setelah 3 detik
        const elapsed = Date.now() - start;
        if (!fallbackTriggered && elapsed >= CFG.FALLBACK_TIMEOUT_MS) {
          fallbackTriggered = true;
          await log.add(item, "INFO", "⚡ 3 detik timeout → Trigger API fallback");
          const apiResult = await this.checkViaAPI(item, formData);
          if (apiResult.ok) {
            return apiResult;
          }
          await log.add(item, "INFO", "⏳ API fallback gagal, lanjut tunggu UI...");
        }

        // Deteksi error dari UI
        const bodyText = document.body.innerText || "";
        if (
          /error|gagal|failed|tidak\s+valid|terjadi\s+kesalahan/i.test(bodyText) &&
          !/Pendaftaran.*Berhasil/i.test(bodyText)
        ) {
          return {
            ok: false,
            reason: "Terdeteksi error dari server",
            errorText: bodyText.substring(0, 200),
          };
        }

        await sleep(400);
      }

      // Final attempt via API jika belum pernah
      if (!fallbackTriggered && formData) {
        await log.add(item, "INFO", "🔄 Final check via API dengan form data...");
        const apiResult = await this.checkViaAPI(item, formData);
        if (apiResult.ok) return apiResult;
      }

      return {
        ok: false,
        reason: `TIMEOUT - Tidak ada response valid (UI & API) dalam ${Math.round(
          timeoutMs / 1000
        )} detik`,
      };
    },
  };

  const log = {
    async add(item, status, msg, forceScreenshot = false) {
      try {
        const state = await store.get(CFG.KEY_STATE, {});
        const alwaysScreenshot = !!state.alwaysScreenshot;

        const entry = {
          time: timestamp(),
          url: item?.url || app.targetUrl,
          name: item?.name || "-",
          ktp: item?.ktp || "-",
          phone: item?.phone || "-",
          status,
          message: msg,
          screenshot: null,
        };

        if (forceScreenshot || status === "OK" || status === "ERROR" || alwaysScreenshot) {
          const ss = await screenshot();
          if (ss) entry.screenshot = ss;
        }

        const logs = await store.get(CFG.KEY_LOGS, []);
        logs.push(entry);
        // Trim logs jika melebihi MAX_LOGS
        if (logs.length > CFG.MAX_LOGS) {
          logs.splice(0, logs.length - CFG.MAX_LOGS);
        }
        await store.set({ [CFG.KEY_LOGS]: logs });

        ui.appendLog(entry);
        ui.updateStats();
      } catch (err) {
        console.error("Log add error:", err);
      }
    },

    async download() {
      try {
        const logs = await store.get(CFG.KEY_LOGS, []);
        if (!logs.length) return alert("Belum ada log");

        const headers = ["time", "url", "name", "ktp", "phone", "status", "message"];
        const csv = [headers.join(",")]
          .concat(
            logs.map((r) =>
              headers
                .map((k) => `"${(r[k] || "").toString().replace(/"/g, '""')}"`)
                .join(",")
            )
          )
          .join("\n");

        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `autosign_log_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) {
        alert("Error downloading log");
      }
    },

    async clear() {
      try {
        if (!confirm("Hapus semua log?")) return;
        await store.set({ [CFG.KEY_LOGS]: [] });
        document.getElementById("log_box").innerHTML = "";
        ui.updateStats();
        await this.add(null, "INFO", "🗑️ Log dibersihkan");
      } catch (err) {
        console.error("Clear error:", err);
      }
    },
  };

  const processor = {
    async processOne(item, retries) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          if (!location.href.startsWith(app.targetUrl)) {
            await log.add(item, "INFO", `🔄 Navigasi ke ${app.targetUrl}`);
            location.href = app.targetUrl;
            await sleep(2000);
            return false;
          }

          await log.add(item, "INFO", `⏳ Menunggu form (${attempt}/${retries})...`);
          const els = await formBot.waitForForm();
          if (!els) throw new Error("Proses dihentikan");

          await log.add(item, "INFO", `📝 Mengisi data: ${item.name}`);

          const fields = [
            { el: els.name, val: item.name, label: "Nama" },
            { el: els.ktp, val: item.ktp, label: "KTP" },
            { el: els.phone, val: item.phone, label: "Telepon" },
          ].sort(() => Math.random() - 0.5);

          for (const f of fields) {
            await log.add(item, "INFO", `✍️ ${f.label}...`);
            await formBot.typeValue(f.el, f.val);
            await sleep(300 + Math.random() * 500);
          }

          if (els.captchaBox?.textContent?.trim() && els.captchaInput) {
            const captchaText = els.captchaBox.textContent.trim();
            await log.add(item, "INFO", `🔤 CAPTCHA: ${captchaText}`);
            await formBot.typeValue(els.captchaInput, captchaText);
          }

          if (els.check1 && Math.random() > 0.3) {
            els.check1.checked = true;
            els.check1.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (els.check2 && Math.random() > 0.3) {
            els.check2.checked = true;
            els.check2.dispatchEvent(new Event("change", { bubbles: true }));
          }

          if (els.form) {
            await formBot.handleRecaptchaV3(els.form);
          }

          // INTERCEPT: Capture form data sebelum submit
          await log.add(item, "INFO", "📦 Intercept form data...");
          const interceptedData = formBot.captureFormData(els, item);

          await log.add(item, "INFO", "📤 Mengirim form...");
          await formBot.humanClick(els.submit);
          await sleep(1200);

          await log.add(item, "INFO", "⏳ Validasi response server...");
          const result = await detector.waitSuccess(item, interceptedData);

          if (result.ok) {
            const successMsg = result.source === "API" ? `${result.message} [via API]` : result.message;
            await log.add(item, "OK", successMsg, true);
            return true;
          } else {
            const failMsg = `❌ ${result.reason}${
              result.errorText ? " - " + result.errorText.substring(0, 100) : ""
            }`;
            throw new Error(failMsg);
          }
        } catch (err) {
          const isLast = attempt === retries;
          const errorMsg = `❌ Attempt ${attempt}/${retries}: ${err.message}`;

          await log.add(item, "ERROR", errorMsg, true);

          if (!isLast) {
            const delay = CFG.RETRY_DELAY_BASE_MS * Math.pow(1.5, attempt - 1);
            await log.add(item, "INFO", `🔄 Retry ${Math.round(delay / 1000)}s...`);
            await sleep(delay);
            continue;
          }

          return false;
        }
      }
    },
  };

  const app = {
    stopFlag: false,
    targetUrl: CFG.DEFAULT_URL,
    queue: [],
    scheduleTimer: null,
    nextRunTime: null,

    async start() {
      try {
        const state = await store.get(CFG.KEY_STATE, {});
        const csvText = state.lastCSV;
        if (!csvText) return alert("Upload CSV dulu!");

        this.targetUrl = state.targetUrl || CFG.DEFAULT_URL;

        if (!location.href.startsWith(this.targetUrl)) {
          await notify("AutoSign", "Membuka halaman target...");
          state.lastRun = Date.now();
          await store.set({ [CFG.KEY_STATE]: state });
          location.href = this.targetUrl;
          return;
        }

        this.stopFlag = false;

        // Parse CSV, hapus header dan baris kosong
        const rawData = csvText
          .split(/\r?\n/)
          .map((r) => r.trim())
          .filter(Boolean)
          .filter((r) => !/^name|nama/i.test(r));

        // Map -> objek
        const mapped = rawData
          .map((r) => {
            const [name, ktp, phone] = r.split(",").map((x) => (x || "").trim());
            return { name, ktp, phone, url: this.targetUrl };
          })
          .filter((r) => r.name && r.ktp && r.phone);

        // Dedup berdasarkan KTP
        const dedupMap = new Map();
        mapped.forEach((x) => {
          if (!dedupMap.has(x.ktp)) dedupMap.set(x.ktp, x);
        });
        const data = Array.from(dedupMap.values());

        if (!data.length) return alert("Tidak ada data valid di CSV!");

        this.queue = [...data];
        const parallel = Math.min(
          parseInt(document.getElementById("parallel")?.value || CFG.DEFAULT_PARALLEL),
          2
        );
        const retries = parseInt(document.getElementById("retry")?.value || CFG.DEFAULT_RETRY);

        ui.updateProgress(0, data.length);
        let completed = 0;

        await log.add(
          {},
          "INFO",
          `🚀 Start v${CFG.VERSION}: ${data.length} task, ${parallel} worker, ${retries} retry`
        );

        const workerPromises = [];
        for (let i = 0; i < Math.min(parallel, data.length); i++) {
          workerPromises.push(
            (async (workerNum) => {
              while (this.queue.length && !this.stopFlag) {
                const item = this.queue.shift();
                if (!item) break;

                await log.add(item, "INFO", `👷 Worker ${workerNum + 1}`);
                await processor.processOne(item, retries);
                completed++;
                ui.updateProgress(completed, data.length);

                const delay = 1000 + Math.random() * 2000;
                await log.add(item, "INFO", `⏸️ Cooldown ${Math.round(delay / 1000)}s`);
                await sleep(delay);
              }
            })(i)
          );
        }

        await Promise.all(workerPromises);

        const logs = await store.get(CFG.KEY_LOGS, []);
        const ok = logs.filter((r) => r.status === "OK").length;
        const err = logs.filter((r) => r.status === "ERROR").length;

        await log.add({}, "INFO", `🏁 Selesai: ${ok} OK, ${err} GAGAL`);
        await notify("AutoSign", `Selesai: ${ok} OK, ${err} GAGAL`);

        const st = await store.get(CFG.KEY_STATE, {});
        delete st.lastRun;
        await store.set({ [CFG.KEY_STATE]: st });
      } catch (err) {
        await log.add({}, "ERROR", `❌ Error: ${err.message}`);
      }
    },

    stop() {
      this.stopFlag = true;
      notify("AutoSign", "Proses dihentikan");
      log.add({}, "INFO", "⏹️ Dihentikan");
    },

    setSchedule(timeStr) {
      try {
        if (this.scheduleTimer) clearTimeout(this.scheduleTimer);

        this.nextRunTime = new Date();
        const [hh, mm, ss] = timeStr.split(":").map(Number);
        this.nextRunTime.setHours(hh || 0, mm || 0, ss || 0, 0);

        if (this.nextRunTime < new Date()) {
          this.nextRunTime.setDate(this.nextRunTime.getDate() + 1);
        }

        const ms = this.nextRunTime - new Date();
        this.scheduleTimer = setTimeout(() => {
          this.start();
          this.setSchedule(timeStr);
        }, ms);

        log.add({}, "INFO", `⏰ Schedule: ${timeStr} (${this.nextRunTime.toLocaleString("id-ID")})`);
      } catch (err) {
        console.error("Schedule error:", err);
      }
    },
  };

  // UI WITH SCREENSHOT MODAL PREVIEW
  const ui = {
    init() {
      if (document.getElementById("autosign_panel")) return;

      const style = document.createElement("style");
      style.textContent = `
        #autosign_panel{position:fixed;bottom:20px;right:20px;width:480px;background:#fff;
        border-radius:12px;padding:16px;z-index:2147483647;font-family:system-ui;
        box-shadow:0 8px 32px rgba(0,0,0,0.25);border:1px solid #ddd;max-height:90vh;overflow:hidden;}
        #autosign_panel h3{margin:0 0 12px;font-size:16px;display:flex;justify-content:space-between;font-weight:600;}
        #autosign_panel input,button{margin:4px;padding:8px;font-size:13px;border-radius:6px;border:1px solid #ddd;}
        #autosign_panel button{background:#2563eb;color:#fff;border:none;cursor:pointer;font-weight:500;}
        #autosign_panel button:hover{background:#1d4ed8;}
        #log_box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
        height:250px;overflow-y:auto;padding:8px;margin:12px 0;font-size:11px;font-family:monospace;line-height:1.4;}
        .log-OK{color:#16a34a;font-weight:600;}
        .log-ERROR{color:#dc2626;font-weight:600;}
        .log-INFO{color:#64748b;}
        .log-WARN{color:#f59e0b;font-weight:600;}
        #progress_bar{height:8px;background:#e5e7eb;border-radius:4px;margin:8px 0;}
        #progress_fill{height:100%;background:#16a34a;border-radius:4px;width:0%;transition:width 0.3s;}
        .stats{display:flex;gap:8px;margin:8px 0;flex-wrap:wrap;}
        .stats .pill{background:#f1f5f9;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:600;}
        .csv-ok{color:#16a34a;} .csv-missing{color:#dc2626;}
        .log-screenshot{width:70px;height:45px;object-fit:cover;margin-left:8px;cursor:pointer;
        border-radius:4px;vertical-align:middle;border:2px solid #e5e7eb;transition:all 0.2s;}
        .log-screenshot:hover{border-color:#2563eb;transform:scale(1.08);box-shadow:0 4px 8px rgba(0,0,0,0.15);}
        #screenshot_modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;
        background:rgba(0,0,0,0.92);z-index:2147483648;align-items:center;justify-content:center;cursor:zoom-out;}
        #screenshot_modal img{max-width:95%;max-height:95%;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.5);}
        #screenshot_modal.active{display:flex;}
        .muted{color:#6b7280;}
      `;
      document.head.appendChild(style);

      const panel = document.createElement("div");
      panel.id = "autosign_panel";
      panel.innerHTML = `
        <h3>🤖 AutoSign Enhanced v${CFG.VERSION} <span id="clock" style="font-weight:400;font-size:14px;">--:--:--</span></h3>
        <input id="target_url" placeholder="Target URL" value="${CFG.DEFAULT_URL}" style="width:90%;font-size:12px;">
        <div style="margin:8px 0;">
          <label style="font-size:13px;">📁 CSV: <input id="csv_file" type="file" accept=".csv" style="font-size:12px;"></label>
          <span id="csv_status" class="csv-missing" style="font-size:12px;">❌ Belum upload</span>
        </div>
        <div style="margin:8px 0;">
          <input id="api_check_url" placeholder="🌐 API Fallback URL (optional)" style="width:90%;font-size:12px;" title="API untuk cek status jika UI tidak response dalam 3 detik">
        </div>
        <div style="display:flex;gap:8px;margin:8px 0;">
          <label style="font-size:13px;">⚡ Parallel: <input id="parallel" type="number" value="2" min="1" max="2" style="width:60px;"></label>
          <label style="font-size:13px;">🔁 Retry: <input id="retry" type="number" value="${CFG.DEFAULT_RETRY}" style="width:60px;"></label>
        </div>
        <div style="display:flex;gap:8px;margin:8px 0;align-items:center;">
          <label style="font-size:13px;">📸 Always Screenshot <input id="always_ss" type="checkbox" /></label>
          <span class="muted" style="font-size:12px;">(Semua log akan ada preview)</span>
        </div>
        <div style="display:flex;gap:4px;margin:8px 0;align-items:center;">
          <label style="font-size:13px;">⏰ Schedule: <input id="schedule" type="time" step="1" value="${CFG.DEFAULT_SCHEDULE}" style="width:100px;"></label>
          <button id="btn_sched" style="padding:8px 12px;">Set</button>
        </div>
        <div style="display:flex;gap:4px;margin:8px 0;flex-wrap:wrap;">
          <button id="btn_start" style="background:#16a34a;">▶ Start</button>
          <button id="btn_stop" style="background:#dc2626;">⏹ Stop</button>
          <button id="btn_download" style="background:#0891b2;">📥 Log</button>
          <button id="btn_clear" style="background:#f59e0b;">🗑 Clear</button>
        </div>
        <div id="progress_bar"><div id="progress_fill"></div></div>
        <small id="progress_text" style="font-size:11px;color:#64748b;">0/0 selesai (0%)</small>
        <div class="stats">
          <div class="pill">✅ OK: <span id="stat_ok">0</span></div>
          <div class="pill">❌ ERR: <span id="stat_err">0</span></div>
          <div class="pill">📊 Total: <span id="stat_total">0</span></div>
        </div>
        <div id="log_box"></div>
      `;
      document.body.appendChild(panel);

      // Screenshot Modal
      const modal = document.createElement("div");
      modal.id = "screenshot_modal";
      modal.innerHTML = `<img id="screenshot_img" src="" alt="Screenshot">`;
      modal.onclick = () => modal.classList.remove("active");
      document.body.appendChild(modal);

      this.bindEvents();
      this.startClock();
      this.loadState();
    },

    startClock() {
      setInterval(() => {
        const c = document.getElementById("clock");
        if (c)
          c.textContent = new Date().toLocaleTimeString("id-ID", {
            hour12: false,
          });
      }, 1000);
    },

    bindEvents() {
      document.getElementById("csv_file").onchange = async (e) => {
        try {
          const file = e.target.files[0];
          if (!file) return;

          const text = await file.text();
          const state = await store.get(CFG.KEY_STATE, {});
          state.lastCSV = text;
          state.lastCSVName = file.name;
          await store.set({ [CFG.KEY_STATE]: state });

          document.getElementById("csv_status").innerHTML = `<span class="csv-ok">✅ ${file.name}</span>`;
          log.add({}, "INFO", `📁 CSV loaded: ${file.name}`);
        } catch (err) {
          console.error("CSV load error:", err);
        }
      };

      document.getElementById("btn_start").onclick = () => app.start();
      document.getElementById("btn_stop").onclick = () => app.stop();
      document.getElementById("btn_download").onclick = () => log.download();
      document.getElementById("btn_clear").onclick = () => log.clear();

      document.getElementById("btn_sched").onclick = async () => {
        try {
          const time = document.getElementById("schedule").value.trim();
          if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return alert("Format: HH:MM:SS");

          const timeStr = time.length === 5 ? time + ":00" : time;
          const state = await store.get(CFG.KEY_STATE, {});
          state.schedule = timeStr;
          await store.set({ [CFG.KEY_STATE]: state });
          app.setSchedule(timeStr);
        } catch (err) {
          console.error("Schedule set error:", err);
        }
      };

      document.getElementById("target_url").onchange = async () => {
        try {
          const url = document.getElementById("target_url").value.trim();
          const state = await store.get(CFG.KEY_STATE, {});
          state.targetUrl = url;
          await store.set({ [CFG.KEY_STATE]: state });
          log.add({}, "INFO", `🌐 Target URL: ${url}`);
        } catch (err) {
          console.error("URL change error:", err);
        }
      };

      document.getElementById("api_check_url").onchange = async () => {
        try {
          const apiUrl = document.getElementById("api_check_url").value.trim();
          const state = await store.get(CFG.KEY_STATE, {});
          state.apiCheckUrl = apiUrl;
          await store.set({ [CFG.KEY_STATE]: state });
          if (apiUrl) {
            log.add({}, "INFO", `🌐 API Fallback: ${apiUrl}`);
          }
        } catch (err) {
          console.error("API URL change error:", err);
        }
      };

      document.getElementById("always_ss").onchange = async (e) => {
        try {
          const state = await store.get(CFG.KEY_STATE, {});
          state.alwaysScreenshot = !!e.target.checked;
          await store.set({ [CFG.KEY_STATE]: state });
          log.add({}, "INFO", `📸 Always Screenshot: ${state.alwaysScreenshot ? "ON" : "OFF"}`);
        } catch (err) {
          console.error("Always SS error:", err);
        }
      };
    },

    appendLog(entry) {
      try {
        const box = document.getElementById("log_box");
        if (!box) return;

        const div = document.createElement("div");
        div.className = `log-${entry.status}`;
        div.style.cssText = "margin:2px 0;line-height:1.5;display:flex;align-items:center;gap:6px;";

        const time = entry.time.split(", ")[1] || entry.time;
        let msg = `[${time}] `;
        if (entry.ktp && entry.ktp !== "-") msg += `${entry.ktp} `;
        if (entry.name && entry.name !== "-") msg += `- ${entry.name} `;
        msg += `: ${entry.message}`;

        const span = document.createElement("span");
        span.textContent = msg.trim();

        div.appendChild(span);

        if (entry.screenshot) {
          const img = document.createElement("img");
          img.src = entry.screenshot;
          img.className = "log-screenshot";
          img.title = "Klik untuk memperbesar screenshot";
          img.onclick = (e) => {
            e.stopPropagation();
            const modal = document.getElementById("screenshot_modal");
            const modalImg = document.getElementById("screenshot_img");
            modalImg.src = entry.screenshot;
            modal.classList.add("active");
          };
          div.appendChild(img);
        }

        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      } catch (err) {
        console.error("Append log error:", err);
      }
    },

    updateProgress(done, total) {
      try {
        const pct = total ? Math.round((done / total) * 100) : 0;
        document.getElementById("progress_fill").style.width = `${pct}%`;
        document.getElementById("progress_text").textContent = `${done}/${total} selesai (${pct}%)`;
      } catch (err) {
        console.error("Update progress error:", err);
      }
    },

    async updateStats() {
      try {
        const logs = await store.get(CFG.KEY_LOGS, []);
        const ok = logs.filter((r) => r.status === "OK").length;
        const err = logs.filter((r) => r.status === "ERROR").length;
        document.getElementById("stat_ok").textContent = ok;
        document.getElementById("stat_err").textContent = err;
        document.getElementById("stat_total").textContent = logs.length;
      } catch (err) {
        console.error("Update stats error:", err);
      }
    },

    async loadState() {
      try {
        const state = await store.get(CFG.KEY_STATE, {});

        if (state.lastCSVName) {
          document.getElementById("csv_status").innerHTML = `<span class="csv-ok">✅ ${state.lastCSVName}</span>`;
        }

        if (state.targetUrl) {
          document.getElementById("target_url").value = state.targetUrl;
          app.targetUrl = state.targetUrl;
        }

        if (state.apiCheckUrl) {
          document.getElementById("api_check_url").value = state.apiCheckUrl;
        }

        if (state.schedule) {
          document.getElementById("schedule").value = state.schedule;
          app.setSchedule(state.schedule);
        }

        if (state.alwaysScreenshot) {
          const cb = document.getElementById("always_ss");
          if (cb) cb.checked = !!state.alwaysScreenshot;
        }

        await this.updateStats();
      } catch (err) {
        console.error("Load state error:", err);
      }
    },
  };

  // AUTO-RESUME
  window.addEventListener("load", async () => {
    try {
      ui.init();

      const state = await store.get(CFG.KEY_STATE, {});

      // Auto-resume jika baru reload dalam 10 menit
      if (state.lastRun && Date.now() - state.lastRun < 10 * 60 * 1000) {
        await log.add({}, "INFO", "🔄 Auto-resume setelah reload...");
        await sleep(2000);
        await app.start();
      } else {
        await log.add({}, "INFO", "✅ AutoSign Enhanced ready!");
      }
    } catch (err) {
      console.error("Init error:", err);
    }
  });
})();