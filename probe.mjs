// Prueba de factibilidad: ¿podemos leer los datos públicos de dtv con un navegador real?
import { chromium } from "playwright";

const captured = [];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
  locale: "es-VE",
});
const page = await ctx.newPage();

page.on("response", async (resp) => {
  const url = resp.url();
  if (!/theempire\.tech|\/api\//.test(url)) return;
  const status = resp.status();
  let len = 0;
  let sample = "";
  try {
    const ct = resp.headers()["content-type"] || "";
    if (ct.includes("json")) {
      const txt = await resp.text();
      len = txt.length;
      sample = txt.slice(0, 1500);
    }
  } catch {
    /* body no disponible */
  }
  console.log(`[resp] ${status} (len ${len}) ${url}`);
  if (len > 0) captured.push({ url, status, len, sample });
});

console.log("navegando a dtv...");
await page
  .goto("https://desaparecidosterremotovenezuela.com/", {
    waitUntil: "networkidle",
    timeout: 60000,
  })
  .catch((e) => console.log("goto:", e.message));

await page.waitForTimeout(8000); // dar tiempo a recaptcha + fetch de datos

const domText = await page.evaluate(() =>
  document.body.innerText.replace(/\s+/g, " ").slice(0, 1200),
);
console.log("\n==== DOM innerText (1200) ====\n" + domText);

console.log(`\n==== ${captured.length} respuestas JSON capturadas ====`);
for (const c of captured) {
  console.log(`\n--- ${c.status} ${c.url} (len ${c.len}) ---`);
  console.log(c.sample);
}

await browser.close();
