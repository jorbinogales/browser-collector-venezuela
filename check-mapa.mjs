import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  geolocation: { latitude: 10.6, longitude: -66.9 },
  permissions: ["geolocation"],
  viewport: { width: 390, height: 820 },
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message.slice(0, 200)));

await page.goto("http://localhost:3000/", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(8000); // mapa + fetch /mapa-puntos + render markers

const appOk = await page.evaluate(() => document.body.innerText.includes("ZonaSegura"));
const markers = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
console.log("app renderizada:", appOk);
console.log("markers en el mapa (.sm-marker):", markers);

// click en un marker para ver si abre la card de detalle
let cardOpened = false;
try {
  const m = await page.$(".sm-marker");
  if (m) { await m.click({ timeout: 3000 }); await page.waitForTimeout(1200);
    cardOpened = await page.evaluate(() => /Cómo llegar|Suministro|Refugio|Daño|Distancia|km|m\b/.test(document.body.innerText)); }
} catch {}
console.log("card de detalle al hacer click:", cardOpened);

console.log("\n== errores ==");
console.log(errors.length ? errors.join("\n") : "(ninguno)");
await browser.close();
