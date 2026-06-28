import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
for (const width of [320, 360, 390]) {
  const ctx = await browser.newContext({
    viewport: { width, height: 780 },
    geolocation: { latitude: 10.6, longitude: -66.9 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();
  await page.goto("https://zonasegura.up.railway.app/", { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const tablist = document.querySelector('[role="tablist"]');
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const last = tabs[tabs.length - 1];
    const lb = last ? last.getBoundingClientRect() : null;
    return {
      tabCount: tabs.length,
      tablistOverflowPx: tablist ? tablist.scrollWidth - tablist.clientWidth : null,
      bodyOverflowPx: document.documentElement.scrollWidth - window.innerWidth,
      lastTabRight: lb ? Math.round(lb.right) : null,
      viewport: window.innerWidth,
      labels: tabs.map((t) => t.innerText.replace(/\s+/g, " ").trim()),
    };
  });
  const ok = r.tablistOverflowPx <= 1 && r.bodyOverflowPx <= 1 && r.lastTabRight <= r.viewport + 1;
  console.log(`width ${width}: ${ok ? "OK ✓" : "OVERFLOW ✗"} ${JSON.stringify(r)}`);
  await ctx.close();
}
await browser.close();
