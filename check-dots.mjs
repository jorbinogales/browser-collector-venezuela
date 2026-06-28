import { chromium } from "playwright";
const url = process.argv[2] || "http://localhost:3000/";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ geolocation: { latitude: 10.6, longitude: -66.9 }, permissions: ["geolocation"], viewport: { width: 390, height: 820 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message.slice(0, 200)));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(8000);
const appOk = await page.evaluate(() => document.body.innerText.includes("ZonaSegura"));
const domMarkers = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
console.log("app:", appOk, "| sm-marker DOM:", domMarkers, "(los puntos del bucket ya NO son DOM; serán capa)");
const canvas = await page.$(".mapboxgl-canvas");
let hoverPopup = false, popupText = "";
if (canvas) {
  const box = await canvas.boundingBox();
  // alejar el zoom para ver los dots dispersos
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(250); }
  await page.waitForTimeout(1500);
  outer: for (let gx = 0.15; gx <= 0.85; gx += 0.05) {
    for (let gy = 0.2; gy <= 0.8; gy += 0.05) {
      await page.mouse.click(box.x + box.width * gx, box.y + box.height * gy);
      await page.waitForTimeout(70);
      const pop = await page.$(".mapboxgl-popup");
      if (pop) { hoverPopup = true; popupText = (await pop.innerText()).replace(/\s+/g, " ").slice(0, 120); break outer; }
    }
  }
}
console.log("popup en hover:", hoverPopup, "| texto:", popupText);
console.log("errores:", errors.length ? errors.join("\n") : "(ninguno)");
await browser.close();
