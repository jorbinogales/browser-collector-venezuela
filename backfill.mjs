// Orquestador del backfill por tandas (gentle crawl) para dtv.
// dtv protege su API con reCAPTCHA y throttlea tras ~15 páginas por sesión.
// Aquí lanzamos el colector en tandas pequeñas (CHUNK páginas), cada una en un
// proceso/navegador fresco, con pausas de cooldown para no exceder sus límites.
// El colector escribe su progreso a dtv-items.json en cada tanda (reanudable).
//
// Uso:  node backfill.mjs   (con las variables BUCKET_* en el entorno)
import { spawn } from "node:child_process";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const CHUNK = Number.parseInt(process.env.CHUNK || "10", 10);
const COOLDOWN_MS = Number.parseInt(process.env.COOLDOWN_MS || "90000", 10);
const MAX_PAGE = Number.parseInt(process.env.BACKFILL_MAX_PAGE || "750", 10);
const START = Number.parseInt(process.env.START_PAGE || "1", 10);
const STAGNANT_STOP = Number.parseInt(process.env.STAGNANT_STOP || "6", 10);
const ENTRY = process.env.ENTRY || "index.mjs"; // index.mjs (dtv) | vtb.mjs
const STATE_KEY = process.env.STATE_KEY || "desaparecidos/dtv-state.json";

const s3 = new S3Client({
  region: process.env.BUCKET_REGION ?? "auto",
  endpoint: process.env.BUCKET_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
  },
});
async function totalNow() {
  try {
    const r = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: STATE_KEY,
      }),
    );
    return JSON.parse(await r.Body.transformToString()).total ?? 0;
  } catch {
    return 0;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runChunk(start, end) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        FULL_SCAN: "1",
        START_PAGE: String(start),
        MAX_PAGES: String(end),
        RELOAD_EVERY: "99",
        REQUEST_DELAY_MS: process.env.REQUEST_DELAY_MS || "800",
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code));
  });
}

let prev = await totalNow();
let stagnant = 0;
console.log(`Backfill por tandas. total inicial=${prev}, CHUNK=${CHUNK}, cooldown=${COOLDOWN_MS / 1000}s`);
for (let start = START; start <= MAX_PAGE; start += CHUNK) {
  const end = Math.min(start + CHUNK - 1, MAX_PAGE);
  console.log(`\n=== TANDA páginas ${start}-${end} (total ${prev}) ===`);
  await runChunk(start, end);
  const now = await totalNow();
  const delta = now - prev;
  console.log(`  total ahora ${now} (+${delta})`);
  if (delta <= 0) {
    stagnant++;
    if (stagnant >= STAGNANT_STOP) {
      console.log(`sin crecimiento en ${STAGNANT_STOP} tandas; fin.`);
      break;
    }
  } else {
    stagnant = 0;
  }
  prev = now;
  if (end < MAX_PAGE) await sleep(COOLDOWN_MS);
}
console.log("\nBACKFILL TERMINADO. total final:", await totalNow());
