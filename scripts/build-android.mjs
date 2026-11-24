import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const android = path.join(root, "android");
if (!fs.existsSync(path.join(android, "gradlew"))) throw new Error("Run npx cap add android first.");
const local = path.join(android, "local.properties");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (sdk && !fs.existsSync(local)) fs.writeFileSync(local, `sdk.dir=${sdk.replace(/\\/g, "/")}\n`);
const result = spawnSync(process.platform === "win32" ? "gradlew.bat" : "./gradlew", ["assembleDebug", "--no-daemon"], { cwd: android, stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
