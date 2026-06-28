// Inspecciona la paginación del loader _index y prueba cargar la página 2.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "es-VE",
});
const page = await ctx.newPage();

async function loaderShallow(url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);
  return await page.evaluate(() => {
    const ld =
      window.__reactRouterContext?.state?.loaderData?.["routes/_index"];
    if (!ld) return { err: "no _index loaderData" };
    const shallow = {};
    for (const [k, v] of Object.entries(ld)) {
      if (Array.isArray(v))
        shallow[k] = `[array len ${v.length}${v[0]?.firstName ? ` first=${v[0].firstName}` : ""}]`;
      else shallow[k] = v;
    }
    return shallow;
  });
}

console.log("== home (/) ==");
const a = await loaderShallow("https://venezuelatebusca.com/");
console.log(JSON.stringify(a, null, 2));

// probar parámetros de paginación comunes
for (const qs of ["?page=2", "?cursor=2", "?skip=20", "?offset=20", "?p=2"]) {
  console.log(`\n== ${qs} ==`);
  const r = await loaderShallow("https://venezuelatebusca.com/" + qs);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(r).filter(
          ([k]) => k === "persons" || /cursor|total|page|count|more|next/i.test(k),
        ),
      ),
    ),
  );
}

await browser.close();
