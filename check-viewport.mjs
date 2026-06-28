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

const count1 = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
console.log("markers iniciales (viewport Caracas):", count1, "(antes eran 1180)");

// alejar el zoom -> deben aparecer MÁS puntos (carga dinámica), pero con tope
const canvas = await page.$(".mapboxgl-canvas");
const box = await canvas.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(250); }
await page.waitForTimeout(1800);
const count2 = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
console.log("markers tras alejar MUCHO el zoom (vista mundial):", count2, "(debe subir hacia el tope ~250, y << 1180)");

// acercar de nuevo -> deben bajar
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(300); }
await page.waitForTimeout(1500);
const count3 = await page.evaluate(() => document.querySelectorAll(".sm-marker").length);
console.log("markers tras acercar de nuevo:", count3);

// interacción sigue funcionando (hover + click en un punto del bucket si hay alguno visible)
const inter = await page.evaluate(() => {
  const labels = ["Daño estructural", "Centro de acopio", "Refugio"];
  const ms = [...document.querySelectorAll(".sm-marker")];
  const t = ms.find(m => labels.some(l => (m.getAttribute("aria-label") || "").startsWith(l)));
  if (!t) return { found: false };
  t.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  const tip = document.querySelector(".mapboxgl-popup.mapa-tip");
  const tipTxt = tip ? tip.innerText.replace(/\s+/g, " ").trim().slice(0, 70) : "";
  t.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return { found: true, tipTxt };
});
await page.waitForTimeout(700);
const modalHas = await page.evaluate(() => { const m = document.querySelector(".chakra-modal__content, [role=dialog]"); return m ? /Cómo llegar/.test(m.innerText) : false; });
console.log("interacción:", JSON.stringify(inter), "| modal con 'Cómo llegar':", modalHas);
console.log("errores:", errors.length ? errors.join("\n") : "(ninguno)");
await browser.close();
