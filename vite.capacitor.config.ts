import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nasqoHybridIsolationPlugin } from "./vite.hybrid.config";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  base: "./",
  publicDir: false,
  define: {
    "import.meta.env.VITE_NASQO_HYBRID": JSON.stringify("1"),
    "import.meta.env.VITE_NASQO_CAPACITOR": JSON.stringify("1"),
    "process.env": "{}",
  },
  plugins: [
    {
      name: "capacitor-accounting-platform",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer && source === "./sqlitePlatform.ts" && importer.endsWith("/server/sqliteDb.ts")) {
          return path.join(root, "src/capacitor/sqlitePlatform.ts");
        }
        return null;
      },
    },
    nasqoHybridIsolationPlugin(), react(),
  ],
  build: {
    outDir: "dist/capacitor",
    target: "es2022",
    cssCodeSplit: false,
    rollupOptions: { input: path.join(root, "capacitor.html") },
  },
});
