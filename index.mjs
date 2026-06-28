// Colector dtv (desaparecidosterremotovenezuela.com) con navegador real (Playwright).
// El sitio protege su API con reCAPTCHA v3; aquí un navegador real carga la página
// pública y, usando el propio grecaptcha del sitio, mintea un token por request para
// paginar el API. Escribe los datos a `desaparecidos/dtv-items.json` en el MISMO bucket;
// el cron principal los fusiona en la lista unificada `desaparecidos/items.json`.
//
// La reCAPTCHA throttlea el minteo tras ~15 requests por carga de página, así que
// recargamos la página cada RELOAD_EVERY páginas (y al recibir un 403) para refrescar
// la sesión. En modo incremental (newest-first + stop-early) sólo se piden pocas páginas.
import { chromium } from "playwright";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { writeRawSnapshot } from "./snapshot.mjs";

const SITE = "https://desaparecidosterremotovenezuela.com/";
const API = "https://desaparecidos-terremoto-api.theempire.tech/api/personas";
const SITEKEY =
  process.env.DTV_SITEKEY || "6LeBfDUtAAAAAMw1Wtkd58bst6vEnLOi3_NAjGD0";
const PAGE_SIZE = 100;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const int = (v, d) => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
};
const CFG = {
  maxPages: int(process.env.MAX_PAGES, 1000),
  startPage: int(process.env.START_PAGE, 1),
  stopKnown: int(process.env.STOP_AFTER_KNOWN_PAGES, 2),
  fullScan: process.env.FULL_SCAN === "1",
  delayMs: int(process.env.REQUEST_DELAY_MS, 700),
  navTimeout: int(process.env.NAV_TIMEOUT_MS, 60000),
  reloadEvery: int(process.env.RELOAD_EVERY, 12),
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
const ITEMS_KEY = "desaparecidos/dtv-items.json";
const STATE_KEY = "desaparecidos/dtv-state.json";

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

const mapEstado = (e) => (e === "localizado" ? "encontrado" : "buscando");

// Mapea una persona de dtv al MISMO schema Report; campos sin valor -> null.
function mapDtv(p, now) {
  const estado = mapEstado(p.estado);
  const detalles = {};
  if (p.contacto) detalles.Contacto = String(p.contacto);
  if (p.fecha) detalles.Fecha = String(p.fecha);
  if (p.estado) detalles.EstadoOriginal = String(p.estado);
  if (p.createdAt) detalles.CreadoEnFuente = new Date(p.createdAt).toISOString();
  return {
    id: `dtv:${p.id}`,
    origen: "dtv",
    url: SITE,
    nombre: p.nombre ?? null,
    edad: typeof p.edad === "number" ? p.edad : null,
    ubicacion: p.ubicacion || null,
    estado,
    fotoUrl: p.foto || null,
    genero: null,
    ultimaVezVisto: p.descripcion || null,
    publicadoRelativo: null,
    verificacion: null,
    detalles,
    firstSeenAt: now,
    lastSeenAt: now,
    enrichedAt: null,
    statusHistory: [{ estado, at: now }],
  };
}

async function fetchPageInBrowser(page, pageNum) {
  return await page.evaluate(
    async ({ sitekey, api, pageNum, pageSize }) => {
      const token = await window.grecaptcha.execute(sitekey, { action: "list" });
      const r = await fetch(`${api}?page=${pageNum}&pageSize=${pageSize}`, {
        headers: { "x-recaptcha-token": token, accept: "application/json" },
      });
      const txt = await r.text();
      let items = null;
      try {
        items = JSON.parse(txt).items ?? null;
      } catch {
        /* no json */
      }
      return { status: r.status, items };
    },
    { sitekey: SITEKEY, api: API, pageNum, pageSize: PAGE_SIZE },
  );
}

async function loadAndReady(page) {
  await page.goto(SITE, { waitUntil: "networkidle", timeout: CFG.navTimeout });
  await page.waitForFunction(
    () => window.grecaptcha && window.grecaptcha.execute,
    { timeout: 20000 },
  );
}

async function main() {
  const startedAt = Date.now();
  const runAt = new Date().toISOString();
  const store = (await readJson(ITEMS_KEY)) || {};
  const firstRun = Object.keys(store).length === 0;
  const fullScan = CFG.fullScan || firstRun;
  console.log(
    `dtv collector · firstRun=${firstRun} · fullScan=${fullScan} · startPage=${CFG.startPage} · bucket=${Bucket}`,
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
    console.log("cargando sitio público...");
    await loadAndReady(page);

    let knownStreak = 0;
    let sinceReload = 0;
    let retried403 = 0;
    for (
      let pageNum = CFG.startPage;
      pageNum <= CFG.maxPages;
      /* incremento manual */
    ) {
      // refresco proactivo de la sesión reCAPTCHA
      if (sinceReload >= CFG.reloadEvery) {
        await loadAndReady(page);
        sinceReload = 0;
      }

      let res;
      try {
        res = await fetchPageInBrowser(page, pageNum);
      } catch (e) {
        console.warn(`  pág ${pageNum} error: ${e.message}`);
        await sleep(CFG.delayMs * 2);
        continue;
      }
      pagesFetched++;
      sinceReload++;

      // 403 = token throttled -> recargar y reintentar la MISMA página
      if (res.status === 403 || res.items === null) {
        if (retried403 < 4) {
          retried403++;
          console.log(`  ${res.status} en pág ${pageNum}; recargo sesión...`);
          await sleep(1000);
          await loadAndReady(page);
          sinceReload = 0;
          continue;
        }
        console.log(`  persistente ${res.status} en pág ${pageNum}; corto.`);
        break;
      }
      retried403 = 0;

      if (res.items.length === 0) {
        console.log(`  fin en pág ${pageNum} (lista vacía)`);
        break;
      }
      let pageChanged = false;
      for (const p of res.items) {
        const id = `dtv:${p.id}`;
        const now = new Date().toISOString();
        const existing = store[id];
        if (!existing) {
          store[id] = mapDtv(p, now);
          nuevos++;
          pageChanged = true;
        } else {
          existing.lastSeenAt = now;
          const est = mapEstado(p.estado);
          if (existing.estado !== est) {
            existing.estado = est;
            existing.statusHistory.push({ estado: est, at: now });
            cambios++;
            pageChanged = true;
          }
          if (!existing.fotoUrl && p.foto) existing.fotoUrl = p.foto;
          if (existing.edad == null && typeof p.edad === "number")
            existing.edad = p.edad;
        }
        vistos++;
      }
      if (pageNum % 25 === 0)
        console.log(`  pág ${pageNum} · acumulado ${Object.keys(store).length}`);

      if (!fullScan && !pageChanged) {
        knownStreak++;
        if (knownStreak >= CFG.stopKnown) {
          console.log(`  stop-early en pág ${pageNum}`);
          break;
        }
      } else {
        knownStreak = 0;
      }

      pageNum++;
      await sleep(CFG.delayMs);
    }
  } finally {
    await browser.close();
  }

  await writeJson(ITEMS_KEY, store);
  const dtvItems = Object.values(store);
  if (dtvItems.length > 0) {
    try { await writeRawSnapshot(s3, Bucket, "desaparecidos terremoto venezuela", "desaparecidos", dtvItems); }
    catch (e) { console.warn("raw snapshot falló:", e.message); }
  }
  const state = {
    source: "dtv",
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
