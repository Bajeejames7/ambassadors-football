/**
 * Demo data for trying the app locally (never run against production):
 *   DATABASE_URL=… npx tsx scripts/seed-demo.ts
 * Fills an EMPTY database only. Password for every demo account: ambassadors1
 */
import { migrate } from "../server/migrations.js";
import { closePool } from "../server/db.js";
import { DEMO_ACCOUNTS, seedDemo, seedDemoExtras, seedDemoTerm } from "../server/demo.js";

await migrate();
console.log((await seedDemo()) ? "Demo data ready:" : "Database already has users; nothing seeded.", DEMO_ACCOUNTS.map((a) => a.email).join(", "));
await seedDemoExtras();
await seedDemoTerm();
await closePool();
