// Colector redayudavenezuela.com — "pacientes hospitalizados".
//
// Lee por el endpoint PÚBLICO de la web: `POST /api/data` con
//   {op:"reports_list", kinds:["hospital"], limit:1000}
// Es la misma interfaz que usa el propio sitio. Devuelve los ~1000 registros más
// recientes (orden created_at desc) y el servidor ignora cualquier limit>1000. No
// accedemos a la tabla de Supabase por detrás: el delta por firstSeenAt basta, porque
// los reportes nuevos entran arriba de esa ventana de 1000.
//
// Escribe baseline + deltas replicando venezuela-reporta-scraper/src/store.ts:
//   - Railway/Tigris (BUCKET_*)  → prefijo  terremoto-vzla/raw/redayudavenezuela/
//   - AWS S3 (AWS_S3_*)          → prefijo  raw/redayudavenezuela/
// Cada destino calcula su propio delta (baseline completo si está vacío). El store de
// control (firstSeenAt) vive en el bucket Railway: redayudavenezuela/hospitalizados-items.json
//
// Flags: DRY_RUN=1 (no escribe) · FORCE=1 (ignora el intervalo) · SNAPSHOT_INTERVAL_HOURS
//        REDAYUDA_API (override del endpoint público)
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const DRY = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE === "1";
const SNAPSHOT_INTERVAL_HOURS = Number(process.env.SNAPSHOT_INTERVAL_HOURS ?? "24");

const API_URL = process.env.REDAYUDA_API || "https://redayudavenezuela.com/api/data";
const LIMIT = 1000; // tope del endpoint público: el servidor clampa cualquier limit mayor

const FUENTE = "redayudavenezuela";
const TIPO = "hospitalizados";
const STORE_KEY = `${FUENTE}/hospitalizados-items.json`;

// Destinos de snapshot (igual que store.ts: Railway + AWS S3 si hay credenciales).
function makeTargets() {
  const t = [];
  if (process.env.BUCKET_NAME) t.push({
    name: "railway", bucket: process.env.BUCKET_NAME, prefix: "terremoto-vzla/raw/",
    s3: new S3Client({ region: process.env.BUCKET_REGION ?? "auto", endpoint: process.env.BUCKET_ENDPOINT, forcePathStyle: true,
      credentials: { accessKeyId: process.env.BUCKET_ACCESS_KEY_ID, secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY } }),
  });
  if (process.env.AWS_S3_BUCKET) t.push({
    name: "aws", bucket: process.env.AWS_S3_BUCKET, prefix: "raw/",
    s3: new S3Client({ region: process.env.AWS_S3_REGION ?? "us-east-1", endpoint: process.env.AWS_S3_ENDPOINT || undefined,
      credentials: { accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY } }),
  });
  return t;
}

async function readJson(s3, bucket, key) {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return JSON.parse(await r.Body.transformToString()); }
  catch (e) { if (e.name === "NoSuchKey" || e.name === "NotFound") return null; throw e; }
}
async function writeJson(s3, bucket, key, obj) {
  if (DRY) { console.log(`[DRY] PUT ${bucket}/${key}  (${JSON.stringify(obj).length} bytes)`); return; }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(obj), ContentType: "application/json" }));
}
async function list(s3, bucket, prefix) {
  const out = []; let t;
  do { const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: t }));
    (r.Contents || []).forEach(o => o.Key && out.push({ key: o.Key, lastModified: o.LastModified?.getTime() ?? 0 }));
    t = r.IsTruncated ? r.NextContinuationToken : undefined; } while (t);
  return out;
}

// Lee los hospitalizados por el endpoint público `POST /api/data` (op reports_list),
// la misma interfaz que usa la web. Devuelve los ~1000 más recientes (created_at desc);
// el servidor ignora limit>1000. El delta por firstSeenAt captura los nuevos.
async function fetchHospital() {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "reports_list", kinds: ["hospital"], limit: LIMIT }),
  });
  if (!r.ok) throw new Error(`api/data ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!j?.ok || !Array.isArray(j.data)) {
    throw new Error(`api/data respuesta inválida: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.data;
}

const snapDate = (key) => { const m = key.match(/_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})_\d+(?:_jn)?\.json$/); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) : null; };
async function cutoffFrom(s3, bucket, latest) {
  try { const j = await readJson(s3, bucket, latest.key); if (j && typeof j.extraidoEn === "string") { const t = Date.parse(j.extraidoEn); if (Number.isFinite(t)) return t; } } catch {}
  return snapDate(latest.key) ?? latest.lastModified;
}

// Escribe el baseline/delta a UN destino (cada bucket mantiene su propio baseline + deltas).
async function writeToTarget(target, items, now, nowIso) {
  const dir = `${target.prefix}${FUENTE}/`;
  const existing = (await list(target.s3, target.bucket, dir)).filter(o => /_jn\.json$/.test(o.key)).sort((a, b) => a.lastModified - b.lastModified);
  const latest = existing[existing.length - 1];
  const cutoff = latest ? await cutoffFrom(target.s3, target.bucket, latest) : 0;
  if (latest && !FORCE) {
    const ageH = Math.max(0, now - cutoff) / 3_600_000;
    if (ageH < SNAPSHOT_INTERVAL_HOURS) { console.log(`[redayuda][${target.name}] omitido: intervalo ${ageH.toFixed(1)}h < ${SNAPSHOT_INTERVAL_HOURS}h`); return; }
  }
  const deltaItems = cutoff === 0 ? items : items.filter(it => Date.parse(it.firstSeenAt) > cutoff);
  if (deltaItems.length === 0) { console.log(`[redayuda][${target.name}] sin nuevos → no se escribe`); return; }
  const fecha = new Date(now).toISOString().slice(0, 16).replace("T", "_").replace(/:/g, "-");
  const key = `${dir}${TIPO}_${fecha}_${deltaItems.length}_jn.json`;
  await writeJson(target.s3, target.bucket, key, { fuente: FUENTE, tipo: TIPO, extraidoEn: nowIso, desde: cutoff ? new Date(cutoff).toISOString() : null, cantidad: deltaItems.length, items: deltaItems });
  console.log(`[redayuda][${target.name}] ${cutoff === 0 ? "BASELINE" : "DELTA"} → ${target.bucket}/${key} · ${deltaItems.length} items`);
}

async function main() {
  const targets = makeTargets();
  if (!targets.length) return console.warn("[redayuda] sin BUCKET_NAME ni AWS_S3_BUCKET → omito");
  const primary = targets.find(t => t.name === "railway") || targets[0]; // store vive en el primario
  const now = Date.now(); const nowIso = new Date(now).toISOString();

  const records = await fetchHospital();
  const byId = new Map();
  for (const r of records) if (r && r.id && !byId.has(r.id)) byId.set(r.id, r);
  console.log(`[redayuda] hospital fetched: ${records.length} · distintos: ${byId.size} · destinos: ${targets.map(t => t.name).join("+")}`);

  const store = (await readJson(primary.s3, primary.bucket, STORE_KEY)) || {};
  let nuevos = 0; const items = [];
  for (const [id, r] of byId) {
    const ex = store[id];
    const item = { ...r, origen: FUENTE, firstSeenAt: ex?.firstSeenAt || nowIso, lastSeenAt: nowIso };
    if (!ex) nuevos++;
    store[id] = item; items.push(item);
  }
  console.log(`[redayuda] store total: ${Object.keys(store).length} · nuevos: ${nuevos}`);
  await writeJson(primary.s3, primary.bucket, STORE_KEY, store);

  for (const target of targets) {
    try { await writeToTarget(target, items, now, nowIso); }
    catch (e) { console.warn(`[redayuda][${target.name}] falló: ${e.message}`); }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error("[redayuda] FALLO:", e); process.exit(1); });
