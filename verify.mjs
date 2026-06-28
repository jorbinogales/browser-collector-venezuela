import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
const s3 = new S3Client({
  region: process.env.BUCKET_REGION ?? "auto",
  endpoint: process.env.BUCKET_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
  },
});
const r = await s3.send(
  new GetObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: "desaparecidos/dtv-items.json",
  }),
);
const data = JSON.parse(await r.Body.transformToString());
const vals = Object.values(data);
console.log("total:", vals.length);
console.log("ejemplo mapeado:", JSON.stringify(vals[0], null, 2));
const est = {};
for (const v of vals) est[v.estado] = (est[v.estado] || 0) + 1;
console.log("por estado:", JSON.stringify(est));
