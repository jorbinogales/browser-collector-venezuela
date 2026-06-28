// Colector redayudavenezuela.com — "pacientes hospitalizados".
//
// La app expone su data vía `POST /api/data`, pero ese endpoint está topado en 1000
// registros (ignora offset/page/status). El backend es Supabase y la **clave anon**
// viene embebida en el JS del sitio (role:anon, exp 2036). PostgREST sí permite
// paginar con order+limit+offset, así que vamos DIRECTO a la REST de Supabase y
// recorremos toda la tabla `reports` (kind=hospital) en páginas de 1000.
//
// Escribe baseline + deltas replicando venezuela-reporta-scraper/src/store.ts:
//   - Railway/Tigris (BUCKET_*)  → prefijo  terremoto-vzla/raw/redayudavenezuela/
//   - AWS S3 (AWS_S3_*)          → prefijo  raw/redayudavenezuela/
// Cada destino calcula su propio delta (baseline completo si está vacío). El store de
// control (firstSeenAt) vive en el bucket Railway: redayudavenezuela/hospitalizados-items.json
//
// Flags: DRY_RUN=1 (no escribe) · FORCE=1 (ignora el intervalo) · SNAPSHOT_INTERVAL_HOURS
//        REDAYUDA_SUPABASE_ANON (override de la clave anon si la rotan)
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const DRY = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE === "1";
const SNAPSHOT_INTERVAL_HOURS = Number(process.env.SNAPSHOT_INTERVAL_HOURS ?? "24");

const SB_URL = "https://cpavwkdonvkvrwygfzfo.supabase.co";
const SB_ANON = process.env.REDAYUDA_SUPABASE_ANON ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwYXZ3a2RvbnZrdnJ3eWdmemZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNjAyODMsImV4cCI6MjA5NzkzNjI4M30.-_FAsA2csTrB9qt267pBfjJkczMP7pcaUi4plMv3kv4";

const FUENTE = "redayudavenezuela";
const TIPO = "hospitalizados";
const STORE_KEY = `${FUENTE}/hospitalizados-items.json`;
const PAGE = 1000;

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

// Recorre reports?kind=hospital paginando por offset (order estable created_at+id).
async function fetchHospital() {
  const headers = { apikey: SB_ANON, authorization: "Bearer " + SB_ANON };
  const all = [];
  for (let offset = 0; offset < 200000; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/reports?select=*&kind=eq.hospital&order=created_at.asc,id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return all;
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
