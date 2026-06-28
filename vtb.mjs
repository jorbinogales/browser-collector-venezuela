// Colector vtb (venezuelatebusca.com) con navegador real (Playwright).
// vtb es un SPA React Router cuyo loader server-side renderiza la lista pública;
// el navegador la deserializa en window.__reactRouterContext. Aquí sólo LEEMOS esos
// datos públicos (sin reCAPTCHA ni API key), paginando con ?page=N.
// Escribe `desaparecidos/vtb-items.json`; el cron principal lo fusiona en items.json.
import { chromium } from "playwright";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { writeRawSnapshot } from "./snapshot.mjs";

const SITE = "https://venezuelatebusca.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const int = (v, d) => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
};
const CFG = {
  maxPages: int(process.env.MAX_PAGES, 3000),
  startPage: int(process.env.START_PAGE, 1),
  stopKnown: int(process.env.STOP_AFTER_KNOWN_PAGES, 2),
  fullScan: process.env.FULL_SCAN === "1",
  delayMs: int(process.env.REQUEST_DELAY_MS, 500),
  navTimeout: int(process.env.NAV_TIMEOUT_MS, 60000),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const Bucket = process.env.BUCKET_NAME;
const s3 = new S3Client({
  region: process.env.BUCKET_REGION ?? "auto",
  endpoint: process.env.BUCKET_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
  },
});
const ITEMS_KEY = "desaparecidos/vtb-items.json";
const STATE_KEY = "desaparecidos/vtb-state.json";

async function readJson(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name === "NoSuchKey" || e.name === "NotFound") return null;
    throw e;
  }
}
async function writeJson(key, obj) {
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body: JSON.stringify(obj),
      ContentType: "application/json",
    }),
  );
}

const mapEstado = (s) => (s === "found" ? "encontrado" : "buscando");
const mapGenero = (g) =>
  g === "female" ? "Femenino" : g === "male" ? "Masculino" : g || null;

function mapVtb(p, now) {
  const nombre =
    [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || null;
  const estado = mapEstado(p.status);
  const detalles = {};
  if (p.idNumber) detalles.Cedula = String(p.idNumber);
  if (p.hospitalName) detalles.Hospital = String(p.hospitalName);
  if (p.hospitalStatus) detalles.EstadoHospital = String(p.hospitalStatus);
  if (p.reporter?.phone) detalles.ContactoReporta = String(p.reporter.phone);
  if (p.status) detalles.EstadoOriginal = String(p.status);
  if (p.createdAt) detalles.CreadoEnFuente = String(p.createdAt);
  let fotoUrl = null;
  if (p.photoUrl)
    fotoUrl = p.photoUrl.startsWith("http") ? p.photoUrl : SITE + p.photoUrl;
  return {
    id: `vtb:${p.id}`,
    origen: "vtb",
    url: `${SITE}/`,
    nombre,
    edad: typeof p.age === "number" ? p.age : null,
    ubicacion: p.lastSeen || null,
    estado,
    fotoUrl,
    genero: mapGenero(p.gender),
    ultimaVezVisto: p.description || null,
    publicadoRelativo: null,
    verificacion: null,
    detalles,
    firstSeenAt: now,
    lastSeenAt: now,
    enrichedAt: null,
    statusHistory: [{ estado, at: now }],
  };
}

async function readPage(page, pageNum) {
  await page.goto(`${SITE}/?page=${pageNum}`, {
    waitUntil: "domcontentloaded",
    timeout: CFG.navTimeout,
  });
  await page
    .waitForFunction(
      () => {
        const ld =
          window.__reactRouterContext?.state?.loaderData?.["routes/_index"];
        return ld && Array.isArray(ld.persons);
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  return await page.evaluate(() => {
    const ld =
      window.__reactRouterContext?.state?.loaderData?.["routes/_index"];
    if (!ld || !Array.isArray(ld.persons))
      return { persons: null, hasMore: false, total: null };
    return {
      persons: ld.persons,
      hasMore: !!ld.pagination?.hasMore,
      total: ld.totalCount ?? null,
    };
  });
}

async function main() {
  const startedAt = Date.now();
  const runAt = new Date().toISOString();
  const store = (await readJson(ITEMS_KEY)) || {};
  const firstRun = Object.keys(store).length === 0;
  const fullScan = CFG.fullScan || firstRun;
  console.log(
    `vtb collector · firstRun=${firstRun} · fullScan=${fullScan} · startPage=${CFG.startPage}`,
  );

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let nuevos = 0,
    cambios = 0,
    vistos = 0,
    pagesFetched = 0;
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: "es-VE" });
    const page = await ctx.newPage();
    let knownStreak = 0;
    for (let pageNum = CFG.startPage; pageNum <= CFG.maxPages; pageNum++) {
      let res;
      try {
        res = await readPage(page, pageNum);
      } catch (e) {
        console.warn(`  pág ${pageNum} error: ${e.message}`);
        await sleep(CFG.delayMs * 2);
        continue;
      }
      pagesFetched++;
      if (!res.persons || res.persons.length === 0) {
        console.log(`  fin en pág ${pageNum}`);
        break;
      }
      let pageChanged = false;
      for (const p of res.persons) {
        const id = `vtb:${p.id}`;
        const now = new Date().toISOString();
        const existing = store[id];
        if (!existing) {
          store[id] = mapVtb(p, now);
          nuevos++;
          pageChanged = true;
        } else {
          existing.lastSeenAt = now;
          const est = mapEstado(p.status);
          if (existing.estado !== est) {
            existing.estado = est;
            existing.statusHistory.push({ estado: est, at: now });
            cambios++;
            pageChanged = true;
          }
          if (!existing.fotoUrl && p.photoUrl)
            existing.fotoUrl = p.photoUrl.startsWith("http")
              ? p.photoUrl
              : SITE + p.photoUrl;
        }
        vistos++;
      }
      if (pageNum % 25 === 0)
        console.log(`  pág ${pageNum} · acumulado ${Object.keys(store).length}`);
      if (!res.hasMore) {
        console.log(`  hasMore=false en pág ${pageNum}`);
        break;
      }
      if (!fullScan && !pageChanged) {
        knownStreak++;
        if (knownStreak >= CFG.stopKnown) {
          console.log(`  stop-early en pág ${pageNum}`);
          break;
        }
      } else {
        knownStreak = 0;
      }
      await sleep(CFG.delayMs);
    }
  } finally {
    await browser.close();
  }

  await writeJson(ITEMS_KEY, store);
  const vtbItems = Object.values(store);
  if (vtbItems.length > 0) {
    try { await writeRawSnapshot(s3, Bucket, "venezuela te busca app", "desaparecidos", vtbItems); }
    catch (e) { console.warn("raw snapshot falló:", e.message); }
  }
  const state = {
    source: "vtb",
    runAt,
    durationMs: Date.now() - startedAt,
    total: Object.keys(store).length,
    nuevos,
    cambios,
    vistos,
    pagesFetched,
  };
  await writeJson(STATE_KEY, state);
  console.log("LISTO:", JSON.stringify(state));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FALLO:", e);
    process.exit(1);
  });
