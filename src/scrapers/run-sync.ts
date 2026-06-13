import { initSchema } from "../db/schema.js";
import { syncRbi } from "./rbi.js";
import { syncSebi } from "./sebi.js";
import { setSyncMeta } from "../db/queries.js";

async function main() {
  initSchema();
  const log = (m: string) => console.error(`[sync] ${m}`);

  const args = process.argv.slice(2);
  const quick = args.includes("--quick"); // quick mode: 6mo RBI + 5 pages SEBI

  if (quick) {
    log("Quick sync mode (6 months RBI, 5 pages SEBI each)...");
    const rbiCount = await syncRbi(6, log);
    log(`RBI: ${rbiCount} new documents`);
    const sebiCirc = await syncSebi(7, 5, log);
    log(`SEBI circulars: ${sebiCirc} new documents`);
  } else {
    log("Starting RBI sync (last 36 months)...");
    const rbiCount = await syncRbi(36, log);
    log(`RBI: ${rbiCount} new documents`);

    log("Starting SEBI sync...");
    const sebiMaster = await syncSebi(6, 5, log);
    const sebiCirc   = await syncSebi(7, 40, log);
    const sebiReg    = await syncSebi(3, 10, log);
    log(`SEBI: ${sebiMaster + sebiCirc + sebiReg} new documents`);
  }

  setSyncMeta("last_sync", new Date().toISOString());
  log("Sync complete.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
