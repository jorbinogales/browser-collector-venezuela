// Prueba 2: ¿podemos paginar minteando un token reCAPTCHA por request desde el navegador?
import { chromium } from "playwright";

const SITEKEY = "6LeBfDUtAAAAAMw1Wtkd58bst6vEnLOi3_NAjGD0";
const API = "https://desaparecidos-terremoto-api.theempire.tech/api/personas";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "es-VE",
});
const page = await ctx.newPage();
await page.goto("https://desaparecidosterremotovenezuela.com/", {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page
  .waitForFunction(() => window.grecaptcha && window.grecaptcha.execute, {
    timeout: 20000,
  })
  .catch(() => console.log("grecaptcha no listo"));

const result = await page.evaluate(
  async ({ sitekey, api }) => {
    const get = async (pageNum, pageSize, action) => {
      const token = await window.grecaptcha.execute(sitekey, { action });
      const r = await fetch(`${api}?page=${pageNum}&pageSize=${pageSize}`, {
        headers: { "x-recaptcha-token": token, accept: "application/json" },
      });
      const txt = await r.text();
      let count = null;
      try {
        count = (JSON.parse(txt).items || []).length;
      } catch {
        /* no json */
      }
      return { status: r.status, len: txt.length, count, sample: txt.slice(0, 120) };
    };
    const out = {};
    for (const action of ["submit", "list", "personas", "load"]) {
      try {
        out[`p2_ps100_${action}`] = await get(2, 100, action);
      } catch (e) {
        out[`p2_ps100_${action}`] = { error: String(e) };
      }
    }
    // probar pageSize muy grande
    try {
      out["p1_ps500"] = await get(1, 500, "submit");
    } catch (e) {
      out["p1_ps500"] = { error: String(e) };
    }
    return out;
  },
  { sitekey: SITEKEY, api: API },
);

console.log(JSON.stringify(result, null, 2));
await browser.close();
