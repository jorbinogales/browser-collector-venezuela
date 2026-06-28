// Prueba de factibilidad para venezuelatebusca.com: ¿qué datos públicos sirve el
// navegador y por qué vía (loader server-side embebido vs fetch del cliente)?
import { chromium } from "playwright";

const captured = [];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "es-VE",
});
const page = await ctx.newPage();

page.on("response", async (resp) => {
  const url = resp.url();
  if (!url.includes("venezuelatebusca.com")) return;
  const ct = resp.headers()["content-type"] || "";
  if (!ct.includes("json")) return;
  let len = 0,
    sample = "";
  try {
    const t = await resp.text();
    len = t.length;
    sample = t.slice(0, 300);
  } catch {
    /* */
  }
  console.log(`[json] ${resp.status()} (len ${len}) ${url}`);
  if (len > 0) captured.push({ url, status: resp.status(), len, sample });
});

async function visit(path) {
  console.log(`\n#### visitando ${path} ####`);
  try {
    await page.goto("https://venezuelatebusca.com" + path, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => {
      const txt = document.body.innerText.replace(/\s+/g, " ").slice(0, 500);
      // Remix/React Router embeben datos de loader en el HTML
      const hasRemix =
        !!window.__remixContext || !!window.__reactRouterContext;
      const links = [...document.querySelectorAll("a[href^='/']")]
        .map((a) => a.getAttribute("href"))
        .filter((h, i, arr) => arr.indexOf(h) === i)
        .slice(0, 15);
      return { txt, hasRemix, links };
    });
    console.log("  hasHydrationData:", info.hasRemix);
    console.log("  links:", info.links.join(" | "));
    console.log("  texto:", info.txt);
  } catch (e) {
    console.log("  error:", e.message);
  }
}

await visit("/");
await visit("/resources");
await visit("/buscar");

console.log(`\n==== ${captured.length} respuestas JSON capturadas ====`);
for (const c of captured)
  console.log(`${c.status} (len ${c.len}) ${c.url}\n   ${c.sample}`);

await browser.close();
