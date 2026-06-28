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

await page.goto("https://zonasegura.up.railway.app/", { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(5000); // Babel compile + React render

const appRendered = await page.evaluate(() => document.body.innerText.includes("ZonaSegura"));
const tabExists = (await page.getByRole("tab", { name: "Desaparecidos" }).count()) > 0;
console.log("app renderizada (ZonaSegura):", appRendered);
console.log("tab Desaparecidos existe:", tabExists);

let itemsText = "", imgCount = 0;
if (tabExists) {
  await page.getByRole("tab", { name: "Desaparecidos" }).first().click();
  await page.waitForTimeout(3500); // fetch + render lista
  itemsText = await page.evaluate(() => {
    const all = document.body.innerText;
    const i = all.indexOf("Desaparecidos");
    return all.slice(i, i + 300).replace(/\s+/g, " ");
  });
  imgCount = await page.evaluate(() =>
    [...document.querySelectorAll("img")].filter((im) => /supabase|venezuelatebusca|amazonaws/.test(im.src)).length);
}
console.log("texto vista:", itemsText);
console.log("fotos de desaparecidos cargadas:", imgCount);

console.log("\n== errores de consola/página ==");
console.log(errors.length ? errors.join("\n") : "(ninguno)");
await browser.close();
