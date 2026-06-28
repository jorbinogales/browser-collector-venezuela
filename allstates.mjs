import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.BUCKET_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY,
  },
});
const get = async (k) => {
  try {
    const r = await s3.send(
      new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: k }),
    );
    return await r.Body.transformToString();
  } catch (e) {
    return `(${e.name})`;
  }
};
for (const k of [
  "desaparecidos/state.json",
  "desaparecidos/dtv-state.json",
  "desaparecidos/vtb-state.json",
]) {
  console.log(`\n== ${k} ==\n${await get(k)}`);
}
