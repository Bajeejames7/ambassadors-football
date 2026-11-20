import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./migrations.js";
import { processAirtableOutbox } from "./lib/airtable.js";

const here = path.dirname(fileURLToPath(import.meta.url));

await migrate();
// dist/server/index.js in production; the built web app is in dist/web.
const app = createApp(path.resolve(here, "../web"));
app.listen(config.port, () => {
  console.log(`Ambassadors Football on :${config.port} (M-PESA: ${config.mpesa.mode})`);
});

// Walk-ins waiting to reach Airtable: try every minute.
setInterval(() => {
  processAirtableOutbox().catch((err) => console.error("[airtable outbox]", err));
}, 60_000);
