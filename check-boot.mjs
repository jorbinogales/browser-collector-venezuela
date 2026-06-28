import { chromium } from "playwright";
const out = process.argv[2] || "boot.png";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 820 } });
const page = await ctx.newPage();
// bloquear Babel para que React no monte y la pantalla de carga quede visible
await page.route("**/*", (route) => {
  const u = route.request().url();
  if (u.includes("babel")) return route.abort();
  return route.continue();
});
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const b = document.getElementById("boot");
  if (!b) return { present: false };
  return { present: true, hasFlag: !!b.querySelector(".vz-flag"), stars: b.querySelectorAll("#vzstar, use").length, text: b.innerText.replace(/\s+/g, " ").trim() };
});
console.log(JSON.stringify(info, null, 0));
await page.screenshot({ path: out });
console.log("screenshot:", out);
await browser.close();
