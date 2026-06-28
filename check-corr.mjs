import { chromium } from "playwright";
const url = process.argv[2] || "http://localhost:3000/";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ geolocation: { latitude: 10.6, longitude: -66.9 }, permissions: ["geolocation"], viewport: { width: 390, height: 820 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message.slice(0, 200)));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(9000);

const markers = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
// (1) no debe haber tooltips/cards abiertos sin interactuar
const openTips = await page.evaluate(() => document.querySelectorAll(".mapboxgl-popup").length);
console.log("(1) markers:", markers, "| popups abiertos sin interactuar:", openTips, "(debe ser 0)");

// (2) hover -> tooltip con TIPO + titulo
const tip = await page.evaluate(() => {
  const ms = document.querySelectorAll(".sm-marker");
  for (let i = 0; i < ms.length; i++) {
    ms[i].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const t = document.querySelector(".mapboxgl-popup.mapa-tip");
    if (t) { const r = { txt: t.innerText.replace(/\s+/g, " ").trim().slice(0, 90), icon: !!t.querySelector("svg") }; ms[i].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true })); return r; }
    ms[i].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  }
  return null;
});
console.log("(2) tooltip hover:", tip ? `"${tip.txt}" (icono:${tip.icon})` : "NO");

// (3) click en icono del bucket -> modal con "Cómo llegar"
const clickRes = await page.evaluate(() => {
  const labels = ["Daño estructural", "Centro de acopio", "Refugio"];
  const ms = [...document.querySelectorAll(".sm-marker")];
  const target = ms.find(m => { const a = m.getAttribute("aria-label") || ""; return labels.some(l => a.startsWith(l)); });
  if (!target) return { found: false };
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return { found: true, aria: target.getAttribute("aria-label").slice(0, 60) };
});
await page.waitForTimeout(900);
const modalText = await page.evaluate(() => { const m = document.querySelector(".chakra-modal__content, [role=dialog]"); return m ? m.innerText.replace(/\s+/g, " ").slice(0, 220) : "(sin modal)"; });
console.log("(3) click:", JSON.stringify(clickRes));
console.log("    modal:", modalText);
console.log("    tiene 'Cómo llegar':", /Cómo llegar/.test(modalText));

console.log("errores:", errors.length ? errors.join("\n") : "(ninguno)");
await browser.close();
