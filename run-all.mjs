// Entrypoint del servicio de navegador: corre los colectores externos en secuencia
// (incremental por defecto). Cada uno escribe su propio *-items.json; el cron
// principal de venezuela-reporta-scraper los fusiona en la lista unificada.
import { spawn } from "node:child_process";

function run(file) {
  return new Promise((resolve) => {
    console.log(`\n=== ${file} (${new Date().toISOString()}) ===`);
    const c = spawn(process.execPath, [file], {
      env: process.env,
      stdio: "inherit",
    });
    c.on("exit", (code) => resolve(code ?? 1));
  });
}

const sources = (process.env.SOURCES || "index.mjs,vtb.mjs,redayuda.mjs")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let failures = 0;
for (const file of sources) {
  const code = await run(file);
  if (code !== 0) {
    failures++;
    console.error(`! ${file} salió con código ${code}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
