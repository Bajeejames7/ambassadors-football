// Builds Ambassadors Football to run inside another Express server at
// /ambassadors/ (see server/embed.ts), the way interschool runs at /interschool/.
//
//   node scripts/build-embed.mjs [target folder]
//
// Output (dist-embed/): server.mjs (the API with its dependencies bundled in,
// no install needed), web/ (the app built for /ambassadors/) and data/
// (pdfkit's support files). With a target folder, the result is copied there
// too, e.g. into Rafiki_games/artifacts/api-server/ambassadors.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = "/ambassadors/";
const out = path.resolve("dist-embed");
rmSync(out, { recursive: true, force: true });

execSync(`npx vite build --base ${BASE} --outDir "${path.join(out, "web")}" --emptyOutDir`, { stdio: "inherit" });

await build({
  entryPoints: ["server/embed.ts"],
  outfile: path.join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["pg-native"],
  // Bundled CommonJS packages (express) still call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

// pdfkit looks for its data folder next to the code (new URL('./data/…', import.meta.url)).
cpSync(path.resolve("node_modules/pdfkit/js/data"), path.join(out, "data"), { recursive: true });
cpSync(path.resolve("node_modules/pdfkit/js/standard-fonts"), path.join(out, "standard-fonts"), { recursive: true });
// …and unicode-properties (used by pdfkit's fonts) reads ./data.trie the same way.
cpSync(path.resolve("node_modules/unicode-properties/data.trie"), path.join(out, "data.trie"));

writeFileSync(
  path.join(out, "README.md"),
  "Built from the ambassadors-football project by `node scripts/build-embed.mjs`. Do not edit by hand: change that project and rebuild.\n",
);

const target = process.argv[2];
if (target) {
  rmSync(target, { recursive: true, force: true });
  cpSync(out, target, { recursive: true });
  console.log(`Copied to ${target}`);
}
