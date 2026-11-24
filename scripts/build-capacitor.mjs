import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(path.join(root, "node_modules/.bin/vite"), ["build", "--config", "vite.capacitor.config.ts"], { cwd: root, stdio: "inherit" });
const output = path.join(root, "dist/capacitor");
fs.renameSync(path.join(output, "capacitor.html"), path.join(output, "index.html"));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const forbidden = /fonts\.googleapis\.com|firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|\/api\/db\/workspace\/|mockFlutter|installMockFlutterHost|__nasqoMockBridgeLog/;
for (const file of walk(output).filter(file => /\.(?:js|html|css)$/.test(file))) {
  if (forbidden.test(fs.readFileSync(file, "utf8"))) throw new Error(`Unexpected remote service or test host in ${file}`);
}
console.log("[capacitor-build] SUCCESS: dist/capacitor/index.html; SQLite and fonts bundled locally.");
