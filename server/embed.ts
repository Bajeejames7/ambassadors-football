import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { configure, type Settings } from "./config.js";
import { getPool } from "./db.js";
import { migrate } from "./migrations.js";
import { seedDemo, seedDemoExtras, seedDemoTerm } from "./demo.js";
import { processAirtableOutbox } from "./lib/airtable.js";

/**
 * Run Ambassadors Football inside another Express server (the Rafiki Games one
 * on Render), so no separate service is needed:
 *
 *   const { createAmbassadors } = await import(".../ambassadors/server.mjs");
 *   app.use("/ambassadors", await createAmbassadors({ databaseUrl, dbSchema: "ambassadors_football", … }));
 *
 * Nothing here reads the host's environment: the host passes the settings.
 * With dbSchema set, every table lives in that Postgres schema, so it can
 * share a database with another app without touching that app's tables.
 * The web app next to this file was built for the /ambassadors/ path.
 */
export async function createAmbassadors(settings: Partial<Omit<Settings, "mpesa">> & { databaseUrl: string; mpesa?: Partial<Settings["mpesa"]> }) {
  if (!settings.databaseUrl) throw new Error("ambassadors: databaseUrl is required");
  configure(settings);
  await migrate();
  if (settings.demo) {
    await seedDemo();
    await seedDemoExtras();
    await seedDemoTerm();
  }
  // Keep the database awake between visits (free tiers sleep), and send walk-ins to Airtable.
  setInterval(() => {
    getPool().query("SELECT 1").catch(() => {});
  }, 10 * 60 * 1000).unref();
  setInterval(() => {
    processAirtableOutbox().catch((err) => console.error("[ambassadors airtable]", err));
  }, 60_000).unref();
  const here = path.dirname(fileURLToPath(import.meta.url));
  return createApp(path.join(here, "web"));
}
