// Busca el array de personas embebido en la hidratación de la página pública de vtb.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "es-VE",
});
const page = await ctx.newPage();
await page.goto("https://venezuelatebusca.com/", {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForTimeout(3000);

const data = await page.evaluate(() => {
  const personish = (o) =>
    o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    ("nombre" in o ||
      "fullName" in o ||
      ("name" in o && "status" in o) ||
      ("status" in o && ("edad" in o || "age" in o)) ||
      "missingPlace" in o ||
      "lastSeenPlace" in o);
  const results = [];
  const seen = new Set();
  function walk(node, path, depth) {
    if (depth > 9 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && personish(node[0])) {
        results.push({
          path,
          len: node.length,
          keys: Object.keys(node[0]),
          sample: node[0],
        });
        return;
      }
      for (let i = 0; i < Math.min(node.length, 6); i++)
        walk(node[i], `${path}[${i}]`, depth + 1);
    } else {
      for (const k of Object.keys(node)) walk(node[k], `${path}.${k}`, depth + 1);
    }
  }
  const roots = {
    remix: window.__remixContext,
    rr: window.__reactRouterContext,
  };
  const present = Object.keys(roots).filter((k) => roots[k]);
  for (const [name, r] of Object.entries(roots)) if (r) walk(r, name, 0);
  return { present, results };
});

console.log("hydration roots:", data.present.join(", "));
for (const r of data.results) {
  console.log(`\n== array en ${r.path} (len ${r.len}) ==`);
  console.log("keys:", r.keys.join(", "));
  console.log("sample:", JSON.stringify(r.sample, null, 2));
}
if (data.results.length === 0)
  console.log("No se encontró array de personas en la hidratación.");

await browser.close();
