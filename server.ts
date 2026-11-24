import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { mountAiApi } from "./server/aiApi.ts";
import { mountSmartProApi } from "./server/smartpro.ts";
import { mountSqliteApi } from "./server/sqliteApi.ts";
import { closeSqliteDb } from "./server/sqliteDb.ts";

function resolvePort(): number {
  const portFlagIndex = process.argv.indexOf("--port");
  if (portFlagIndex !== -1 && process.argv[portFlagIndex + 1]) {
    const parsed = Number(process.argv[portFlagIndex + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const envPort = Number(process.env.PORT || 3000);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}

const PORT = resolvePort();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";

async function createApp() {
  const app = express();

  // Defense in depth: even if a private backup is accidentally included in
  // static assets, never serve it over HTTP (including unauthenticated paths).
  app.use((req: Request, res: Response, next: NextFunction) => {
    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(req.path);
    } catch {
      res.sendStatus(400);
      return;
    }
    if (/\.(?:back|db|sqlite|sqlite3|dump|sql)(?:\.gz)?$/i.test(requestedPath)) {
      res.status(404).end();
      return;
    }
    next();
  });

  // Single unified SQLite database API (has its own scoped JSON limit for imports).
  mountSqliteApi(app);

  // Protected Vertex AI / Gemini ERP endpoints (scoped 8mb limit for multimodal invoice scans).
  mountAiApi(app);

  app.use(express.json({ limit: "64kb" }));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "nasqo-pro-api" });
  });

  // Strictly allowlisted read-only download endpoints for the verified Batch 2 Flutter handoff archive.
  const HANDOFF_ZIP_PATH = path.resolve(__dirname, "deliverables", "nasqo-react-hybrid-batch2-handoff.zip");
  const HANDOFF_SHA_PATH = path.resolve(__dirname, "deliverables", "nasqo-react-hybrid-batch2-handoff.zip.sha256");

  app.get("/api/deliverables/nasqo-react-hybrid-batch2-handoff.zip", (_req: Request, res: Response) => {
    if (!fs.existsSync(HANDOFF_ZIP_PATH)) {
      res.status(404).json({ error: "حزمة التسليم غير موجودة حاليًا." });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="nasqo-react-hybrid-batch2-handoff.zip"');
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(HANDOFF_ZIP_PATH);
  });

  app.get("/api/deliverables/nasqo-react-hybrid-batch2-handoff.zip.sha256", (_req: Request, res: Response) => {
    if (!fs.existsSync(HANDOFF_SHA_PATH)) {
      res.status(404).json({ error: "ملف بصمة التحقق غير موجود حاليًا." });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="nasqo-react-hybrid-batch2-handoff.zip.sha256"');
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(HANDOFF_SHA_PATH);
  });

  // Strictly allowlisted read-only download endpoints for the corrected Flutter 0d734ca integration review package.
  const FLUTTER_REVIEW_ZIP_PATH = path.resolve(
    __dirname,
    "deliverables",
    "nasqo-flutter-hybrid-integration-0d734ca-review.zip",
  );
  const FLUTTER_REVIEW_SHA_PATH = path.resolve(
    __dirname,
    "deliverables",
    "nasqo-flutter-hybrid-integration-0d734ca-review.zip.sha256",
  );
  const FLUTTER_REVIEW_PATCH_PATH = path.resolve(
    __dirname,
    "review",
    "flutter_hybrid_integration_0d734ca",
    "patches",
    "0001-flutter-hybrid-compat-integration.patch",
  );

  app.get("/api/deliverables/nasqo-flutter-hybrid-integration-0d734ca-review.zip", (_req: Request, res: Response) => {
    if (!fs.existsSync(FLUTTER_REVIEW_ZIP_PATH)) {
      res.status(404).json({ error: "أرشيف مراجعة تكامل Flutter غير موجود حاليًا." });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="nasqo-flutter-hybrid-integration-0d734ca-review.zip"',
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(FLUTTER_REVIEW_ZIP_PATH);
  });

  app.get("/api/deliverables/nasqo-flutter-hybrid-integration-0d734ca-review.zip.sha256", (_req: Request, res: Response) => {
    if (!fs.existsSync(FLUTTER_REVIEW_SHA_PATH)) {
      res.status(404).json({ error: "ملف SHA-256 لأرشيف المراجعة غير موجود حاليًا." });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="nasqo-flutter-hybrid-integration-0d734ca-review.zip.sha256"',
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(FLUTTER_REVIEW_SHA_PATH);
  });

  app.get("/api/deliverables/0001-flutter-hybrid-compat-integration.patch", (_req: Request, res: Response) => {
    if (!fs.existsSync(FLUTTER_REVIEW_PATCH_PATH)) {
      res.status(404).json({ error: "ملف الـ Patch غير موجود حاليًا." });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="0001-flutter-hybrid-compat-integration.patch"',
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(FLUTTER_REVIEW_PATCH_PATH);
  });

  // Protected, role-based SmartPro database API; all changes are audited.
  mountSmartProApi(app);

  const httpServer = http.createServer(app);

  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, "vite.dev.config.ts"),
      server: { middlewareMode: true, hmr: false, ws: { server: httpServer } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.resolve(__dirname, "dist/client");
    app.use(express.static(clientDir));
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`NASQO Pro server listening on http://0.0.0.0:${PORT}`);
  });

  httpServer.on("error", (err) => {
    console.error("Server error:", err);
  });

  const shutdown = () => {
    closeSqliteDb();
    httpServer.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void createApp();
