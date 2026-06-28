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
const domMarkers = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
// ¿los markers traen ícono SVG?
const markerHasSvg = await page.evaluate(() => { const m = document.querySelector(".sm-marker"); return !!(m && m.querySelector("svg")); });
console.log("sm-marker (con ícono):", domMarkers, "| primer marker tiene svg:", markerHasSvg);

// disparar mouseenter por JS sobre cada marker hasta que aparezca el tooltip pill (.mapa-tip)
const r = await page.evaluate(() => {
  const ms = document.querySelectorAll(".sm-marker");
  for (let i = 0; i < ms.length; i++) {
    ms[i].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const tip = document.querySelector(".mapboxgl-popup.mapa-tip");
    if (tip) {
      const c = document.querySelector(".mapa-tip .mapboxgl-popup-content");
      const bg = c ? getComputedStyle(c).backgroundColor : "";
      return { i, text: tip.innerText.replace(/\s+/g, " ").slice(0, 80), icon: !!tip.querySelector("svg"), noChrome: bg === "rgba(0, 0, 0, 0)" || bg === "transparent" };
    }
    ms[i].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  }
  return null;
});
console.log("tooltip pill en hover:", !!r, "| icono:", r && r.icon, "| sin marco blanco:", r && r.noChrome, "| markerIdx:", r && r.i);
console.log("texto tooltip:", r ? r.text : "");

// no debe haber popups permanentes antes de interactuar (se removió el hover al final)
await page.mouse.move(5, 5); await page.waitForTimeout(400);
const tipsAfterLeave = await page.evaluate(() => document.querySelectorAll(".mapboxgl-popup.mapa-tip").length);
console.log("tooltips visibles tras alejar el mouse:", tipsAfterLeave, "(debe ser 0)");
console.log("errores:", errors.length ? errors.join("\n") : "(ninguno)");
await browser.close();
