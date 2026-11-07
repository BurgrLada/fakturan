// Bundled by the Dockerfile into scripts/demo-seed.mjs: `node scripts/demo-seed.mjs` in the image
// seeds the demo account on the volume once, before the nightly reset takes over (OPS-007).
import { clock } from "../src/server/clock";
import { db, runMigrations } from "../src/server/db";
import { seedDemo } from "../src/server/demo/seed";
import { env } from "../src/server/env";

if (!env.DEMO_MODE) {
  console.error("Ukázku lze založit jen s DEMO_MODE=1");
  process.exit(1);
}
runMigrations(db);
const { invoices } = await seedDemo(clock.now());
console.log(`Ukázka je připravená, ${invoices} dokladů`);
db.$client.close();
