// Snapshot DELTA escrito a TODOS los destinos (Railway/Tigris + AWS S3 si hay credenciales).
// Cada destino calcula su propio delta (firstSeenAt > su último snapshot), así un bucket
// nuevo arranca con baseline completo y luego deltas chicos.
// Nombre: <tipo>_<YYYY-MM-DD_HH-mm>_<cantidad>_jn.json
import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const INTERVAL_HOURS = Number(process.env.SNAPSHOT_INTERVAL_HOURS ?? "24");
const snapDate = (key) => {
  const m = key.match(/_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})_\d+(?:_jn)?\.json$/);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`) : null;
};

let awsClient = null;
function targets(railwayS3, railwayBucket) {
  const t = [
    { s3: railwayS3, bucket: railwayBucket, prefix: "terremoto-vzla/raw/", name: "railway" },
  ];
  if (
    process.env.AWS_S3_BUCKET &&
    process.env.AWS_S3_ACCESS_KEY_ID &&
    process.env.AWS_S3_SECRET_ACCESS_KEY
  ) {
    if (!awsClient) {
      awsClient = new S3Client({
        region: process.env.AWS_S3_REGION ?? "us-east-1",
        endpoint: process.env.AWS_S3_ENDPOINT,
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
        },
      });
    }
    t.push({ s3: awsClient, bucket: process.env.AWS_S3_BUCKET, prefix: "raw/", name: "aws" });
  }
  return t;
}

async function listAll(s3, Bucket, prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of r.Contents ?? [])
      if (o.Key && o.Key.endsWith(".json"))
        out.push({ key: o.Key, lastModified: o.LastModified?.getTime() ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// Corte exacto del delta: usa el `extraidoEn` (ms) guardado dentro del último
// snapshot, no el minuto del nombre, para no re-incluir el lote anterior (sin solape).
// Si no se puede leer, cae a la fecha del nombre o al lastModified.
async function exactCutoff(s3, Bucket, latest) {
  try {
    const o = await s3.send(new GetObjectCommand({ Bucket, Key: latest.key }));
    const meta = JSON.parse(await o.Body.transformToString());
    if (meta && typeof meta.extraidoEn === "string") {
      const t = Date.parse(meta.extraidoEn);
      if (Number.isFinite(t)) return t;
    }
  } catch {
    /* ilegible: fallback */
  }
  return snapDate(latest.key) ?? latest.lastModified;
}

async function writeToOne(t, fuente, tipo, items) {
  const prefix = `${t.prefix}${fuente}/${tipo}_`;
  let existing = [];
  try {
    existing = (await listAll(t.s3, t.bucket, prefix)).sort((a, b) => a.lastModified - b.lastModified);
  } catch {
    /* sin listado */
  }
  const latest = existing[existing.length - 1];
  const now = Date.now();
  const cutoff = latest ? await exactCutoff(t.s3, t.bucket, latest) : 0;
  if (latest) {
    const ageH = Math.max(0, now - cutoff) / 3_600_000;
    if (ageH < INTERVAL_HOURS) {
      console.log(`  raw[${t.name}] ${fuente}/${tipo}: omitido (intervalo ${ageH.toFixed(1)}h)`);
      return;
    }
  }
  const nuevos =
    cutoff === 0
      ? items
      : items.filter((it) => it && it.firstSeenAt && Date.parse(it.firstSeenAt) > cutoff);
  if (nuevos.length === 0) {
    console.log(`  raw[${t.name}] ${fuente}/${tipo}: omitido (sin nuevos)`);
    return;
  }
  const fecha = new Date(now).toISOString().slice(0, 16).replace("T", "_").replace(/:/g, "-");
  const key = `${prefix}${fecha}_${nuevos.length}_jn.json`;
  await t.s3.send(
    new PutObjectCommand({
      Bucket: t.bucket,
      Key: key,
      Body: JSON.stringify({
        fuente,
        tipo,
        extraidoEn: new Date(now).toISOString(),
        desde: cutoff ? new Date(cutoff).toISOString() : null,
        cantidad: nuevos.length,
        items: nuevos,
      }),
      ContentType: "application/json",
    }),
  );
  console.log(`  raw[${t.name}] ${fuente}/${tipo}: delta ${nuevos.length}`);
}

export async function writeRawSnapshot(railwayS3, railwayBucket, fuente, tipo, items) {
  for (const t of targets(railwayS3, railwayBucket)) {
    try {
      await writeToOne(t, fuente, tipo, items);
    } catch (e) {
      console.warn(`  ! raw[${t.name}] ${fuente}/${tipo} falló:`, e.message);
    }
  }
}
